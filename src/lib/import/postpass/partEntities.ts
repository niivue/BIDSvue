// Pass 0c-part of the reproinx.py port: insert BIDS `part-mag`/`part-phase`
// (and `part-real`/`part-imag`) entities and resolve dcm2niix's
// magnitude/phase collision suffixes for func series. Mirrors
// `_resolve_part_entities` in `dcm2niix/tools/reproinx.py` (upstream commit
// `e6e9cbd`, 2026-07-15).
//
// A multi-echo BOLD acquired with phase produces magnitude + phase series
// that collide onto ONE `-f %H` stem; dcm2niix appends `a`/`b` collision
// letters (and can mislabel a phase SBRef as `_bold`), all of which are
// unusable in BIDS. This pass renames the family to
// `..._part-<mag|phase|real|imag>_<bold|sbref>`:
//
//   - `part` comes from dcm2niix's explicit `_part-` in BidsGuess (the C
//     side sets it from CSA `isHasPhase` even when public ImageType is
//     absent), falling back to DICOM `ImageType` (0008,0008). Ambiguous
//     (multiple/conflicting component tokens, e.g. a Philips
//     `_part-phase_part-mag` guess or a MAGNITUDE+PHASE ImageType) → the
//     file is left untouched: a single genuine part cannot be invented.
//   - the true `bold`/`sbref` suffix comes from BidsGuess so a phase SBRef
//     that collided into a `_bold`-named file resolves correctly.
//
// Only fires for a `(prefix, suffix)` group containing a non-magnitude
// member (a pure-magnitude group needs no `part` entity). A bold/sbref
// file whose part or suffix cannot be inferred TAINTS its whole prefix, so
// no firing group at that prefix is partially resolved — we leave the
// collision names for the `.bidsignore` sweep rather than emit an
// inconsistent `_bold` + `_part-phase_bold` pair.
//
// Each group is finalized ATOMICALLY and INDEPENDENTLY (its moves + its
// phase `Units` write in one failure boundary), processed one at a time so
// a later group's failure can't strip an earlier group's metadata. A
// mid-group failure that rolls back cleanly is an isolated NON-fatal skip;
// only a FAILED rollback — a torn family — throws `PartEntitiesIntegrityError`
// (see below). Runs INSIDE the bidsguessCleanup session loop, AFTER the
// 3D-bold demote and BEFORE the single-volume-DWI sweep — matching the
// Python insertion point, and BEFORE Pass 0d (`dupNaming`) so a group this
// pass resolves is skipped there rather than renamed to `__dup-NN`.
//
// Siemens phase sidecars get `Units: "arbitrary"` (BIDS requires Units on
// phase data; Siemens phase is scanner-scaled, not radians). Never
// overwrites an existing Units, and is idempotent across reruns.

import type { OperationContext } from '$lib/mutate/backup'
import { parseSidecar, serializeSidecar } from '$lib/sidecar/parse'
import { STEM_FAMILY_EXTS, anyStemFileExists, seriesStem } from './bidsExts'
import type { PostPassFs } from './fs'
import {
  PostPassIntegrityError,
  StemFamilyIntegrityError,
  moveStemFiles,
} from './moveStem'

export interface PartEntitiesResult {
  /** Number of file stems renamed to carry a `_part-<x>` entity. */
  renamed: number
}

// Recognised BIDS `part` labels, in the ImageType token → label mapping
// order. `mag` is the "no part needed on its own" default.
const IMAGETYPE_PART: ReadonlyArray<readonly [string, string]> = [
  ['PHASE', 'phase'],
  ['MAGNITUDE', 'mag'],
  ['REAL', 'real'],
  ['IMAGINARY', 'imag'],
]

// Lookahead on the trailing boundary so a shared `_` between two component
// tokens (a genuinely ambiguous multi-part guess) is NOT consumed — both
// matches are then seen and the guess is correctly rejected as ambiguous.
const BIDSGUESS_PART_RE = /_part-(mag|phase|real|imag)(?=_|$)/g

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * BIDS `part` from DICOM ImageType (0008,0008). Returns null when absent
 * or ambiguous (more than one component token, e.g. Philips
 * MAGNITUDE+PHASE on one series).
 */
export function partFromImageType(
  data: Record<string, unknown>,
): string | null {
  const it = data.ImageType
  if (!Array.isArray(it)) return null
  const toks = new Set(it.map((x) => String(x).toUpperCase()))
  const found = IMAGETYPE_PART.filter(([key]) => toks.has(key)).map(
    ([, part]) => part,
  )
  return found.length === 1 ? found[0] : null
}

/**
 * BIDS `part`. Prefers dcm2niix's explicit `_part-<x>` in BidsGuess[1]
 * (set from CSA `isHasPhase` even when public ImageType is absent), else
 * derives from ImageType. Null if ambiguous (multiple/conflicting
 * component indications) — a genuine single part cannot be invented, so
 * the file is left untouched.
 */
export function partOf(data: Record<string, unknown>): string | null {
  const g = data.BidsGuess
  if (Array.isArray(g) && g.length === 2 && typeof g[1] === 'string') {
    const ms = g[1].match(BIDSGUESS_PART_RE)
    if (ms && ms.length === 1) {
      // Extract the label from the single `_part-<label>` match.
      const m = /_part-(mag|phase|real|imag)/.exec(ms[0])
      if (m) return m[1]
    }
    if (ms && ms.length > 1) return null
  }
  return partFromImageType(data)
}

/**
 * `bold`/`sbref`, preferring BidsGuess[1]'s trailing token (a phase SBRef
 * can collide into a `_bold`-named file), else the filename token minus
 * its collision letter. Null when neither yields a func suffix.
 */
function funcSuffix(
  data: Record<string, unknown>,
  token: string,
): string | null {
  const g = data.BidsGuess
  if (Array.isArray(g) && g.length === 2 && typeof g[1] === 'string') {
    const last = g[1].slice(g[1].lastIndexOf('_') + 1)
    if (last === 'bold' || last === 'sbref') return last
  }
  if (token.startsWith('sbref')) return 'sbref'
  if (token.startsWith('bold')) return 'bold'
  return null
}

/**
 * Thrown when a group's moves fail AND the compensating rollback also
 * fails, leaving a torn old/new family that the pass cannot restore. This
 * is an integrity violation of the all-or-nothing contract — unlike an
 * ordinary classification/skip failure (which `bidsguessCleanup` records as
 * a non-fatal warning), this MUST reach `runImport`'s fatal cleanup path so
 * the whole import operation is rolled back rather than committing a torn
 * dataset. `bidsguessCleanup` and `runPostPass` re-throw it instead of
 * downgrading it.
 */
export class PartEntitiesIntegrityError extends PostPassIntegrityError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PartEntitiesIntegrityError'
  }
}

/**
 * Write BIDS-required `Units: "arbitrary"` onto a just-resolved Siemens
 * phase sidecar (scanner-scaled phase, not radians). No-op when the file is
 * absent, unparseable, already carries a `Units`, or isn't Siemens. Called
 * INSIDE the group's failure boundary so a write failure rolls the group's
 * moves back rather than committing a `_part-phase_*` family without its
 * required metadata. Idempotent (skips when `Units` already present), so a
 * rerun repairs a group whose earlier Units write failed. A `readTextFile`
 * / `writeText` FS failure propagates (the caller compensates); only a
 * malformed-sidecar parse is swallowed (a data problem, not an integrity
 * one).
 */
async function writePhaseUnits(
  jsonPath: string,
  sessionDir: string,
  ctx: OperationContext,
  fs: PostPassFs,
): Promise<void> {
  if (!(await fs.exists(jsonPath))) return
  const text = await fs.readTextFile(jsonPath)
  let parsed: ReturnType<typeof parseSidecar>
  try {
    parsed = parseSidecar(text)
  } catch {
    return
  }
  const value = parsed.value
  if (!isRecord(value)) return
  if ('Units' in value) return
  if (
    !String(value.Manufacturer ?? '')
      .toLowerCase()
      .startsWith('siemens')
  )
    return
  ;(value as Record<string, unknown>).Units = 'arbitrary'
  await ctx.writeText(jsonPath, serializeSidecar(value, parsed.format), {
    kind: 'post-pass-part-entities-units',
    sessionDir,
    path: jsonPath,
  })
}

/**
 * Resolve func `part-` entities under `<sessionDir>/func/`. Returns the
 * number of stems renamed. No-op when there is no `func/` dir or no
 * multi-part collision group.
 *
 * Each group is finalized ATOMICALLY and INDEPENDENTLY: its moves and its
 * required phase `Units` write happen in one failure boundary, and groups
 * are processed one at a time so a later group's failure can never strip an
 * earlier group's metadata or un-count it. An isolated group failure that
 * rolls back cleanly is non-fatal (skipped). Only a FAILED rollback — a
 * torn family — throws `PartEntitiesIntegrityError`, which propagates to
 * `runImport`'s fatal cleanup so the whole import is rolled back rather than
 * committing a torn dataset.
 */
export async function resolvePartEntities(
  sessionDir: string,
  ctx: OperationContext,
  fs: PostPassFs,
): Promise<PartEntitiesResult> {
  const funcDir = `${sessionDir}/func`
  if (!(await fs.exists(funcDir))) return { renamed: 0 }

  let entries: Awaited<ReturnType<PostPassFs['readDir']>>
  try {
    entries = await fs.readDir(funcDir)
  } catch {
    return { renamed: 0 }
  }
  const jsonNames = entries
    .filter((e) => e.isFile && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort()

  // Group by (prefix, suffix). A member whose part or suffix is
  // unclassifiable taints its whole prefix so no group there fires.
  const groups = new Map<string, Array<{ stem: string; part: string }>>()
  const unresolvedPrefixes = new Set<string>()
  for (const name of jsonNames) {
    const stem = name.slice(0, -'.json'.length)
    const cut = stem.lastIndexOf('_')
    const token = cut >= 0 ? stem.slice(cut + 1) : ''
    const entities = cut >= 0 ? stem.slice(0, cut) : stem
    if (!(token.startsWith('bold') || token.startsWith('sbref'))) continue
    const prefix = entities.replace(/_part-[A-Za-z0-9]+$/, '')
    let data: unknown = null
    try {
      data = JSON.parse(await fs.readTextFile(`${funcDir}/${name}`))
    } catch {
      data = null
    }
    const part = isRecord(data) ? partOf(data) : null
    const suffix = isRecord(data) ? funcSuffix(data, token) : null
    if (part === null || suffix === null) {
      unresolvedPrefixes.add(prefix)
      continue
    }
    // Python keys the group on a native `(prefix, suffix)` tuple; JS Maps
    // can't key on a tuple by value, so pack into a string with a NUL
    // separator (a filename stem can never contain NUL; a space could in
    // theory, so do not split on one).
    const key = `${prefix}\u0000${suffix}`
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [{ stem, part }])
    else bucket.push({ stem, part })
  }

  // Orphan-base guard: a func NIfTI DATA file (`*_bold*` / `*_sbref*`,
  // incl. the unsuffixed base with no collision letter) whose `.json` is
  // absent is unclassifiable — and, unlike a letter-suffixed collision
  // file, the unsuffixed `_bold.nii.gz` is NOT caught by the `.bidsignore`
  // collision sweep. So a bare magnitude `_bold.nii.gz` missing its JSON,
  // beside a classifiable `_bolda` phase, would let phase resolve alone and
  // leave a mixed `_part-phase_bold` + bare `_bold` family. Taint the prefix
  // of any such JSON-less data file so the whole family refuses to fire.
  const jsonStems = new Set(jsonNames.map((n) => n.slice(0, -'.json'.length)))
  for (const e of entries) {
    if (!e.isFile) continue
    if (!(e.name.endsWith('.nii') || e.name.endsWith('.nii.gz'))) continue
    const dataStem = seriesStem(e.name)
    if (jsonStems.has(dataStem)) continue // has a sidecar → already handled above
    const cut = dataStem.lastIndexOf('_')
    const token = cut >= 0 ? dataStem.slice(cut + 1) : ''
    if (!(token.startsWith('bold') || token.startsWith('sbref'))) continue
    const entities = cut >= 0 ? dataStem.slice(0, cut) : dataStem
    unresolvedPrefixes.add(entities.replace(/_part-[A-Za-z0-9]+$/, ''))
  }

  let renamed = 0
  for (const [key, members] of groups) {
    const sep = key.indexOf('\u0000')
    const prefix = key.slice(0, sep)
    const suffix = key.slice(sep + 1)
    if (unresolvedPrefixes.has(prefix)) {
      console.warn(
        `[partEntities] skipping ${prefix} — unclassifiable sibling in family`,
      )
      continue
    }
    // No phase/real/imag sibling → a bare magnitude series doesn't need
    // a part entity.
    if (members.every((m) => m.part === 'mag')) continue

    // Preflight the whole group against the full BIDS family before any
    // move, so a collision aborts the group cleanly.
    const plan: Array<{ stem: string; dst: string }> = []
    const dsts = new Set<string>()
    let conflict = false
    for (const { stem, part } of members) {
      const dst = `${prefix}_part-${part}_${suffix}`
      if (dst === stem) continue
      if (
        dsts.has(dst) ||
        (await anyStemFileExists(funcDir, dst, STEM_FAMILY_EXTS, fs.exists))
      ) {
        conflict = true
        break
      }
      dsts.add(dst)
      plan.push({ stem, dst })
    }
    if (conflict) {
      console.warn(
        `[partEntities] skipping ${prefix}_${suffix} — target collision`,
      )
      continue
    }

    // Finalize this group in ONE failure boundary: apply its moves AND its
    // required phase `Units` write together. Groups are independent and
    // processed one at a time, so a failure here can never strip an earlier
    // group's metadata or un-count it. The phase `Units` write lives in the
    // SAME try as the moves so a write failure rolls the moves back rather
    // than committing a `_part-phase_*` family without required metadata.
    const done: Array<{ stem: string; dst: string }> = []
    try {
      for (const { stem, dst } of plan) {
        const moved = await moveStemFiles({
          srcStem: `${funcDir}/${stem}`,
          dstStem: `${funcDir}/${dst}`,
          ctx,
          fs,
          meta: { kind: 'post-pass-part-entities', sessionDir, stem, dst },
        })
        if (moved > 0) done.push({ stem, dst })
      }
      // Phase Units in the same boundary. Collected for the group whether or
      // not a move happened (empty plan on a rerun) so an already-canonical
      // phase file still gets/keeps its Units — idempotent.
      if (members.some((m) => m.part === 'phase')) {
        await writePhaseUnits(
          `${funcDir}/${prefix}_part-phase_${suffix}.json`,
          sessionDir,
          ctx,
          fs,
        )
      }
    } catch (err) {
      // Compensate: reverse this group's applied moves so the family is not
      // left torn. A clean rollback is an isolated, NON-fatal failure — skip
      // this group and keep earlier groups finalized + counted. A FAILED
      // rollback leaves a torn family and escalates to a fatal integrity
      // error so `runImport` rolls back the whole import.
      let rollbackOk = !(err instanceof StemFamilyIntegrityError)
      for (let i = done.length - 1; i >= 0; i--) {
        const { stem, dst } = done[i]
        try {
          await moveStemFiles({
            srcStem: `${funcDir}/${dst}`,
            dstStem: `${funcDir}/${stem}`,
            ctx,
            fs,
            meta: {
              kind: 'post-pass-part-entities',
              sessionDir,
              rollbackOf: 'resolvePartEntities',
            },
          })
        } catch (rollbackErr) {
          rollbackOk = false
          console.warn(
            `[partEntities] rollback failed for "${dst}" → "${stem}": ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
          )
        }
      }
      if (!rollbackOk) {
        throw new PartEntitiesIntegrityError(
          `torn func part-entity family in ${funcDir} (group ${prefix}_${suffix}); rollback incomplete`,
          { cause: err },
        )
      }
      console.warn(
        `[partEntities] skipping ${prefix}_${suffix} — group finalization failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`,
      )
      continue
    }
    renamed += done.length
  }

  return { renamed }
}
