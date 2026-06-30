// Pure subject/session collision detection + renumber mapping
// (Merge design history in git log §6). Walks donors in array order, maintaining a
// cumulative "recipient-as-grown" set so donor B can collide with a
// label donor A already claimed. Produces the resolved subject map,
// any unresolved collisions (ask), and the renumber records.

import type { Dataset } from '$lib/bids/types'
import type {
  Collision,
  MergeInputs,
  MergePolicy,
  MergeResolutions,
  RenumberRec,
  SubjectMapRow,
  TokenRemap,
} from './types'

/**
 * Subject label -> set of session labels. A subject with at least one
 * sessionless file contributes the empty-string marker '' so callers
 * can tell sessionless apart from "has sessions". Derived from file
 * entities in the scanned index (bySubject buckets).
 */
export function subjectSessions(dataset: Dataset): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const [sub, files] of dataset.index.bySubject) {
    const sessions = out.get(sub) ?? new Set<string>()
    for (const f of files) {
      sessions.add(f.entities.ses ?? '')
    }
    out.set(sub, sessions)
  }
  return out
}

/**
 * Lowest unused label. Numeric labels get the smallest unused positive
 * integer zero-padded to `width`; a non-numeric base gets a numeric
 * suffix. ponytail: covers the BIDS-typical `01,02,…` case; exotic
 * label schemes fall back to base+N.
 */
function nextFreeLabel(
  base: string,
  taken: Set<string>,
  width: number,
): string {
  if (/^\d+$/.test(base)) {
    for (let n = 1; ; n++) {
      const candidate = String(n).padStart(width, '0')
      if (!taken.has(candidate)) return candidate
    }
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`
    if (!taken.has(candidate)) return candidate
  }
}

export interface SubjectPlanResult {
  rows: SubjectMapRow[]
  collisions: Collision[]
  renumbers: RenumberRec[]
}

/**
 * Resolve every donor subject to a recipient destination. Deterministic
 * in donor array order. An `ask` policy with no matching resolution
 * leaves the collision unresolved (blocks the plan). A sessionless
 * same-person fold is refused (Merge design history in git log §6.3).
 */
export function planSubjectMap(
  inputs: MergeInputs,
  policy: MergePolicy,
  resolutions: MergeResolutions,
): SubjectPlanResult {
  const rows: SubjectMapRow[] = []
  const collisions: Collision[] = []
  const renumbers: RenumberRec[] = []

  const recipientSessions = subjectSessions(inputs.recipient)
  // Recipient-as-grown: subject label -> session set. Seeded from the
  // recipient, extended as donors add subjects / fold sessions.
  const grown = new Map<string, Set<string>>()
  for (const [sub, ses] of recipientSessions) grown.set(sub, new Set(ses))

  inputs.donors.forEach((donor, donorIndex) => {
    const donorSessions = subjectSessions(donor.dataset)
    // Sort donor subjects for deterministic renumber assignment.
    for (const donorSubject of [...donorSessions.keys()].sort()) {
      const dSessions = donorSessions.get(donorSubject) ?? new Set<string>()

      if (!grown.has(donorSubject)) {
        // No collision — copy verbatim.
        rows.push({
          donorIndex,
          donorSubject,
          recipientSubject: donorSubject,
          action: 'copy-new',
          sessionRemaps: [],
          sessionsFoldedIn: 0,
          evidence: 'new subject',
        })
        grown.set(donorSubject, new Set(dSessions))
        continue
      }

      // Collision. Resolve via explicit resolution, else the batch
      // policy, else leave it for the preview.
      const key = `${donorIndex}:${donorSubject}`
      const decision =
        resolutions.subject[key] ??
        (policy.subjectCollision === 'ask'
          ? undefined
          : policy.subjectCollision)

      if (decision === undefined) {
        collisions.push({
          kind: 'subject',
          donorIndex,
          donorSubject,
          detail: `sub-${donorSubject} already exists in the recipient — choose distinct (renumber) or same (fold sessions).`,
        })
        continue
      }

      if (decision === 'distinct') {
        const assigned = nextFreeLabel(
          donorSubject,
          new Set(grown.keys()),
          donorSubject.length,
        )
        rows.push({
          donorIndex,
          donorSubject,
          recipientSubject: assigned,
          action: 'renumber',
          sessionRemaps: [],
          sessionsFoldedIn: 0,
          evidence: `renumbered (sub-${donorSubject} taken)`,
        })
        renumbers.push({ donorIndex, donorSubject, assignedSubject: assigned })
        grown.set(assigned, new Set(dSessions))
        continue
      }

      // decision === 'same' — fold donor sessions into the existing subject.
      // Refuse unless BOTH sides are fully sessioned. If EITHER carries a
      // sessionless file (`ses === ''` present), folding would produce a
      // subject mixing `ses-*/` dirs with sessionless files — which BIDS
      // doesn't permit and which has no non-destructive resolution in v1
      // (auto-promoting into sessions is a v2 option). Covers both-
      // sessionless AND mixed-sides (audit 2026-06-28 P2.7).
      const recipientSubjectSessions = grown.get(donorSubject) ?? new Set()
      if (recipientSubjectSessions.has('') || dSessions.has('')) {
        collisions.push({
          kind: 'subject',
          donorIndex,
          donorSubject,
          detail: `Cannot fold sub-${donorSubject}: a fold requires both subjects to have explicit sessions (one side has sessionless files). Add sessions first, or resolve as distinct.`,
        })
        continue
      }

      const { remaps: sessionRemaps, added: sessionsFoldedIn } = foldSessions(
        donorIndex,
        donorSubject,
        dSessions,
        recipientSubjectSessions,
        policy,
        resolutions,
        collisions,
      )
      rows.push({
        donorIndex,
        donorSubject,
        recipientSubject: donorSubject,
        action: 'fold',
        sessionRemaps,
        sessionsFoldedIn,
        evidence: 'folded into existing subject',
      })
    }
  })

  return { rows, collisions, renumbers }
}

/**
 * Decide each donor session's destination within a same-person fold.
 * New sessions copy verbatim; colliding sessions renumber (default) or
 * raise an ask. Mutates `grown` sessions + appends to `collisions`.
 * Returns the session label swaps AND the count of donor sessions
 * actually folded in (verbatim-new + renumbered) for the summary.
 */
function foldSessions(
  donorIndex: number,
  donorSubject: string,
  donorSessions: Set<string>,
  recipientSessions: Set<string>,
  policy: MergePolicy,
  resolutions: MergeResolutions,
  collisions: Collision[],
): { remaps: TokenRemap[]; added: number } {
  const remaps: TokenRemap[] = []
  let added = 0
  for (const ses of [...donorSessions].sort()) {
    if (ses === '') continue // sessionless file in an otherwise-sessioned subject
    if (!recipientSessions.has(ses)) {
      recipientSessions.add(ses)
      added++ // verbatim-new session
      continue
    }
    const key = `${donorIndex}:${donorSubject}/${ses}`
    const decision =
      resolutions.session[key] ??
      (policy.sessionCollision === 'renumber' ? 'renumber' : undefined)
    if (decision === undefined) {
      collisions.push({
        kind: 'session',
        donorIndex,
        donorSubject,
        donorSession: ses,
        detail: `ses-${ses} already exists under sub-${donorSubject} — renumber or resolve.`,
      })
      continue
    }
    const assigned = nextFreeLabel(ses, recipientSessions, ses.length)
    remaps.push({ kind: 'ses', from: ses, to: assigned })
    recipientSessions.add(assigned)
    added++ // renumbered session
  }
  return { remaps, added }
}
