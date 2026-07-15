// Pass 0d of the reproinx.py port: rename dcm2niix's `a`/`b`/`c`
// collision suffix to heudiconv's canonical `__dup-NN`. Mirrors
// `_apply_dup_naming` in `dcm2niix/tools/reproinx.py`.
//
// dcm2niix's default name-conflict mode appends `a`,`b`,`c`,… to
// subsequent series that hash to the same BIDS filename, in write
// order. Heudiconv instead emits `__dup-01`,`__dup-02`,… with the
// **lowest** SeriesNumber owning the unsuffixed base. The `.reproin_
// provenance.tsv` carries SeriesNumber and the as-written OutputStem,
// so we can reorder deterministically without re-reading DICOMs.
//
// Safety rails:
//   - A stem is only treated as a collision sibling of `base` when both
//     rows refer to the SAME source series (matching StudyInstanceUID +
//     ProtocolName + SeriesDescription). Without this, legitimate
//     labels ending in a single lowercase letter (e.g. `acq-X_T1w` with
//     a 1-char `X`) get falsely grouped.
//   - Stale or partial groups (the dcm2niix files for one member are
//     missing) abort the rename for the whole group rather than risk a
//     mid-group overwrite.
//   - Two-phase tmp-stem rename prevents an ordering-dependent collision
//     when the lowest-SeriesNumber row currently sits on the `_a`
//     suffix and needs to move to the bare base.

import type { OperationContext } from '$lib/mutate/backup'
import { STEM_FAMILY_EXTS, anyStemFileExists } from './bidsExts'
import type { PostPassFs } from './fs'
import {
  StemFileExistsError,
  moveStemFiles as moveStemFamily,
} from './moveStem'
import { type ProvenanceRow, loadProvenance } from './provenance'

export interface DupNamingResult {
  /** Number of file-stem groups successfully renamed. */
  renamed: number
  /** Number of groups skipped (missing files / partial state / already at target). */
  skipped: number
}

/**
 * Walk the provenance TSV's OutputStem column and rename every
 * `<base><a|b|c|...>` sibling to `<base>__dup-NN`, ordered by ascending
 * SeriesNumber. Returns counts. No-op when no collision sibling group
 * exists.
 *
 * `preloadedProv` lets the orchestrator amortise the TSV read across
 * roots; passing `undefined` makes the function load the file itself.
 */
export async function runDupNaming(
  bidsRoot: string,
  ctx: OperationContext,
  fs: PostPassFs,
  preloadedProv?: ReadonlyArray<ProvenanceRow>,
): Promise<DupNamingResult> {
  const result: DupNamingResult = { renamed: 0, skipped: 0 }
  const prov = preloadedProv ?? (await loadProvenance(bidsRoot, fs))
  if (prov.length === 0) return result

  // Index by OutputStem; first row wins on duplicate stems.
  const byStem = new Map<string, ProvenanceRow>()
  for (const r of prov) {
    if (r.OutputStem.length > 0 && !byStem.has(r.OutputStem)) {
      byStem.set(r.OutputStem, r)
    }
  }

  // Build the collision groups in one pass: for any stem ending in a
  // single lowercase letter whose base also appears in the TSV AND
  // refers to the same source series, seed the group with the base
  // row on first sibling discovery, then push each subsequent suffix
  // sibling. (Audit 2026-06-04 refactor #7 — the prior implementation
  // ran two loops, the second only to push the base row.)
  const groups = new Map<string, ProvenanceRow[]>()
  for (const [stem, row] of byStem) {
    if (stem.length < 2) continue
    const last = stem.charAt(stem.length - 1)
    if (!(last >= 'a' && last <= 'z')) continue
    const base = stem.slice(0, stem.length - 1)
    const baseRow = byStem.get(base)
    if (baseRow === undefined) continue
    if (!sameSeries(row, baseRow)) continue
    const existing = groups.get(base)
    if (existing === undefined) groups.set(base, [baseRow, row])
    else existing.push(row)
  }

  for (const [base, members] of groups) {
    const ordered = [...members].sort((a, b) => a.SeriesNumber - b.SeriesNumber)
    const targets = ordered.map((_, idx) =>
      idx === 0 ? base : `${base}__dup-${idx.toString().padStart(2, '0')}`,
    )
    // If every target stem already exists on disk, this group has
    // already been renamed by a prior run — skip silently.
    let allTargetsPresent = true
    for (const t of targets) {
      if (!(await stemHasFiles(bidsRoot, t, fs))) {
        allTargetsPresent = false
        break
      }
    }
    if (allTargetsPresent) {
      result.skipped++
      continue
    }

    // Build moves (current → target); drop entries already at their
    // target. Then preflight: every source must exist, no target may
    // pre-exist unless it's also being renamed away.
    const moves: Array<{ current: string; target: string }> = []
    for (let idx = 0; idx < ordered.length; idx++) {
      const current = ordered[idx].OutputStem
      const target = targets[idx]
      if (current !== target) moves.push({ current, target })
    }
    if (moves.length === 0) {
      result.skipped++
      continue
    }
    // If NONE of the group's as-written members (the unsuffixed base plus
    // its suffixed siblings) still exist on disk, an earlier pass already
    // consumed this group — e.g. `resolvePartEntities` renamed the
    // magnitude/phase members to `_part-<x>` names. Skip silently rather
    // than fall through to the "stale or partial group" warning below.
    // Mirrors the `not any(_stem_has_files ...)` guard added upstream in
    // `e6e9cbd`.
    let anyAsWritten = false
    for (const o of ordered) {
      if (await stemHasFiles(bidsRoot, o.OutputStem, fs)) {
        anyAsWritten = true
        break
      }
    }
    if (!anyAsWritten) {
      result.skipped++
      continue
    }
    const currentSet = new Set(moves.map((m) => m.current))
    let unsafe = false
    for (const { current, target } of moves) {
      if (!(await stemHasFiles(bidsRoot, current, fs))) {
        unsafe = true
        break
      }
      if (
        (await stemHasFiles(bidsRoot, target, fs)) &&
        !currentSet.has(target)
      ) {
        unsafe = true
        break
      }
    }
    // A member already at its target (the unsuffixed base, omitted from
    // `moves`) must still have files; if the base is gone while a suffixed
    // sibling survives, the rename would leave a base-less `__dup` family.
    // Validate it (upstream `e6e9cbd`).
    if (!unsafe) {
      for (let idx = 0; idx < ordered.length; idx++) {
        const current = ordered[idx].OutputStem
        const target = targets[idx]
        if (current === target && !(await stemHasFiles(bidsRoot, target, fs))) {
          unsafe = true
          break
        }
      }
    }
    if (unsafe) {
      console.warn(`[dupNaming] skipping stale or partial group "${base}"`)
      result.skipped++
      continue
    }

    // Two-phase rename via tmp stems so an ordering-dependent
    // overwrite is impossible (e.g. lowest SeriesNumber currently at
    // `_a` needs to move to bare base). Each per-phase move goes
    // through the shared `moveStemFiles` primitive so each family
    // (the .nii.gz + .json + .bval + .bvec siblings) is renamed
    // all-or-nothing — external audit 2026-06-20 P2#1 closed by
    // replacing a per-extension loop that lacked rollback.
    //
    // **Pre-phase preflight**: stale `__reproinx-tmp-NNN` from a
    // prior aborted run would collide with phase 1's tmp targets.
    // The shared primitive's `StemFileExistsError` is the surface for
    // this; we catch it per-phase and skip the whole group. The
    // existing `unsafe` check above also catches stale final targets
    // before we begin.
    const tmpStems = new Map<string, string>()
    const tmpFor = (i: number): string =>
      `${base}__reproinx-tmp-${i.toString().padStart(3, '0')}`
    // Preflight every tmp slot AND every final target so a collision
    // is detected before phase 1 mutates anything.
    let tmpOrTargetCollision = false
    for (let i = 0; i < moves.length; i++) {
      const tmp = tmpFor(i)
      if (await stemHasFiles(bidsRoot, tmp, fs)) {
        tmpOrTargetCollision = true
        break
      }
    }
    if (tmpOrTargetCollision) {
      console.warn(
        `[dupNaming] stale __reproinx-tmp-* stems for group "${base}" — skipping`,
      )
      result.skipped++
      continue
    }

    let renamedThisGroup = false
    try {
      // Phase 1: each `current` family → its tmp slot.
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i]
        const tmp = tmpFor(i)
        const moved = await moveStemFamily({
          srcStem: `${bidsRoot}/${m.current}`,
          dstStem: `${bidsRoot}/${tmp}`,
          ctx,
          fs,
          meta: {
            kind: 'post-pass-dup-naming-phase1',
            bidsRoot,
            current: m.current,
            tmp,
          },
        })
        if (moved > 0) tmpStems.set(m.current, tmp)
      }
      // Phase 2: each tmp family → its final target.
      for (const m of moves) {
        const tmp = tmpStems.get(m.current)
        if (tmp === undefined) continue
        const moved = await moveStemFamily({
          srcStem: `${bidsRoot}/${tmp}`,
          dstStem: `${bidsRoot}/${m.target}`,
          ctx,
          fs,
          meta: {
            kind: 'post-pass-dup-naming-phase2',
            bidsRoot,
            tmp,
            target: m.target,
          },
        })
        if (moved > 0) renamedThisGroup = true
      }
    } catch (err) {
      if (err instanceof StemFileExistsError) {
        // Either a phase-1 tmp collided (stale tmp from earlier run
        // squeezed through the preflight by appearing between the
        // probe and the move) or a phase-2 final target was created
        // by a curated edit mid-pass. Skip cleanly; any partial
        // tmp-state will trip the preflight on the next run.
        console.warn(
          `[dupNaming] family-move collision in group "${base}" — skipping: ${err.destPath}`,
        )
        result.skipped++
        continue
      }
      throw err
    }
    if (renamedThisGroup) result.renamed++
    else result.skipped++
  }
  return result
}

function sameSeries(a: ProvenanceRow, b: ProvenanceRow): boolean {
  return (
    a.StudyInstanceUID === b.StudyInstanceUID &&
    a.ProtocolName === b.ProtocolName &&
    a.SeriesDescription === b.SeriesDescription
  )
}

async function stemHasFiles(
  bidsRoot: string,
  stem: string,
  fs: PostPassFs,
): Promise<boolean> {
  return anyStemFileExists(bidsRoot, stem, STEM_FAMILY_EXTS, fs.exists)
}
