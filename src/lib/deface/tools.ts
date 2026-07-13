// Tool descriptors for the M7 defacing pipeline.
//
// A descriptor names a defacing tool, the binary that runs it, the
// argv template the orchestrator feeds the binary, and the
// `DeidentificationMethodCodeSequence` entry the JSON sidecar gets
// after a successful run. New tools land here without changing the
// orchestrator's dispatch path.
//
// "Defacing" is overloaded in the literature. The sidecar tools mask
// the face region by registering an avg152T1 template + mask to the
// subject via niimath `-deface` (12-DOF affine): `allineate` (default
// fast engine), `allineate-robust` (`-robustfov` neck-crop first), and
// `allineate-afni` (`-cost hel`, the AFNI Hellinger engine). The WebGPU
// mindgrab tools brain-mask instead. New tools hook into
// this same descriptor shape when they're wired up. (The GPL
// `spm_coreg` 6-DOF `-spm_deface` path was removed so BIDSvue ships a
// BSD-only niimath; see git log.)
//
// The descriptor's argv template uses named placeholders:
//   {template}   — the atlas image bundled with the app
//   {mask}       — the corresponding mask bundled with the app
//   {input}      — the raw image being defaced
//   {output}     — the path the tool writes its result to
//
// The orchestrator resolves every placeholder to a concrete absolute
// path before invoking the binary; the binary itself never sees the
// raw template strings.

/**
 * Stable identifier for the chosen deface tool. Appears in the JSON
 * sidecar's `DeidentificationMethodCodeSequence` and in the
 * operations-log entry's details. Bumped when the algorithm changes
 * in a way users should re-deface for.
 *
 * - `allineate` — niimath `-deface` (12-DOF affine, default fast engine)
 *   via the bundled niimath sidecar.
 * - `allineate-robust` — same, with `-robustfov` chained first to crop the
 *   neck/inferior slices before registration.
 * - `allineate-afni` — same default engine but `-cost hel` (AFNI-style
 *   Hellinger cost, the ordinary AFNI allineate engine — slower, no fast path).
 * - `mindgrab` — tinygrad WebGPU brain-mask model, 0 mm native-space dilation (M11).
 * - `mindgrab8` — same model, 8 mm niimath dilation pass (M11).
 * - `mindgrab8robust` — same as `mindgrab8` but the source is first cropped
 *   with niimath `-robustfov` (removes excess neck/inferior slices) so the
 *   model isn't thrown off by a long neck.
 */
export type DefaceToolId =
  | 'allineate'
  | 'allineate-robust'
  | 'allineate-afni'
  | 'mindgrab'
  | 'mindgrab8'
  | 'mindgrab8robust'

/** IDs of `kind: 'sidecar'` tools (run a native binary via Rust command). */
export type SidecarDefaceToolId = Extract<
  DefaceToolId,
  'allineate' | 'allineate-robust' | 'allineate-afni'
>

/** IDs of `kind: 'webgpu'` tools (run in-process via tinygrad WGSL). */
export type WebGpuDefaceToolId = Extract<
  DefaceToolId,
  'mindgrab' | 'mindgrab8' | 'mindgrab8robust'
>

/**
 * "Original" is not a tool — it's the dropdown's pre-deface state.
 * Used by the UI to render the picker; the executor checks against
 * `DefaceToolId` only.
 */
export type DefaceState = 'original' | DefaceToolId

/**
 * The deid-entry shape — common to every kind.
 *
 * Per BIDS spec these are DICOM-style SNOMED code triplets; we use a
 * BIDSvue-private `CodingSchemeDesignator` so downstream tools can tell
 * our entries from genuine DICOM ones.
 */
export interface DefaceDeidEntry {
  CodingSchemeDesignator: string
  CodeValue: string
  CodeMeaning: string
}

/**
 * A sidecar-binary tool (M7 path). Run by `runDeface.ts` via a Rust
 * process command. `allineate` runs wherever a bundled niimath exists.
 */
export interface SidecarDefaceTool {
  kind: 'sidecar'
  id: SidecarDefaceToolId
  /** Short user-facing label for the dropdown. Canonical English. */
  label: string
  /** One-line description for tooltips. Canonical English. */
  description: string
  /**
   * Argv template. Each token is either a literal arg or a placeholder
   * `{template}` / `{mask}` / `{input}` / `{output}` the executor
   * substitutes before invoking the binary.
   */
  argv: readonly string[]
  /**
   * Basename of the binary (no platform suffix). The runtime resolves
   * `<resourcesDir>/<platform>/<binaryBasename>` to an absolute path
   * before invoking.
   */
  binaryBasename: string
  /**
   * Bundle-relative paths of the inputs the argv template references.
   * Resolved against the app's bundled resources/common/ tree before
   * the binary runs.
   */
  inputs: {
    template: string
    mask: string
  }
  /** Sidecar entry. */
  deidEntry: DefaceDeidEntry
}

/**
 * A WebGPU tool (M11 path). The brain-mask inference runs in-process via
 * tinygrad-generated WGSL on the GPU; the optional mask dilation
 * (`dilationMm > 0`) shells out to the bundled NATIVE niimath sidecar
 * (`niimath_dilate` — there is no WASM niimath in the app). The UI gates
 * this with a `webgpuAvailable` check (via the `View > Probe WebGPU
 * support…` dialog's same probe code).
 */
export interface WebGpuDefaceTool {
  kind: 'webgpu'
  id: WebGpuDefaceToolId
  label: string
  description: string
  /**
   * Bundle-relative path of the model weights blob. Resolved against
   * the app's bundled `resources/common/` tree at execution time.
   */
  weightsResource: string
  /**
   * Native-space mask dilation in mm. 0 for `mindgrab` (no dilation),
   * 8 for `mindgrab8`. Threaded into the niimath dilation pipeline's
   * `-thr N` step inside the orchestrator (full pipeline:
   * `[binv, edt, thr N, binv]`).
   */
  dilationMm: number
  /**
   * When true, the source is cropped with niimath `-robustfov` (removes
   * excess neck/inferior slices) before conform + inference. The cropped
   * copy becomes the single working volume for the whole pipeline. Used by
   * `mindgrab8robust` for scans whose long neck throws off the model.
   */
  robustfov?: boolean
  deidEntry: DefaceDeidEntry
}

/** Tool metadata used by the executor + UI. */
export type DefaceTool = SidecarDefaceTool | WebGpuDefaceTool

/** Shared bundled atlas inputs for every allineate variant. */
const ALLINEATE_INPUTS = {
  template: 'common/avg152T1.nii.gz',
  mask: 'common/avg152T1mask.nii.gz',
} as const

/**
 * niimath `-deface` (12-DOF affine), the DEFAULT fast engine. Warps the
 * avg152T1 template + mask to the subject and masks the face region. Runs
 * via the bundled `niimath` sidecar.
 *
 *   niimath <input> -deface <template> <mask> <output>
 */
export const TOOL_ALLINEATE: SidecarDefaceTool = {
  kind: 'sidecar',
  id: 'allineate',
  label: 'allineate',
  description: 'niimath allineate 12-DOF affine deface (default fast engine)',
  binaryBasename: 'niimath',
  argv: ['{input}', '-deface', '{template}', '{mask}', '{output}'],
  inputs: ALLINEATE_INPUTS,
  deidEntry: {
    CodingSchemeDesignator: 'BIDSvue',
    CodeValue: 'BIDSVUE-DEFACE-ALLINEATE-V1',
    CodeMeaning: 'BIDSvue allineate deface',
  },
}

/**
 * Same as `TOOL_ALLINEATE` but chains niimath `-robustfov` before `-deface`
 * to crop the neck/inferior slices before registration (steadier fit on
 * scans with a long neck / large FOV).
 *
 *   niimath <input> -robustfov -deface <template> <mask> <output>
 */
export const TOOL_ALLINEATE_ROBUST: SidecarDefaceTool = {
  kind: 'sidecar',
  id: 'allineate-robust',
  label: 'allineate-robust',
  description: 'niimath robustfov neck-crop + allineate 12-DOF affine deface',
  binaryBasename: 'niimath',
  argv: [
    '{input}',
    '-robustfov',
    '-deface',
    '{template}',
    '{mask}',
    '{output}',
  ],
  inputs: ALLINEATE_INPUTS,
  deidEntry: {
    CodingSchemeDesignator: 'BIDSvue',
    CodeValue: 'BIDSVUE-DEFACE-ALLINEATE-ROBUST-V1',
    CodeMeaning: 'BIDSvue allineate deface (robustfov neck crop)',
  },
}

/**
 * Same `-deface` but with `-cost hel` — the AFNI-style Hellinger cost, i.e.
 * the ordinary AFNI allineate engine (slower, no fast path). For subjects
 * where the default fast engine misregisters.
 *
 *   niimath <input> -deface <template> <mask> -cost hel <output>
 */
export const TOOL_ALLINEATE_AFNI: SidecarDefaceTool = {
  kind: 'sidecar',
  id: 'allineate-afni',
  label: 'allineate-afni',
  description:
    'niimath allineate deface, AFNI-style Hellinger cost (-cost hel)',
  binaryBasename: 'niimath',
  argv: [
    '{input}',
    '-deface',
    '{template}',
    '{mask}',
    '-cost',
    'hel',
    '{output}',
  ],
  inputs: ALLINEATE_INPUTS,
  deidEntry: {
    CodingSchemeDesignator: 'BIDSvue',
    CodeValue: 'BIDSVUE-DEFACE-ALLINEATE-AFNI-V1',
    CodeMeaning: 'BIDSvue allineate deface (AFNI Hellinger cost)',
  },
}

/**
 * tinygrad WebGPU brain-mask model, no dilation. Native-space mask ×
 * original = brain-only NIfTI. Cross-platform wherever WebGPU +
 * `shader-f16` is available (see [`decisions/M11-mindgrab-deface.md`]).
 */
export const TOOL_MINDGRAB: WebGpuDefaceTool = {
  kind: 'webgpu',
  id: 'mindgrab',
  label: 'mindgrab',
  description: 'WebGPU brain-mask model — native-space masking, no dilation',
  weightsResource: 'common/mindgrab/net_mindgrab.safetensors',
  dilationMm: 0,
  deidEntry: {
    CodingSchemeDesignator: 'BIDSvue',
    CodeValue: 'BIDSVUE-DEFACE-MINDGRAB-V1',
    CodeMeaning: 'BIDSvue mindgrab WebGPU brain-mask deface',
  },
}

/**
 * Same model as `TOOL_MINDGRAB` but with an 8 mm niimath dilation
 * pass (`[binv, edt, thr 8, binv]`) on the native-space mask. The
 * wider margin keeps the cortex intact for downstream intensity-
 * homogeneity correction.
 */
export const TOOL_MINDGRAB8: WebGpuDefaceTool = {
  kind: 'webgpu',
  id: 'mindgrab8',
  label: 'mindgrab-8mm',
  description:
    'WebGPU brain-mask model — native-space masking, 8 mm niimath -edt dilation',
  weightsResource: 'common/mindgrab/net_mindgrab.safetensors',
  dilationMm: 8,
  deidEntry: {
    CodingSchemeDesignator: 'BIDSvue',
    CodeValue: 'BIDSVUE-DEFACE-MINDGRAB-DIL8-V1',
    CodeMeaning: 'BIDSvue mindgrab WebGPU brain-mask deface (8 mm dilation)',
  },
}

/**
 * Same as `TOOL_MINDGRAB8` but crops the source with niimath `-robustfov`
 * before conform + inference. robustfov removes excess neck/inferior
 * slices; the cropped copy is then the single working volume through the
 * whole pipeline (conform, infer, inverse-conform, mask-apply) — mixing
 * cropped and pristine grids would corrupt the mask. For scans where the
 * stock mindgrab fails on a long neck.
 */
export const TOOL_MINDGRAB8ROBUST: WebGpuDefaceTool = {
  kind: 'webgpu',
  id: 'mindgrab8robust',
  label: 'mindgrab-robust-8mm',
  description:
    'WebGPU brain-mask model — robustfov neck crop + 8 mm niimath -edt dilation',
  weightsResource: 'common/mindgrab/net_mindgrab.safetensors',
  dilationMm: 8,
  robustfov: true,
  deidEntry: {
    CodingSchemeDesignator: 'BIDSvue',
    CodeValue: 'BIDSVUE-DEFACE-MINDGRAB-ROBUST-DIL8-V1',
    CodeMeaning:
      'BIDSvue mindgrab WebGPU brain-mask deface (robustfov + 8 mm dilation)',
  },
}

/**
 * Registry. The dropdown renders in this order. Adding a tool: push
 * another descriptor here + handle the new id in the orchestrator
 * dispatch.
 */
export const DEFACE_TOOLS: readonly DefaceTool[] = [
  TOOL_ALLINEATE,
  TOOL_ALLINEATE_ROBUST,
  TOOL_ALLINEATE_AFNI,
  TOOL_MINDGRAB,
  TOOL_MINDGRAB8,
  TOOL_MINDGRAB8ROBUST,
]

export function findTool(id: DefaceToolId): DefaceTool {
  for (const t of DEFACE_TOOLS) {
    if (t.id === id) return t
  }
  // Exhaustive union check — unreachable unless a new id was added
  // without a descriptor.
  throw new Error(`findTool: unknown tool id "${id}"`)
}
