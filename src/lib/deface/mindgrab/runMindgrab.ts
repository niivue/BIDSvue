// Orchestrate a mindgrab deface run (M11 Phase C).
//
// One `runMindgrab` call:
//
//   1. Reads the target NIfTI bytes via `MutateFs.readFile`.
//   2. Picks the actual input — pristine `<root>/sourcedata/` mirror if it
//      exists (so re-defacing with a different tool / dilation starts from
//      source, not from already-defaced bytes); target file otherwise.
//      Ownership check identical to allineate's path.
//   3. Parses the source bytes into a `NiftiVolume` and conforms to 256³
//      1 mm via the vendored FreeSurfer-style `conform()` transform.
//   4. Acquires a WebGPU device via the executor; loads the mindgrab model
//      weights; runs inference on the normalized + transposed input.
//   5. Inverse-transposes the model output (model order → NIfTI order) and
//      resamples it back to the native grid via nearest-neighbor
//      (`inverseConformMask`).
//   6. If `dilationMm > 0`, dilates the native-grid mask by running a
//      `-binv -edt -thr N -binv` pipeline on the bundled NATIVE niimath
//      binary via the executor (no WASM niimath in the app).
//   7. Applies the dilated mask to the native image data (voxel-wise
//      multiply; non-brain voxels become 0). Type-aware so the dtype +
//      scl_slope/scl_inter round-trip unchanged.
//   8. Serialises the masked image back to NIfTI bytes (header preserved
//      verbatim; only the image payload changes) and re-gzips if the
//      source was `.nii.gz`.
//   9. Wraps every disk-mutating step in one `OperationContext` — same
//      shape as `runDeface.ts`'s sidecar branch — so M6 undo + M9
//      destructive-undo confirm work unchanged.
//
// Tested pieces live in sibling modules:
//   - `_vendor/model.test.ts`        — transpose round-trip
//   - `_vendor/conform.ts`           — pure data-in / data-out
//   - `nifti.test.ts`                — NIfTI bytes round-trip
//   - `inverseConform.test.ts`       — mask resample
//   - `applyMaskToImage.test.ts`     — voxel-wise multiply, type-preserving
//
// The orchestrator itself is integration glue — manual smoke through
// `bun tauri dev`. Per the M11 plan, headless WebGPU + the native
// niimath sidecar are not feasible to wire under `bun:test`.

import { computeConform } from './_vendor/conform'
import {
  MINDGRAB_DIM,
  MINDGRAB_VOXEL_COUNT,
  type MindgrabInferer,
  transposeFromModelAsLabels,
  transposeToModel,
} from './_vendor/model'
import { applyMaskToImage } from './applyMaskToImage'
import { inverseConformMask } from './inverseConform'
import {
  buildConformInput,
  nibType,
  readNiftiBytes,
  writeNiftiBytes,
} from './nifti'
import { robustFovCrop } from './robustfov'

import { type PartialReadFs, ensureNotFourD } from '../headerProbe'
import { fileBytesEqual, readAndApplySidecar } from '../runDeface'
import { jsonSidecarPath, sourcedataMirrorPath } from '../sourcedataPath'
import type { DefaceToolId } from '../tools'

import { type MutateFs, beginOperation } from '$lib/mutate/backup'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { basename, dirname } from '$lib/util/paths'

/**
 * Injectable execution surface. Production passes a Tauri-backed
 * implementation; tests pass a stub.
 *
 * The brain-mask inference runs in-process on the GPU (WebGPU device +
 * weights bytes). The optional mask dilation does shell out — `runNiimathDilate`
 * invokes the bundled NATIVE niimath sidecar via the `niimath_dilate` Rust
 * command (there is no WASM niimath in the app). The device, the weights
 * reader, and that one dilation call are the entire surface.
 */
export interface MindgrabExecutor {
  /**
   * Acquire a WebGPU device with `shader-f16` + ~1.4 GB max storage
   * buffer. Resolves to `null` if the browser/GPU/WebView can't satisfy
   * the requirements — caller surfaces a friendly error in that case.
   */
  acquireDevice(): Promise<GPUDevice | null>
  /**
   * Read the bundled weights bytes for `relPath` (a tool descriptor's
   * `weightsResource`, e.g. `'common/mindgrab/net_mindgrab.safetensors'`).
   * Production uses `resolveResource(relPath)` + `plugin-fs::readFile`.
   * We return the bytes directly rather than a URL so we don't have to
   * widen the asset-protocol `fs:scope` to cover the app bundle's
   * resource dir.
   */
  resolveWeights(relPath: string): Promise<Uint8Array>
  /**
   * Load the model + return an inferer scoped to one `runMindgrab`
   * call. Caller MUST `await inferer.dispose()` in finally so GPU
   * buffers tracked during load get released before the device is
   * destroyed.
   */
  loadModel(device: GPUDevice, weights: Uint8Array): Promise<MindgrabInferer>
  /**
   * Dilate a native-grid brain mask by `dilationMm` via the bundled
   * **native** niimath binary (NOT WASM — the executable handles larger
   * files and is faster). Takes the mask as gzipped NIfTI bytes and
   * returns the dilated mask as gzipped NIfTI bytes.
   *
   * The Tauri implementation writes the mask to a temp file under
   * `$APPCACHE`, invokes the `niimath_dilate` tool through
   * `run_deface_process` (fixed argv `<in> -binv -edt -thr N -binv <out>`),
   * reads the result back, and cleans up. Each call spawns its own
   * process against its own temp dir, so concurrent deface runs don't
   * interfere — no shared-worker serialization needed (the WASM-era
   * `onmessage`-stealing hazard is gone with the WASM worker).
   */
  runNiimathDilate(
    maskNiftiGz: Uint8Array,
    dilationMm: number,
  ): Promise<Uint8Array>
}

export interface RunMindgrabOptions {
  datasetRoot: string
  statePaths: DatasetStatePaths
  /** Absolute path of the BIDS file being defaced. */
  targetPath: string
  /** Tool id — `'mindgrab'`, `'mindgrab8'`, or `'mindgrab8robust'`. */
  toolId: Extract<DefaceToolId, 'mindgrab' | 'mindgrab8' | 'mindgrab8robust'>
  /**
   * Native-space mask dilation in mm. 0 for `mindgrab` (no dilation),
   * 8 for `mindgrab8`. Pulled out of the tool descriptor by the caller.
   */
  dilationMm: number
  /**
   * When true (`mindgrab8robust`), crop the source with niimath
   * `-robustfov` BEFORE conform/inference so excess neck doesn't throw
   * off the model. The cropped copy becomes the single working volume
   * for the whole pipeline (conform, infer, inverse-conform, apply);
   * the pristine source is still what lands in the sourcedata mirror.
   */
  robustfov?: boolean
  /**
   * Bundle-relative path of the model weights blob (the tool
   * descriptor's `weightsResource`). Threaded through to
   * `executor.resolveWeights()` so the descriptor is the single
   * source of truth — audit M4 / refactor #1 (was previously
   * hardcoded inside `tauriMindgrabExecutor`).
   */
  weightsResource: string
  executor: MindgrabExecutor
  fs: MutateFs
  /**
   * Pre-commit freshness check — see `runDeface.ts::RunDefaceOptions.assertFresh`.
   * Especially important for mindgrab because the WebGPU inference
   * window is 5–30 s; long enough for an external editor or upstream
   * pipeline to mutate the target between source-read and commit.
   */
  assertFresh?: () => Promise<void>
  /**
   * Optional partial-read filesystem hook for the 4D NIfTI guard
   * (Day-1 Goal 1.3). When provided, `runMindgrab` probes the
   * target's 352-byte header BEFORE reading the full payload or
   * acquiring a WebGPU device, so a 4D BOLD fails fast instead of
   * paying the source-bytes read + inference cost. Production wires
   * `tauriPostPassFs`. Tests omit the hook (the existing post-parse
   * dims check remains as a safety net).
   */
  partialReadFs?: PartialReadFs
}

export interface RunMindgrabResult {
  operationId: string
  /** Absolute path of the sourcedata mirror that now (or already) holds pristine source. */
  sourcedataPath: string
}

/**
 * Run mindgrab against `targetPath` and commit the result through an
 * `OperationContext`. Mirrors `runDeface.ts`'s commit shape — sourcedata
 * mirror, atomic target overwrite, sidecar deid entry — so M6 undo and
 * M9 destructive-undo confirm Just Work.
 */
export async function runMindgrab(
  opts: RunMindgrabOptions,
): Promise<RunMindgrabResult> {
  const {
    datasetRoot,
    statePaths,
    targetPath,
    toolId,
    dilationMm,
    weightsResource,
    executor,
    fs,
  } = opts

  const sourcedataPath = sourcedataMirrorPath(datasetRoot, targetPath)
  if (sourcedataPath === null) {
    throw new Error(
      `runMindgrab: targetPath "${targetPath}" is not a sourcedata-mirrorable path under "${datasetRoot}"`,
    )
  }
  // Day-1 Goal 1.3: header-only 4D guard, BEFORE the full-payload
  // read on line ~218 and the WebGPU device acquire on line ~252.
  // Co-located here (vs only at the action layer) so direct callers of
  // `runMindgrab` can't bypass the policy. The existing post-parse
  // dims check below this block remains as a defense-in-depth backstop
  // for callers that omit `partialReadFs`.
  if (opts.partialReadFs !== undefined) {
    await ensureNotFourD(targetPath, opts.partialReadFs)
  }
  const sidecarPath = jsonSidecarPath(targetPath)

  // Pristine-source selection identical to allineate's path. The
  // sourcedata mirror is the source of truth on a re-deface so the
  // user can switch between mindgrab / mindgrab8 / allineate without
  // re-extracting from already-defaced bytes.
  const sourcedataExists = await fs.exists(sourcedataPath)
  if (sourcedataExists) {
    // Ownership check (audit H2). Same as allineate's path: if the
    // target is still 'original' (no BIDSvue deid entry on the sidecar),
    // require the existing sourcedata to be byte-identical to the
    // target. A mismatch means a user-staged sourcedata file we don't
    // own — refuse rather than treat it as our pristine source.
    const { detectTargetState } = await import('../runDeface')
    const currentState = await detectTargetState(targetPath, fs)
    if (currentState === 'original') {
      if (!(await fileBytesEqual(fs, sourcedataPath, targetPath))) {
        throw new Error(
          `runMindgrab: refusing to deface — an existing file at "${sourcedataPath}" doesn't match the current target bytes, so BIDSvue can't safely treat it as the pristine source. Move or rename it before retrying.`,
        )
      }
    }
  }
  const sourcePath = sourcedataExists ? sourcedataPath : targetPath

  // ----- Stage 1: read source NIfTI -----
  const sourceBytes = await fs.readFile(sourcePath)
  const sourceVol = await readNiftiBytes(sourceBytes)

  // Reject 4D (BOLD/DWI/multi-echo) up front. mindgrab's mask is
  // 3D (xyz product); applyMaskToImage at the tail of this function
  // requires img.length === mask.length and would throw AFTER an
  // expensive WebGPU inference. Fail fast with a clear message so
  // batch deface surfaces the per-file failure cleanly and no GPU
  // time is wasted. NIfTI's dim[0] is the rank; dim[4] > 1 also
  // covers files where dim[0] == 3 but a trailing dim[4] sneaks in.
  const dims = sourceVol.header.dims
  const rank = dims[0] ?? 0
  const tDim = dims[4] ?? 1
  if (rank > 3 || tDim > 1) {
    throw new Error(
      `runMindgrab: ${sourcePath} is 4D (rank=${rank}, dims[4]=${tDim}). mindgrab can only deface 3D anatomical scans.`,
    )
  }

  // mindgrab8robust: crop excess neck/inferior slices via the in-tree
  // niimath `-robustfov` port BEFORE conform/inference, so a long neck
  // doesn't throw off the model. Cropping the parsed volume in place
  // keeps ONE working volume for the whole pipeline (conform, infer,
  // inverse-conform, apply) — mixing cropped and pristine grids would
  // corrupt the mask (the deface reference app crops first for the same
  // reason). The pristine `sourceBytes` is untouched and still what
  // lands in the sourcedata mirror, so revert restores the uncropped
  // original. Runs after the 4D guard above (robustfov is 3D-only here).
  if (opts.robustfov) robustFovCrop(sourceVol)

  // ----- Stage 2: conform to 256³ 1 mm -----
  const conformInput = buildConformInput(sourceVol, {
    asFloat32: true,
    isLinear: true,
    toRAS: false,
  })
  const conformed = computeConform(conformInput)
  if (conformed.img.byteLength / 4 !== MINDGRAB_VOXEL_COUNT) {
    // `asFloat32: true` makes conformed.img a Float32Array → 4 bytes per
    // voxel. A mismatch here means the conform transform regressed.
    throw new Error(
      `runMindgrab: conform produced ${conformed.img.byteLength / 4} voxels, expected ${MINDGRAB_VOXEL_COUNT}`,
    )
  }
  const conformedFloat = new Float32Array(
    conformed.img.buffer,
    conformed.img.byteOffset,
    MINDGRAB_VOXEL_COUNT,
  )

  // ----- Stage 3: normalize + transpose to model order -----
  const img32 = transposeToModel(conformedFloat, MINDGRAB_DIM)
  normalizeInPlace(img32)

  // ----- Stage 4: WebGPU inference -----
  const device = await executor.acquireDevice()
  if (device === null) {
    throw new Error(
      'runMindgrab: WebGPU device unavailable (shader-f16 / 1.4 GB max buffer required). See the WebGPU section of BIDSvue > About BIDSvue for details.',
    )
  }
  let maskConformedNiftiOrder: Uint8Array
  try {
    const weights = await executor.resolveWeights(weightsResource)
    const inferer = await executor.loadModel(device, weights)
    try {
      const results = await inferer(img32)
      if (results.length === 0) {
        throw new Error('runMindgrab: inferer returned no output tensors')
      }
      // results[0] is the argmax label volume in model order (z-fastest).
      maskConformedNiftiOrder = transposeFromModelAsLabels(
        results[0],
        MINDGRAB_DIM,
      )
    } finally {
      await inferer.dispose()
    }
  } finally {
    device.destroy()
  }

  // ----- Stage 5: inverse-conform to native grid -----
  let nativeMask = inverseConformMask({
    conformedMask: maskConformedNiftiOrder,
    conformedAffine: conformed.affine,
    nativeAffine: flattenAffine(sourceVol),
    nativeDimsXYZ: [
      sourceVol.header.dims[1],
      sourceVol.header.dims[2],
      sourceVol.header.dims[3],
    ],
  })
  // Empty-mask guard (security review P0-2). If
  // `inverseConformMask` regresses or the affine math drifts, the
  // mask can come back all zeros and `applyMaskToImage` would
  // silently produce an all-zero NIfTI — a fully blanked output
  // committed atomically. Fail loud instead so the user sees an
  // error and the file isn't mutated.
  assertMaskNonEmpty(nativeMask, 'inverseConform')

  // ----- Stage 6: dilate via niimath (mindgrab8 only) -----
  if (dilationMm > 0) {
    nativeMask = await dilateMaskViaNiimath({
      mask: nativeMask,
      sourceVol,
      dilationMm,
      executor,
    })
    assertMaskNonEmpty(nativeMask, 'dilate')
  }

  // ----- Stage 7: apply mask to native image -----
  // `applyMaskToImage` is generic over concrete typed-array
  // constructors. `nifti.ts::typedArrayFromBytes` already picks the
  // right concrete type from `datatypeCode`, so the runtime value is
  // safe — we widen the type once here rather than thread a discriminant
  // through every caller.
  const defacedImg = applyMaskToImage(
    sourceVol.img as
      | Int8Array
      | Uint8Array
      | Int16Array
      | Uint16Array
      | Int32Array
      | Uint32Array
      | Float32Array
      | Float64Array,
    nativeMask,
  )

  // ----- Stage 8: serialise back to disk bytes -----
  // Re-read the *target* bytes for the sourcedata mirror, NOT the
  // sourcedata-mirror's bytes — they're identical when no prior deface
  // exists (we checked above), and reading from `targetPath` here keeps
  // the symmetry with allineate's path (which also reads target bytes
  // when no mirror exists).
  let originalBytes: Uint8Array | null = null
  if (!sourcedataExists) {
    originalBytes = sourceBytes
  }
  const defacedBytes = await writeNiftiBytes(sourceVol, defacedImg)

  // ----- Stage 9: sidecar deid + commit through OperationContext -----
  const updatedSidecar = await readAndApplySidecar(fs, sidecarPath, toolId)
  const ctx = beginOperation(
    datasetRoot,
    statePaths,
    {
      opType: 'deface',
      summary: `Defaced ${basename(targetPath)} (${toolId})`,
      details: {
        toolId,
        target: targetPath,
        sourcedataPath,
        sidecarPath: sidecarPath ?? undefined,
        sourcedataCreated: !sourcedataExists,
        dilationMm,
      },
    },
    fs,
  )
  try {
    // Pre-commit freshness check (target mtime + size unchanged
    // since lease-acquire). Catches the case where an external
    // editor mutated the target during the 5–30 s WebGPU run —
    // committing our mask × image would silently overwrite the
    // user's change.
    if (opts.assertFresh !== undefined) await opts.assertFresh()
    if (originalBytes !== null) {
      const sourcedataParent = dirname(sourcedataPath)
      if (sourcedataParent !== null) {
        await fs.mkdir(sourcedataParent, { recursive: true })
      }
      await ctx.writeBytes(sourcedataPath, originalBytes, {
        why: 'sourcedata backup of pre-deface original',
      })
    }
    await ctx.writeBytes(targetPath, defacedBytes, {
      why: 'mindgrab-masked result',
      toolId,
    })
    if (updatedSidecar !== null) {
      await ctx.writeText(updatedSidecar.path, updatedSidecar.contents, {
        why: 'DeidentificationMethodCodeSequence',
        toolId,
      })
    }
    const { operationId } = await ctx.commit()
    return { operationId, sourcedataPath }
  } catch (err) {
    await ctx.rollback(err)
    throw err
  }
}

// ----- helpers -----

/**
 * Normalize `data` to `[0, 1]` in place. NaN/Inf-tolerant: non-finite
 * voxels are excluded from the min/max scan and written as 0. If the
 * finite range is zero (or no finite voxels exist) the entire output
 * is set to 0 rather than producing NaNs.
 *
 * Mirrors `prepareInput`'s normalisation in brain2print's `index.ts` —
 * the model is trained on [0, 1] inputs.
 */
function normalizeInPlace(data: Float32Array): void {
  let mn = Number.POSITIVE_INFINITY
  let mx = Number.NEGATIVE_INFINITY
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    if (!Number.isFinite(v)) continue
    if (v < mn) mn = v
    if (v > mx) mx = v
  }
  const range = mx - mn
  if (Number.isFinite(range) && range > 0) {
    const scale = 1 / range
    for (let i = 0; i < data.length; i++) {
      const v = data[i]
      data[i] = Number.isFinite(v) ? (v - mn) * scale : 0
    }
  } else {
    data.fill(0)
  }
}

/**
 * Flatten a NIfTI header's 4×4 nested-array affine into the 16-element
 * row-major form `inverseConformMask` consumes. Throws if the affine
 * is not 4×4 — same defensive check `buildConformInput` makes.
 */
function flattenAffine(vol: { header: { affine: number[][] } }): number[] {
  const a = vol.header.affine
  if (!Array.isArray(a) || a.length !== 4) {
    throw new Error('runMindgrab: source NIfTI header lacks a 4×4 affine')
  }
  return [...a[0], ...a[1], ...a[2], ...a[3]]
}

/**
 * Run a morphological dilation on the native-grid mask via the bundled
 * **native** niimath binary and return the dilated bytes. Wraps the mask
 * in a NIfTI (in memory), hands the bytes to the executor — which writes
 * a temp file, spawns niimath, and reads back — and narrows the result.
 *
 * **Pipeline mirrors the working CLI:**
 *
 *   niimath bet -binv -edt -thr 8 -binv -mul Chris_T1.nii.gz dilate
 *
 * Step-by-step (with our 0/1 mask as input):
 *   - `binv`: brain (1) → 0, non-brain (0) → 1
 *   - `edt`:  non-brain voxels get mm-distance to brain; brain stays 0
 *   - `thr N`: zero everything < N; non-brain >N mm keeps its distance
 *   - `binv`: 0 → 1, non-zero → 0. Result: brain + N-mm halo = 1, beyond = 0.
 *
 * The executor owns the exact niimath argv (`<in> -binv -edt -thr N -binv
 * <out>`); the final `-mul Chris_T1.nii.gz` from the CLI is done in TS via
 * `applyMaskToImage`, so niimath only produces the dilated mask.
 *
 * **Caveat from niimath docs:** `edt` "assumes isotropic input".
 * Native-grid voxels may be anisotropic (e.g. a T1 with 1×1×1.2 mm
 * spacing). For v1 we accept that approximation — 8 mm is loose
 * enough that small anisotropy doesn't matter. A future improvement
 * would resample to isotropic before dilation, dilate, then resample
 * back.
 */
async function dilateMaskViaNiimath(args: {
  mask: Uint8Array
  sourceVol: Awaited<ReturnType<typeof readNiftiBytes>>
  dilationMm: number
  executor: MindgrabExecutor
}): Promise<Uint8Array> {
  const { mask, sourceVol, dilationMm, executor } = args

  // Diagnostic: input mask stats. Gated by `import.meta.env.DEV` so
  // production renderer builds stay quiet (refactor #5 / audit cleanup);
  // dev builds keep the verbose log path for troubleshooting niimath
  // edge cases.
  if (import.meta.env.DEV) {
    let inputOnes = 0
    for (let i = 0; i < mask.length; i++) if (mask[i] > 0) inputOnes++
    const px = sourceVol.header.pixDims
    console.log('[mindgrab dilate] input mask:', {
      length: mask.length,
      ones: inputOnes,
      onesPct: `${((inputOnes / mask.length) * 100).toFixed(1)}%`,
      dims: [
        sourceVol.header.dims[1],
        sourceVol.header.dims[2],
        sourceVol.header.dims[3],
      ],
      pixDimsXYZ: [px[1], px[2], px[3]],
      dilationMm,
    })
  }

  // Wrap the mask in a NIfTI by cloning the SOURCE header (so every
  // field niimath might consult — xyzt_units, intent_code, slice_*,
  // descrip, etc. — keeps the source's values), then overriding only
  // the fields that DON'T survive a datatype change: datatype/bitpix
  // (now UINT8), scl_slope/inter (no scaling — raw 0/1), cal_min/max
  // (calibration range for display), and intent_code (force scalar).
  //
  // The previous from-scratch `buildMinimalUint8Nifti` zeroed fields
  // niimath apparently relies on and made the operation roll back;
  // cloning + selective override was the version where the operation
  // at least COMPLETED, so it's the safer baseline.
  const maskVol = {
    header: cloneHeaderAsUint8(sourceVol.header),
    img: mask,
    wasGzipped: true,
  }
  const maskBytes = await writeNiftiBytes(maskVol, mask)
  if (import.meta.env.DEV) {
    console.log(
      '[mindgrab dilate] mask NIfTI bytes (gzipped length):',
      maskBytes.length,
    )
  }

  let outBytes: Uint8Array
  try {
    // Each call spawns its own native niimath process against its own
    // temp dir, so concurrent deface runs don't interfere (the WASM-era
    // shared-worker `onmessage`-stealing hazard is gone).
    outBytes = await executor.runNiimathDilate(maskBytes, dilationMm)
    if (import.meta.env.DEV) {
      console.log(
        '[mindgrab dilate] niimath returned bytes (gzipped):',
        outBytes.length,
      )
    }
  } catch (err) {
    // Log + rethrow so the diagnostic surface tells us what niimath
    // rejected. The DefaceControl catch already routes this to the
    // StatusBar via `datasetStore.lastActionError`, but the console
    // message gives the raw niimath error verbatim. This log stays
    // unconditional (errors are rare and worth surfacing even in prod
    // renderer builds).
    console.error('[mindgrab dilate] niimath dilation threw:', err)
    throw err
  }

  const dilated = await readNiftiBytes(outBytes)
  const dilatedImg = dilated.img
  if (import.meta.env.DEV) {
    console.log('[mindgrab dilate] niimath output NIfTI:', {
      datatypeCode: dilated.header.datatypeCode,
      bitpix: dilated.header.numBitsPerVoxel,
      byteLength: dilatedImg.byteLength,
      voxelCount: dilatedImg.byteLength / sizeOfElement(dilatedImg),
      dims: [
        dilated.header.dims[1],
        dilated.header.dims[2],
        dilated.header.dims[3],
      ],
      firstSample: sampleFirst(dilatedImg, 16),
      range: rangeOf(dilatedImg),
    })
  }

  // niimath may upcast (e.g. to float32 for the EDT pass); narrow back
  // to a Uint8 0/1 mask.
  const result = new Uint8Array(
    dilatedImg.byteLength / sizeOfElement(dilatedImg),
  )
  const arr = asNumberArray(dilatedImg)
  for (let i = 0; i < result.length; i++) {
    result[i] = arr[i] > 0 ? 1 : 0
  }
  if (import.meta.env.DEV) {
    let outOnes = 0
    for (let i = 0; i < result.length; i++) if (result[i] > 0) outOnes++
    console.log('[mindgrab dilate] final binary mask:', {
      length: result.length,
      ones: outOnes,
      onesPct: `${((outOnes / result.length) * 100).toFixed(1)}%`,
    })
  }
  return result
}

/**
 * Throw if `mask` is empty (no non-zero voxels). Used as a guard
 * before `applyMaskToImage` so an inverse-conform or dilation
 * regression can't silently produce an all-zero defaced output and
 * commit it atomically. Security review P0-2.
 */
function assertMaskNonEmpty(mask: Uint8Array, stage: string): void {
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] > 0) return
  }
  throw new Error(
    `runMindgrab: ${stage} produced an empty mask (no non-zero voxels) — refusing to commit an all-zero deface result. This typically indicates an affine-math regression in the conform/inverse-conform path; please file a bug with the [mindgrab dilate] DevTools logs.`,
  )
}

/**
 * Clone the source NIfTI header and override the fields a UINT8 0/1
 * mask needs to redeclare. Cloning (vs from-scratch) preserves the
 * spatial frame (xyzt_units, qform/sform vectors, slice_*) and every
 * other field nifti-reader-js parsed — building a header from scratch
 * risks zeroing a geometry field niimath relies on.
 *
 * This mask NIfTI is written to a temp file under `$APPCACHE` for the
 * native niimath dilation, so the clone is also SCRUBBED of any field
 * that could carry source-derived subject/scanner metadata (audit
 * 2026-06-28 P2): the `descrip` / `aux_file` / `intent_name` free-text
 * fields and ALL NIfTI extensions (a DICOM ecode-2 extension can embed
 * patient fields). niimath needs none of them for the dilation, and
 * dropping them also shrinks the temp file.
 *
 * Overridden fields:
 *   - datatype, bitpix: now UINT8 / 8
 *   - scl_slope = 1, scl_inter = 0: no scaling applied
 *   - cal_min = 0, cal_max = 1: calibration range for a 0/1 mask
 *   - intent_code = 0: scalar (some sources tag T1 with non-zero
 *     intent codes; mask is plain scalar)
 *   - description / aux_file / intent_name = '' and extensions = []:
 *     PHI scrub (see above)
 *   - vox_offset: reset to the actual no-extension serialized header size
 *     (audit 2026-06-28). Stripping `extensions` shrinks what
 *     `toArrayBuffer(true)` writes, but the parsed `vox_offset` still pointed
 *     past the old extension block; `writeNiftiBytes` appends the image right
 *     after the (now shorter) header, so niimath would otherwise seek to the
 *     stale offset and read a shifted/truncated mask. We can't keep both the
 *     scrub AND the old offset — re-derive the offset from the scrubbed header.
 *
 * NOT overridden (kept from source):
 *   - dims, pixDims, sform/qform, xyzt_units, magic.
 *     These are the spatial frame; the mask shares the source's grid.
 */
function cloneHeaderAsUint8<
  H extends {
    datatypeCode: number
    numBitsPerVoxel: number
    scl_slope: number
    scl_inter: number
    toArrayBuffer(includeExtensions?: boolean): ArrayBuffer
  },
>(h: H): H {
  // `Object.assign(Object.create(proto), h)` shallow-copies fields
  // while preserving the prototype, so the result is still an
  // instance of nifti-reader-js's NIFTI1 / NIFTI2 class and
  // `toArrayBuffer` resolves correctly.
  const clone = Object.assign(Object.create(Object.getPrototypeOf(h)), h)
  clone.datatypeCode = 2 // NIFTI1.TYPE_UINT8
  clone.numBitsPerVoxel = 8
  clone.scl_slope = 1
  clone.scl_inter = 0
  // Calibration range — display min/max. For a 0/1 mask, [0, 1] is
  // the honest range; leaving the source's T1 cal_max (~4000) in
  // place would tag the mask as a wider-dynamic-range image.
  ;(clone as unknown as { cal_min: number; cal_max: number }).cal_min = 0
  ;(clone as unknown as { cal_min: number; cal_max: number }).cal_max = 1
  // intent_code: 0 = scalar. Reset in case the source carried a
  // non-zero intent (some pipelines tag T1 with label or stat codes
  // that a mask wouldn't share).
  ;(clone as unknown as { intent_code: number }).intent_code = 0
  // PHI scrub for the cache-resident temp mask. Reassigning `extensions`
  // to a fresh [] does NOT mutate the source header's array (shallow
  // copy shared the reference; this shadows it on the clone).
  ;(
    clone as unknown as {
      description: string
      aux_file: string
      intent_name: string
      extensions: unknown[]
    }
  ).description = ''
  ;(clone as unknown as { aux_file: string }).aux_file = ''
  ;(clone as unknown as { intent_name: string }).intent_name = ''
  ;(clone as unknown as { extensions: unknown[] }).extensions = []
  // Re-sync vox_offset with the scrubbed header. nifti-reader-js sizes
  // `toArrayBuffer(true)` from the (now empty) extensions array, and
  // `writeNiftiBytes` places the image immediately after that serialized
  // header — so vox_offset MUST equal the serialized length (352 for
  // NIfTI-1, 544 for NIfTI-2) or niimath reads the payload from the wrong
  // place. Measuring via toArrayBuffer keeps this correct for both versions
  // without hardcoding the size.
  ;(clone as unknown as { vox_offset: number }).vox_offset =
    clone.toArrayBuffer(true).byteLength
  return clone
}

function sampleFirst(view: ArrayBufferView, n: number): number[] {
  const arr = asNumberArray(view)
  const len = Math.min(arr.length, n)
  const result: number[] = []
  for (let i = 0; i < len; i++) result.push(arr[i])
  return result
}

function rangeOf(view: ArrayBufferView): { min: number; max: number } {
  const arr = asNumberArray(view)
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max }
}

function sizeOfElement(view: ArrayBufferView): number {
  if (view instanceof Float64Array) return 8
  if (view instanceof Float32Array) return 4
  if (view instanceof Int32Array || view instanceof Uint32Array) return 4
  if (view instanceof Int16Array || view instanceof Uint16Array) return 2
  return 1
}

function asNumberArray(view: ArrayBufferView): ArrayLike<number> {
  // All typed arrays except DataView are ArrayLike<number>.
  return view as unknown as ArrayLike<number>
}

// Surface the nibType helper from `nifti.ts` so callers writing tests
// against the orchestrator's helpers don't have to import from two
// places. Also used internally by the M11 design checkpoint suite.
export { nibType }
// Exported for the PHI-scrub / vox_offset regression test.
export { cloneHeaderAsUint8 }
