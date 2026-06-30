/**
 * BIDS suffix → brainlife datatype-name mapping.
 *
 * Brainlife datatypes follow a `neuro/<modality>/<kind>` path (see
 * `loadDatatypeCatalog` for the full server-side list). We keep a
 * small hand-curated map for the BIDS suffixes M4 covers and look
 * everything else up via the cached catalog at upload time. The
 * locked decision (cloudshare_goal.md §"Decision log" #1) is to
 * port brainlife/cli's behavior in shape; the CLI hard-codes the
 * same handful of mappings in `bids-walker.js`.
 *
 * Returning `null` from `brainlifeDatatypeFor` lets the upload
 * pipeline skip files we can't classify (e.g. random non-BIDS
 * extras) rather than failing the whole upload.
 */

import type { FileNode } from '$lib/bids/types'

/** Path used in brainlife's warehouse `/datatype?find={name:…}` query. */
export type BrainlifeDatatypeName = string

const SUFFIX_MAP: ReadonlyMap<string, BrainlifeDatatypeName> = new Map([
  // Anat
  ['T1w', 'neuro/anat/t1w'],
  ['T2w', 'neuro/anat/t2w'],
  ['FLAIR', 'neuro/anat/flair'],
  ['T2star', 'neuro/anat/t2star'],
  // Func — `bold` is the only standalone primary brainlife treats
  // as a func/task dataset. `sbref` is a *companion* of bold per
  // `bids-walker.js#handle_func` (`files["sbref.nii.gz"] = ...`),
  // not its own datatype. We used to register `sbref` as a primary,
  // which made brainlife reject the upload with "required file is
  // missing: bold.nii.gz". Now sbref candidates are skipped (and
  // ride along with their paired bold scan when both share a BIDS
  // group).
  ['bold', 'neuro/func/task'],
  // DWI
  ['dwi', 'neuro/dwi'],
  // Fmap is intentionally absent.
  //
  // Brainlife's `neuro/fmap` has four subtypes (single / phasediff /
  // 2phasemag / pepolar) each requiring a specific bundle of
  // companion files. The CLI's `handle_fmap_*` family decomposes
  // this; we haven't ported that yet. Until we do, fmap candidates
  // would hit brainlife's "FileNotFoundError" or "required file
  // missing" rejections. ROADMAP.md "Cloud share — open follow-ups"
  // tracks this; users can upload fmaps via brainlife.io's web UI
  // in the meantime.
  // M/EEG
  ['meg', 'neuro/meg/ctf'],
  ['eeg', 'neuro/eeg/raw'],
  ['ieeg', 'neuro/eeg/ieeg'],
  // PET
  ['pet', 'neuro/pet'],
])

/**
 * Resolve the brainlife datatype name for a given BIDS suffix.
 * Returns `null` when the suffix isn't supported in M4 — callers
 * skip the file (rather than failing the upload) and log it so the
 * user knows we left it on the floor. A wider table lands as
 * follow-up once we have real testers asking for specific
 * modalities.
 */
export function brainlifeDatatypeFor(
  suffix: string,
): BrainlifeDatatypeName | null {
  return SUFFIX_MAP.get(suffix) ?? null
}

/**
 * BIDS-suffix → brainlife-archive-basename mapping for the *primary*
 * data file. brainlife unpacks each upload tar into a flat directory
 * and looks for canonical filenames inside (e.g. `t1.nii.gz`,
 * `bold.nii.gz`) — the BIDS-style `sub-01_T1w.nii.gz` it shipped
 * doesn't satisfy the datatype's required-files list, which is what
 * the "required file is missing" failures on brainlife.io tell us.
 *
 * Verbatim from the CLI's `bids-walker.js#handle_anat_t1` /
 * `handle_func` / `handle_dwi` / etc.
 */
const PRIMARY_ARCHIVE_BASENAME: ReadonlyMap<string, string> = new Map([
  ['T1w', 't1'],
  ['T2w', 't2'],
  ['FLAIR', 'flair'],
  ['T2star', 't2star'],
  ['bold', 'bold'],
  ['dwi', 'dwi'],
  // fmap + sbref intentionally omitted — see SUFFIX_MAP comment.
  ['meg', 'meg'],
  ['eeg', 'eeg'],
  ['ieeg', 'ieeg'],
  ['pet', 'pet'],
])

/** Return the canonical brainlife filename for a BIDS suffix's
 * primary data file (e.g. `T1w` → `t1.nii.gz`). The caller passes
 * the extension because brainlife keeps the original extension
 * (`.nii.gz` / `.edf` / `.ds`). Returns `null` for suffixes the
 * map doesn't cover. */
export function primaryArchiveName(
  suffix: string,
  extension: string,
): string | null {
  const base = PRIMARY_ARCHIVE_BASENAME.get(suffix)
  if (base === undefined) return null
  return `${base}${extension}`
}

/**
 * Return the brainlife archive name for a BIDS *companion* file
 * (events.tsv / *_dwi.bvec / *_sbref.json / *_physio.tsv.gz / …).
 * Returns `null` when the file isn't a brainlife-tracked companion
 * for that datatype — the orchestrator drops those silently rather
 * than uploading garbage brainlife will reject.
 *
 * Special renames per `bids-walker.js`:
 *   - `.bvec` → `.bvecs` (with trailing `s`)
 *   - `.bval` → `.bvals`
 *   - `<X>_events.tsv` → `events.tsv`
 *   - `<X>_sbref.<ext>` → `sbref.<ext>`
 *   - `<X>_physio.<ext>` → `physio.<ext>`
 */
export function companionArchiveName(
  primarySuffix: string,
  companionSuffix: string,
  companionExtension: string,
): string | null {
  if (companionExtension === '.bvec')
    return `${primarySuffix === 'dwi' ? 'dwi' : primarySuffix}.bvecs`
  if (companionExtension === '.bval')
    return `${primarySuffix === 'dwi' ? 'dwi' : primarySuffix}.bvals`
  if (companionSuffix === 'events' && companionExtension === '.tsv') {
    return 'events.tsv'
  }
  if (companionSuffix === 'sbref') return `sbref${companionExtension}`
  if (companionSuffix === 'physio') return `physio${companionExtension}`
  return null
}

/** Convert BIDS entities to the brainlife `meta` shape. The CLI
 * stores entities under `meta.subject`, `meta.session`, then the
 * per-entity short names (`task`, `acq`, `run`, …). See
 * `bl-bids-upload.js` for the verbatim entity allowlist; we mirror
 * it here. */
export function buildBrainlifeMeta(file: FileNode): Record<string, unknown> {
  const e = file.entities
  const meta: Record<string, unknown> = {}
  if (e.sub !== undefined) meta.subject = e.sub
  if (e.ses !== undefined) meta.session = e.ses
  // The CLI's whitelist of "BIDS entities that make this object unique".
  const passthrough: Array<keyof typeof e> = [
    'task',
    'acq',
    'ce',
    'rec',
    'dir',
    'run',
    'mod',
    'echo',
    'flip',
    'inv',
    'mt',
    'part',
    'recording',
    'proc',
    'split',
  ]
  for (const key of passthrough) {
    if (e[key] !== undefined) meta[key] = e[key]
  }
  return meta
}

/**
 * Stable per-dataset description string. Used as the `itemkey.desc`
 * sent to brainlife so two uploads from the same BIDSvue scan
 * collapse onto the same warehouse object on the brainlife side.
 * The CLI does the same thing in `bl-bids-upload.js`.
 *
 * Shape: `<suffix> for <subject>[ ses-<ses>][ entities...]`
 */
export function buildBrainlifeDesc(file: FileNode): string {
  const e = file.entities
  const parts: string[] = [file.suffix]
  if (e.sub !== undefined) parts.push(`sub-${e.sub}`)
  if (e.ses !== undefined) parts.push(`ses-${e.ses}`)
  if (e.task !== undefined) parts.push(`task-${e.task}`)
  if (e.run !== undefined) parts.push(`run-${e.run}`)
  if (e.acq !== undefined) parts.push(`acq-${e.acq}`)
  return parts.join(' ')
}
