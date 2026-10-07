// Tool descriptors for the M7 defacing pipeline.
//
// A descriptor names a defacing tool, the binary that runs it, the
// argv template the orchestrator feeds the binary, and the
// `DeidentificationMethodCodeSequence` entry the JSON sidecar gets
// after a successful run. New tools land here without changing the
// orchestrator's dispatch path.
//
// "Defacing" is overloaded in the literature. The allineate tools mask
// the face region by registering an avg152T1 template + mask to the
// subject via niimath `-deface` (12-DOF affine): `allineate` (default
// fast engine), `allineate-robust` (`-robustfov` neck-crop first), and
// `allineate-afni` (`-cost hel`, the AFNI Hellinger engine). The
// mindgrab tools brain-extract instead, via the native
// `brainchop-mindgrab` MeshNet sidecar (which replaced the former
// in-WebView WebGPU model — see git log). New tools hook into this same
// descriptor shape when they're wired up. (The GPL `spm_coreg` 6-DOF
// `-spm_deface` path was removed so BIDSvue ships a BSD-only niimath;
// see git log.)
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
 * - `mindgrab` — native `brainchop-mindgrab` MeshNet brain extraction, no
 *   mask dilation.
 * - `mindgrab8` — same model, 8 mm mask border (the binary's own `--border`).
 */
export type DefaceToolId =
  | 'allineate'
  | 'allineate-robust'
  | 'allineate-afni'
  | 'mindgrab'
  | 'mindgrab8'

/**
 * Every deface tool now runs a bundled native binary via a Rust process
 * command (`kind: 'sidecar'`) — the allineate variants via `niimath`, the
 * mindgrab variants via `brainchop-mindgrab`. The former in-WebView WebGPU
 * mindgrab path was removed (see git log); this alias is retained for the
 * many call sites that narrow to a runnable tool id.
 */
export type SidecarDefaceToolId = DefaceToolId

/**
 * The tool ids backed by the `brainchop-mindgrab` engine (native sidecar,
 * or the WebGL2 wasm executor under `VITE_BIDSVUE_MINDGRAB_BACKEND=wasm`).
 * Single source of truth for the renderer-side routing/gating so it can't
 * regress into per-site id lists or a mix of `id` vs `binaryBasename`
 * checks. The Rust `is_brainchop_tool` in process.rs is the deliberate
 * cross-boundary copy — keep the two in sync.
 */
export const MINDGRAB_TOOL_IDS = ['mindgrab', 'mindgrab8'] as const

/** True when `id` routes to the brainchop mindgrab engine. */
export function isMindgrabTool(id: DefaceToolId): boolean {
  return (MINDGRAB_TOOL_IDS as readonly string[]).includes(id)
}

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
 * A sidecar-binary tool. Run by `runDeface.ts` via a Rust process
 * command: the argv template's `{input}`/`{output}` (and, for the
 * allineate variants, `{template}`/`{mask}`) placeholders are substituted,
 * the binary writes to a cache temp file, and the bytes are committed over
 * the target through an `OperationContext`. `allineate` runs `niimath`;
 * `mindgrab` runs `brainchop-mindgrab`. Both run wherever their bundled
 * binary exists.
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
   * Bundle-relative paths of the bundled-atlas inputs the argv template
   * references (`{template}`/`{mask}`). Resolved against the app's bundled
   * `resources/common/` tree before the binary runs. Absent for tools
   * whose argv references no atlas (brainchop-mindgrab is self-contained —
   * its model weights are compiled into the binary).
   */
  inputs?: {
    template: string
    mask: string
  }
  /** Sidecar entry. */
  deidEntry: DefaceDeidEntry
}

/** Tool metadata used by the executor + UI. */
export type DefaceTool = SidecarDefaceTool

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
 * Native MeshNet brain-extraction defacer (`brainchop-mindgrab`), no
 * dilation. Reads the source NIfTI and writes the skull-stripped result in
 * the input's own space (non-brain voxels floored). `-backend auto` selects
 * Metal on macOS and the threaded-CPU engine elsewhere. The model weights
 * are compiled into the binary, so there is no atlas input. Replaces the
 * former in-WebView WebGPU mindgrab (see git log).
 *
 *   brainchop-mindgrab <input> -o <output> -backend auto --border 0
 */
export const TOOL_MINDGRAB: SidecarDefaceTool = {
  kind: 'sidecar',
  id: 'mindgrab',
  label: 'mindgrab',
  description: 'Native MeshNet brain extraction (brainchop), no dilation',
  binaryBasename: 'brainchop-mindgrab',
  argv: ['{input}', '-o', '{output}', '-backend', 'auto', '--border', '0'],
  deidEntry: {
    CodingSchemeDesignator: 'BIDSvue',
    CodeValue: 'BIDSVUE-DEFACE-MINDGRAB-V1',
    CodeMeaning: 'BIDSvue mindgrab brain-extraction deface',
  },
}

/**
 * Same model as `TOOL_MINDGRAB` but grows the brain mask by an 8 mm border
 * (the binary's own `--border` distance grow, replacing the former niimath
 * `-edt` dilation pass). The wider margin keeps the cortex intact for
 * downstream intensity-homogeneity correction.
 *
 *   brainchop-mindgrab <input> -o <output> -backend auto --border 8
 */
export const TOOL_MINDGRAB8: SidecarDefaceTool = {
  kind: 'sidecar',
  id: 'mindgrab8',
  label: 'mindgrab-8mm',
  description: 'Native MeshNet brain extraction (brainchop), 8 mm mask border',
  binaryBasename: 'brainchop-mindgrab',
  argv: ['{input}', '-o', '{output}', '-backend', 'auto', '--border', '8'],
  deidEntry: {
    CodingSchemeDesignator: 'BIDSvue',
    CodeValue: 'BIDSVUE-DEFACE-MINDGRAB-DIL8-V1',
    CodeMeaning: 'BIDSvue mindgrab brain-extraction deface (8 mm border)',
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
]

export function findTool(id: DefaceToolId): DefaceTool {
  for (const t of DEFACE_TOOLS) {
    if (t.id === id) return t
  }
  // Exhaustive union check — unreachable unless a new id was added
  // without a descriptor.
  throw new Error(`findTool: unknown tool id "${id}"`)
}
