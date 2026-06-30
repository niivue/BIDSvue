// Orchestrate a defacing run (M7 Phase A).
//
// One `runDeface` call:
//
//   1. Resolves the tool's binary + bundled template/mask to absolute
//      paths via the injectable `DefaceExecutor`.
//   2. Picks the actual input: the `<root>/sourcedata/` mirror if it
//      already exists (so re-defacing with a different tool starts
//      from pristine source, not from already-defaced bytes); the
//      user-facing target file otherwise.
//   3. Runs the binary into a temp file (per `executor.tempDir()`).
//   4. Wraps every disk-mutating step in one `OperationContext`:
//        a. Sourcedata mirror write (only if it didn't already exist).
//        b. Atomic replacement of the user-facing target with the
//           defaced output bytes.
//        c. JSON sidecar update — appends a `BIDSvue` entry to
//           `DeidentificationMethodCodeSequence` (preserving prior
//           non-BIDSvue entries).
//      A mid-step failure rolls back via OperationContext's LIFO undo,
//      restoring the dataset to its pre-deface state.
//
// `revertDeface` runs the inverse: read sourcedata bytes, write them
// over the target, clear our BIDSvue entry from the sidecar. The
// sourcedata mirror stays in place so the user can re-deface with a
// different tool without re-staging from scratch.
//
// The executor abstraction (`DefaceExecutor`) keeps this module
// testable under bun:test: tests inject a stub that records the argv
// it was called with and writes a canned "defaced" payload; the real
// app injects a Rust-command-backed implementation that runs the
// bundled sidecar binary.

import {
  type MutateFs,
  type OperationLogEntry,
  beginOperation,
} from '$lib/mutate/backup'
import { parseSidecar, serializeSidecar } from '$lib/sidecar/parse'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import {
  basename,
  detectSeparator,
  dirname,
  stripTrailingSeparators,
} from '$lib/util/paths'
import { applyDeidState, detectDefaceState } from './defaceStatus'
import { type PartialReadFs, ensureNotFourD } from './headerProbe'
import { jsonSidecarPath, sourcedataMirrorPath } from './sourcedataPath'
import { type DefaceState, type SidecarDefaceToolId, findTool } from './tools'

/**
 * Injectable execution surface. Production passes a Rust-command-backed
 * implementation; tests pass a stub.
 */
export interface DefaceExecutor {
  /**
   * Resolve a per-platform binary basename (e.g. `'allineate'`) to an
   * absolute filesystem path. The production impl combines platform
   * detection + `resolveResource` against the bundled resources/
   * tree.
   */
  resolveBinary(basename: string): Promise<string>
  /**
   * Resolve a bundle-relative resource path (e.g.
   * `'common/avg152T1.nii.gz'`) to an absolute filesystem
   * path inside the app bundle.
   */
  resolveResource(relPath: string): Promise<string>
  /**
   * Allocate a fresh, writable temp directory the orchestrator owns
   * for one run. Production uses `appCacheDir()` not OS tempDir so the
   * directory falls under the Tauri capability `fs:scope` allowlist
   * (which is `$HOME/**`); the OS temp root is outside that scope and
   * mkdir fails (audit pass 3 follow-up). The caller passes the dir
   * back to `cleanupTempDir` in `finally`.
   */
  tempDir(): Promise<string>
  /**
   * Tear down a directory previously returned from `tempDir`. Best-
   * effort; the orchestrator's `finally` wraps this in a `.catch` so a
   * cleanup race never masks the real action error. Recursive — the
   * binary may have written intermediate files alongside the named
   * output (allineate doesn't today, but future tools may).
   */
  cleanupTempDir(dir: string): Promise<void>
  /**
   * Run the sidecar for `toolId` with `argv`. Rust maps the id to the
   * bundled binary + validates the argv before spawning. Resolves with
   * stdout/stderr on exit code 0; rejects on non-zero or process error.
   * Implementations should set a working directory the binary can write
   * into (the temp dir is the natural choice).
   */
  run(
    toolId: string,
    argv: readonly string[],
    cwd: string,
    datasetRoot: string,
  ): Promise<{ stdout: string; stderr: string }>
  /** Read a file's bytes (binary-safe, used for the deface output). */
  readFile(path: string): Promise<Uint8Array>
}

export interface RunDefaceOptions {
  datasetRoot: string
  statePaths: DatasetStatePaths
  /** Absolute path of the BIDS file being defaced (e.g. .../sub-01_T1w.nii.gz). */
  targetPath: string
  toolId: SidecarDefaceToolId
  executor: DefaceExecutor
  fs: MutateFs
  /**
   * Optional pre-commit freshness check. Invoked inside the
   * OperationContext's try-block, immediately before the first write,
   * so a thrown error (e.g. `TargetMutatedError` from a MutationLease)
   * triggers `ctx.rollback` and aborts cleanly. Wired up from
   * `actions.ts::defaceFile` with the lease's `assertTargetUnchanged`.
   */
  assertFresh?: () => Promise<void>
  /**
   * Optional partial-read filesystem hook for the 4D NIfTI guard
   * (Day-1 Goal 1.3). When provided, `runDeface` probes the target's
   * 352-byte header before spawning allineate and throws
   * `FourDRejectedError` for `rank > 3` or `dim[4] > 1`. Production
   * wires `tauriPostPassFs`; tests can omit the hook to skip the
   * probe. The guard lives here (rather than only at the action
   * layer) so direct callers can't bypass the policy.
   */
  partialReadFs?: PartialReadFs
}

export interface RunDefaceResult {
  operationId: string
  /** Absolute path of the sourcedata mirror that now (or already) holds the pristine source. */
  sourcedataPath: string
  /** Captured stdout/stderr from the binary, for the job log / debugging. */
  stdout: string
  stderr: string
}

/**
 * Run a deface tool against `targetPath` and commit the result through
 * an `OperationContext`. The committed entry's `details` carries the
 * tool id + the sourcedata mirror path so the future history UI can
 * render a useful summary.
 */
export async function runDeface(
  opts: RunDefaceOptions,
): Promise<RunDefaceResult> {
  const { datasetRoot, statePaths, targetPath, toolId, executor, fs } = opts
  const assertFresh = opts.assertFresh
  const sep = detectSeparator(stripTrailingSeparators(datasetRoot))

  const tool = findTool(toolId)
  if (tool.kind !== 'sidecar') {
    // Should be unreachable — `RunDefaceOptions.toolId` is narrowed to
    // `SidecarDefaceToolId`. Defensive against a future caller that
    // bypasses the type system.
    throw new Error(
      `runDeface: tool "${toolId}" has kind "${tool.kind}", not sidecar. WebGPU tools must go through runMindgrab.`,
    )
  }
  const sourcedataPath = sourcedataMirrorPath(datasetRoot, targetPath)
  if (sourcedataPath === null) {
    throw new Error(
      `runDeface: targetPath "${targetPath}" is not a sourcedata-mirrorable path under "${datasetRoot}"`,
    )
  }
  // Day-1 Goal 1.3: reject 4D BOLD / DWI / ASL up front, before any
  // resource resolution, sourcedata setup, or subprocess spawn.
  // Co-located here (vs only at the action layer) so direct callers of
  // `runDeface` can't bypass the policy — header-only probe drains
  // ~352 decompressed bytes, so the cost is negligible.
  if (opts.partialReadFs !== undefined) {
    await ensureNotFourD(targetPath, opts.partialReadFs)
  }
  const sidecarPath = jsonSidecarPath(targetPath)

  // Validate the sidecar mapping (throws on an unknown basename); Rust
  // resolves the actual binary from the tool id, so we don't keep the path.
  await executor.resolveBinary(tool.binaryBasename)
  const templatePath = await executor.resolveResource(tool.inputs.template)
  const maskPath = await executor.resolveResource(tool.inputs.mask)

  // Pick the actual input: pristine sourcedata if it already exists,
  // otherwise the user-facing target (which IS the pristine source on
  // a first-time deface).
  //
  // Ownership check (audit external H2). Before treating an existing
  // `<root>/sourcedata/<rel>` as the pristine input, verify it isn't
  // a user-staged file that happens to share the path. The check is
  // straightforward: when the target is still in 'original' state
  // (no BIDSvue deface entry in the sidecar yet), the sourcedata
  // mirror — if it exists — MUST be byte-identical to the target,
  // because BIDSvue only writes that mirror as a copy of the target
  // on first deface. A mismatch means either the user populated
  // sourcedata themselves (HeuDiConv-style raw data, etc.) or a
  // previous deface rolled back inconsistently; in either case we
  // refuse rather than using the wrong bytes as the deface input
  // (and, on revert, restoring the wrong file).
  //
  // Once the target has been defaced (state !== 'original'), BIDSvue
  // owns sourcedata by construction and we skip the byte-compare.
  const sourcedataExists = await fs.exists(sourcedataPath)
  if (sourcedataExists) {
    const currentState = await detectTargetState(targetPath, fs)
    if (currentState === 'original') {
      if (!(await fileBytesEqual(fs, sourcedataPath, targetPath))) {
        throw new Error(
          `runDeface: refusing to deface — an existing file at "${sourcedataPath}" doesn't match the current target bytes, so BIDSvue can't safely treat it as the pristine source. Move or rename it before retrying.`,
        )
      }
    }
  }
  const actualInput = sourcedataExists ? sourcedataPath : targetPath

  // Temp output path; binary writes there, we read the bytes, commit
  // them over the target through the OperationContext.
  const tempDir = await executor.tempDir()
  const tempOutputPath = `${tempDir}${sep}${basename(targetPath)}`

  // Single outer try/finally guards every path that allocates inside
  // tempDir, so a sidecar-parse / read / open failure post-tempDir
  // can't orphan multi-GB binary output files. Cleanup removes the
  // whole tempDir tree (recursive) since the executor owns that dir.
  try {
    const argv = tool.argv.map((arg) => {
      switch (arg) {
        case '{template}':
          return templatePath
        case '{mask}':
          return maskPath
        case '{input}':
          return actualInput
        case '{output}':
          return tempOutputPath
        default:
          return arg
      }
    })

    const { stdout, stderr } = await executor.run(
      toolId,
      argv,
      tempDir,
      datasetRoot,
    )
    const defacedBytes = await executor.readFile(tempOutputPath)

    // Prepare updated sidecar (if one exists). We compute the new
    // bytes up-front so a sidecar-parse failure aborts before any
    // disk mutation.
    const updatedSidecar = await readAndApplySidecar(fs, sidecarPath, toolId)

    // Original bytes for the sourcedata backup, if we need to make one.
    let originalBytes: Uint8Array | null = null
    if (!sourcedataExists) {
      originalBytes = await executor.readFile(targetPath)
    }

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
        },
      },
      fs,
    )
    try {
      // Pre-commit freshness check. If the target was externally
      // modified during the binary run (1–3 s for allineate), abort
      // before any disk mutation so we don't silently overwrite a
      // user edit. No-op when the caller didn't pass `assertFresh`.
      if (assertFresh !== undefined) await assertFresh()
      if (originalBytes !== null) {
        // The sourcedata mirror's parent directory likely doesn't
        // exist on first-time deface (no prior sourcedata/sub-XX/
        // anat/). The atomic-write primitive places its temp file in
        // that same directory, so we mkdir before handing the write
        // to the ctx.
        const sourcedataParent = dirname(sourcedataPath)
        if (sourcedataParent !== null) {
          await fs.mkdir(sourcedataParent, { recursive: true })
        }
        await ctx.writeBytes(sourcedataPath, originalBytes, {
          why: 'sourcedata backup of pre-deface original',
        })
      }
      await ctx.writeBytes(targetPath, defacedBytes, {
        why: 'defaced result',
        toolId,
      })
      if (updatedSidecar !== null) {
        await ctx.writeText(updatedSidecar.path, updatedSidecar.contents, {
          why: 'DeidentificationMethodCodeSequence',
          toolId,
        })
      }
      const { operationId } = await ctx.commit()
      return { operationId, sourcedataPath, stdout, stderr }
    } catch (err) {
      await ctx.rollback(err)
      throw err
    }
  } finally {
    // Best-effort recursive teardown of the executor's temp dir.
    // Covers the named output file plus any intermediate files a tool
    // might write alongside it (allineate doesn't, but the contract
    // generalises). The `.catch` is critical: a cleanup race must
    // never mask the real action error that's already in-flight.
    await executor.cleanupTempDir(tempDir).catch(() => {})
  }
}

export interface RevertDefaceOptions {
  datasetRoot: string
  statePaths: DatasetStatePaths
  /** Absolute path of the BIDS file to restore from its sourcedata mirror. */
  targetPath: string
  fs: MutateFs
  /** Pre-commit freshness check — see `RunDefaceOptions.assertFresh`. */
  assertFresh?: () => Promise<void>
}

export interface RevertDefaceResult {
  operationId: string
}

/**
 * Restore `targetPath` from its `<root>/sourcedata/` mirror and clear
 * the BIDSvue entry from its JSON sidecar's
 * `DeidentificationMethodCodeSequence`. The sourcedata copy stays in
 * place; subsequent re-defacing reads from it.
 *
 * Throws if no sourcedata mirror exists — there's nothing to revert to.
 */
export async function revertDeface(
  opts: RevertDefaceOptions,
): Promise<RevertDefaceResult> {
  const { datasetRoot, statePaths, targetPath, fs } = opts

  const sourcedataPath = sourcedataMirrorPath(datasetRoot, targetPath)
  if (sourcedataPath === null) {
    throw new Error(
      `revertDeface: targetPath "${targetPath}" is not under "${datasetRoot}"`,
    )
  }
  if (!(await fs.exists(sourcedataPath))) {
    throw new Error(
      `revertDeface: no sourcedata mirror at "${sourcedataPath}" to revert from`,
    )
  }
  const sidecarPath = jsonSidecarPath(targetPath)
  const updatedSidecar = await readAndApplySidecar(fs, sidecarPath, 'original')
  const sourceBytes = await fs.readFile(sourcedataPath)

  const ctx = beginOperation(
    datasetRoot,
    statePaths,
    {
      opType: 'deface',
      summary: `Reverted deface on ${basename(targetPath)}`,
      details: {
        target: targetPath,
        sourcedataPath,
        sidecarPath: sidecarPath ?? undefined,
        kind: 'revert',
      },
    },
    fs,
  )
  try {
    if (opts.assertFresh !== undefined) await opts.assertFresh()
    await ctx.writeBytes(targetPath, sourceBytes, {
      why: 'restore from sourcedata',
    })
    if (updatedSidecar !== null) {
      await ctx.writeText(updatedSidecar.path, updatedSidecar.contents, {
        why: 'clear DeidentificationMethodCodeSequence',
      })
    }
    const { operationId } = await ctx.commit()
    return { operationId }
  } catch (err) {
    await ctx.rollback(err)
    throw err
  }
}

/**
 * Detect the current state of `targetPath` by reading its JSON
 * sidecar. Returns `'original'` if no sidecar exists or the sidecar
 * doesn't carry a BIDSvue entry. Used by the dropdown UI to render
 * which tool (if any) the image is currently defaced with.
 */
export async function detectTargetState(
  targetPath: string,
  fs: Pick<MutateFs, 'exists' | 'readTextFile'>,
): Promise<DefaceState> {
  const sidecarPath = jsonSidecarPath(targetPath)
  if (sidecarPath === null) return 'original'
  if (!(await fs.exists(sidecarPath))) return 'original'
  try {
    const text = await fs.readTextFile(sidecarPath)
    const parsed = parseSidecar(text)
    return detectDefaceState(parsed.value)
  } catch {
    // Malformed JSON — surface as 'original'; the UI is informational
    // and won't act on it.
    return 'original'
  }
}

// ----- helpers -----

/**
 * Read the JSON sidecar at `sidecarPath` (if it exists) and return
 * the bytes that should be written back after applying `nextState`.
 *
 * Three cases:
 *   1. `sidecarPath === null` (file isn't a NIfTI) → return null;
 *      the orchestrator skips the sidecar write entirely.
 *   2. The sidecar exists → parse it, apply the deid change,
 *      re-serialise preserving formatting (indent, key order,
 *      trailing newline) via the M4 parser/serialiser.
 *   3. The sidecar does NOT exist AND we're tagging (not reverting)
 *      → synthesize a minimal sidecar with just the deid entry.
 *      BIDS allows inheritance from a higher-level `.json`, but
 *      writing into the inherited file would tag every other
 *      subject under it. The deface state must be per-file, so we
 *      always create a sibling sidecar when we tag (audit pass 2
 *      M1). Revert with no sibling sidecar is a no-op (there's
 *      nothing tagged at this level to strip).
 */
export async function readAndApplySidecar(
  fs: Pick<MutateFs, 'exists' | 'readTextFile'>,
  sidecarPath: string | null,
  nextState: DefaceState,
): Promise<{ path: string; contents: string } | null> {
  if (sidecarPath === null) return null
  const exists = await fs.exists(sidecarPath)
  if (!exists) {
    // Nothing to revert against — be a silent no-op rather than
    // synthesising an empty sidecar.
    if (nextState === 'original') return null
    const nextValue = applyDeidState(null, nextState)
    // Minimal formatting: 2-space indent, trailing newline. Matches
    // what the M4 sidecar editor uses for new files.
    const contents = `${JSON.stringify(nextValue, null, 2)}\n`
    return { path: sidecarPath, contents }
  }
  const text = await fs.readTextFile(sidecarPath)
  const parsed = parseSidecar(text)
  const nextValue = applyDeidState(
    parsed.value as Record<string, unknown>,
    nextState,
  )
  // applyDeidState returns the same shape parseSidecar consumed; the
  // serialiser accepts any object literal compatible with parsed.value.
  const contents = serializeSidecar(
    nextValue as typeof parsed.value,
    parsed.format,
  )
  return { path: sidecarPath, contents }
}

/** Re-export so tests can synthesize an OperationLogEntry without re-importing the type. */
export type { MutateFs, OperationLogEntry }

// `dirname` re-export to keep the orchestrator's test harness self-
// contained when the caller wants to assert on parent directories.
export { dirname }

/**
 * Byte-by-byte equality test for two files. Both are read fully into
 * memory — for the anat-scan size envelope we target (T1w / T2w /
 * FLAIR / PDw, typically 5–50 MB) the peak ~100 MB is acceptable.
 * Used by the H2 ownership check above. A future post-pass importer
 * that traffics in 4D BOLD bytes would need a streaming variant, or
 * `MutateFs` could grow a `stat()` method so size-mismatch can
 * fast-reject without reading either body.
 */
export async function fileBytesEqual(
  fs: Pick<MutateFs, 'readFile'>,
  a: string,
  b: string,
): Promise<boolean> {
  const [ab, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)])
  if (ab.byteLength !== bb.byteLength) return false
  for (let i = 0; i < ab.byteLength; i++) {
    if (ab[i] !== bb[i]) return false
  }
  return true
}
