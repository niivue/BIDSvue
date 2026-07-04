// Merge executor (Merge design history in git log §5 + M4). Runs a fully-resolved,
// unblocked MergePlan as ONE reversible OperationContext: copies files
// (OS-native for binaries, read+token-remap+write for renumbered
// .tsv/.json), writes reconciled metadata, writes durable provenance +
// CHANGES, then commits. On any failure (including cancellation) it
// rolls back every completed step. Pure-ish: all IO goes through the
// injected MutateFs / readText, so it runs on a node:fs adapter in
// tests and through Tauri in production.

import { type MutateFs, beginOperation } from '$lib/mutate/backup'
import { makeEntityTokenReplacer } from '$lib/rename/tokenReplace'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import {
  dirname,
  stripTrailingSeparators,
  toPosixSeparators,
} from '$lib/util/paths'
import {
  PROVENANCE_REL_PATH,
  buildApplyReport,
  buildChangesEntry,
  buildMergeProvenance,
  serializeProvenance,
} from './provenance'
import type { CopyOp, MergeApplyReport, MergePlan, TokenRemap } from './types'
import { buildValidationSummary } from './validation'

/** The cancellation error thrown when `signal` aborts mid-apply. */
export class MergeCancelledError extends Error {
  constructor() {
    super('Merge cancelled')
    this.name = 'MergeCancelledError'
  }
}

export interface ApplyMergeDeps {
  fs: MutateFs
  statePaths: DatasetStatePaths
  /** Reads a donor text file (pre-resolving symlinks in production). */
  readText: (path: string) => Promise<string>
  /** ISO timestamp for provenance / report (executor passes Date now). */
  now: string
  bidsvueVersion: string
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

const CONTENT_REMAP_EXTS = new Set(['.json', '.tsv'])

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot).toLowerCase()
}

function applyRemaps(text: string, remaps: TokenRemap[]): string {
  let out = text
  for (const r of remaps)
    out = makeEntityTokenReplacer(r.kind, r.from, r.to)(out)
  return out
}

function needsContentRemap(copy: CopyOp): boolean {
  return copy.remaps.length > 0 && CONTENT_REMAP_EXTS.has(extOf(copy.dest))
}

/**
 * Apply an unblocked plan. Throws if `plan.blocked`. Returns the apply
 * report on success. v1 records a `not-run` validation summary — the
 * validator runs when the merged recipient is opened (see validation.ts).
 */
export async function applyMergePlan(
  plan: MergePlan,
  deps: ApplyMergeDeps,
): Promise<MergeApplyReport> {
  if (plan.blocked) {
    throw new Error('applyMergePlan: refusing to apply a blocked plan')
  }
  const { fs, statePaths, readText, now, bidsvueVersion, signal } = deps
  // POSIX root (audit 2026-07-04): the op-log root, provenance, and CHANGES
  // write paths all match the POSIX copy/metadata destinations and the
  // separator-invariant app-data safe-key.
  const root = toPosixSeparators(stripTrailingSeparators(plan.recipientRoot))
  // v1 runs no separate validator subprocess inside the merge — opening
  // the merged recipient runs the normal in-WebView validator. So the
  // summary is `not-run` (or `not-run`/skip per policy). See validation.ts.
  const validation = buildValidationSummary(plan.policy, null)

  const ctx = beginOperation(
    root,
    statePaths,
    {
      opType: 'merge',
      summary: `Merged ${plan.summary.donors} donor(s): +${plan.summary.subjectsAdded} subject(s), ${plan.summary.subjectsFolded} folded`,
      details: {
        donors: plan.summary.donors,
        subjectsAdded: plan.summary.subjectsAdded,
        subjectsFolded: plan.summary.subjectsFolded,
        // Machine-local forensic record (appData) — keeps the RAW
        // discarded values the durable provenance redacts. Two-tier
        // split per Merge design history in git log §8.1 (audit 2026-06-28 P1.1).
        discardedValues: plan.discarded,
      },
    },
    fs,
  )

  const total =
    plan.copies.length + plan.metadataWrites.length + 2 /* prov + changes */
  let done = 0
  const tick = (): void => {
    done++
    deps.onProgress?.(done, total)
  }
  const checkCancel = (): void => {
    if (signal?.aborted) throw new MergeCancelledError()
  }

  try {
    // 1. File copies.
    for (const copy of plan.copies) {
      checkCancel()
      if (needsContentRemap(copy)) {
        const srcText = await readText(copy.src)
        // writeNewText refuses-on-exists like copyInto, so a remapped
        // dest that appeared after planning is not silently overwritten.
        await ctx.writeNewText(copy.dest, applyRemaps(srcText, copy.remaps), {
          why: 'merge copy (remapped)',
        })
      } else {
        await ctx.copyInto(copy.src, copy.dest, { why: 'merge copy' })
      }
      tick()
    }

    // 2. Reconciled metadata files (existing files -> backed up).
    for (const write of plan.metadataWrites) {
      checkCancel()
      const dir = dirname(write.path)
      if (dir !== null) await fs.mkdir(dir, { recursive: true })
      await ctx.writeText(write.path, write.content, { why: write.why })
      tick()
    }

    // 3. Durable provenance.
    checkCancel()
    const provenance = buildMergeProvenance(plan, {
      bidsvueVersion,
      mergedAt: now,
      originalsCarried: plan.policy.defaceOriginals === 'carry',
      validation,
    })
    const provPath = `${root}/${PROVENANCE_REL_PATH}`
    const provDir = dirname(provPath)
    if (provDir !== null) await fs.mkdir(provDir, { recursive: true })
    await ctx.writeText(provPath, serializeProvenance(provenance), {
      why: 'merge provenance',
    })
    tick()

    // 4. CHANGES — prepend the new entry (newest first), matching how
    // most BIDS datasets order their changelog.
    checkCancel()
    const changesPath = `${root}/CHANGES`
    const entry = buildChangesEntry(provenance, ctx.operationId)
    let existing = ''
    try {
      existing = await readText(changesPath)
    } catch {
      existing = ''
    }
    const changesContent =
      existing.length === 0 ? entry : `${entry}\n${existing}`
    await ctx.writeText(changesPath, changesContent, { why: 'merge CHANGES' })
    tick()

    await ctx.commit()
  } catch (err) {
    await ctx.rollback(err)
    throw err
  }

  return buildApplyReport(
    plan,
    ctx.operationId,
    now,
    plan.policy.defaceOriginals === 'carry',
    validation,
  )
}
