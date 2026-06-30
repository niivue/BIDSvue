import { describe, expect, it } from 'bun:test'

import {
  MneBidsNonEmptyDestinationError,
  applyMneBidsStaging,
  mergeStagingTree,
  walkStagingFiles,
} from './runMneBidsImport'

// Golden file list the real sample-data conversion produces (verified
// end-to-end against sample_audvis_raw.fif). Hermetic — no machine paths.
const GOLDEN = [
  'README',
  'dataset_description.json',
  'participants.json',
  'participants.tsv',
  'sub-01/ses-01/meg/sub-01_ses-01_coordsystem.json',
  'sub-01/ses-01/meg/sub-01_ses-01_task-audiovisual_run-1_channels.tsv',
  'sub-01/ses-01/meg/sub-01_ses-01_task-audiovisual_run-1_events.json',
  'sub-01/ses-01/meg/sub-01_ses-01_task-audiovisual_run-1_events.tsv',
  'sub-01/ses-01/meg/sub-01_ses-01_task-audiovisual_run-1_meg.fif',
  'sub-01/ses-01/meg/sub-01_ses-01_task-audiovisual_run-1_meg.json',
  'sub-01/ses-01/sub-01_ses-01_scans.tsv',
]

const STAGE = '/cache/mne-bids-stage-abc'
const DEST = '/data/MyMEG'

/** In-memory fs over a flat {relPath: bytes} map rooted at STAGE. */
function fakeFs(files: Record<string, Uint8Array>) {
  const dirOf = (full: string) => {
    const set = new Set<string>()
    for (const rel of Object.keys(files)) {
      const parts = rel.split('/')
      let cur = STAGE
      for (let i = 0; i < parts.length; i++) {
        if (cur === full) {
          set.add(
            JSON.stringify({
              name: parts[i],
              isDirectory: i < parts.length - 1,
            }),
          )
        }
        cur = `${cur}/${parts[i]}`
      }
    }
    return [...set].map(
      (s) => JSON.parse(s) as { name: string; isDirectory: boolean },
    )
  }
  const mkdirs: string[] = []
  const copies: Array<{ src: string; dst: string }> = []
  return {
    mkdirs,
    copies,
    readDir: async (path: string) => dirOf(path),
    copyFile: async (src: string, dst: string) => {
      const rel = src.slice(STAGE.length + 1)
      if (!files[rel]) throw new Error(`no such file ${src}`)
      copies.push({ src, dst })
    },
    mkdir: async (path: string) => {
      mkdirs.push(path)
    },
  }
}

describe('walkStagingFiles', () => {
  it('lists every file, sorted, relative', async () => {
    const files = Object.fromEntries(
      GOLDEN.map((p) => [p, new Uint8Array([1])]),
    )
    const fs = fakeFs(files)
    expect(await walkStagingFiles(STAGE, fs)).toEqual(
      [...GOLDEN].sort((a, b) => a.localeCompare(b)),
    )
  })
})

describe('mergeStagingTree (tier-1 hermetic golden)', () => {
  it('OS-native copies every golden file under destDir (no JS buffers)', async () => {
    const files = Object.fromEntries(
      GOLDEN.map((p) => [p, new TextEncoder().encode(p)]),
    )
    const fs = fakeFs(files)
    const rels = await mergeStagingTree(STAGE, DEST, fs)

    // Every golden file was copied to destDir via fs.copyFile.
    const dests = fs.copies.map((c) => c.dst).sort((a, b) => a.localeCompare(b))
    const expectedDest = GOLDEN.map((p) => `${DEST}/${p}`).sort((a, b) =>
      a.localeCompare(b),
    )
    expect(dests).toEqual(expectedDest)
    expect(rels.length).toBe(GOLDEN.length)
    // Nested parents were mkdir'd (covered by recordCreatedTree undo).
    expect(fs.mkdirs).toContain(`${DEST}/sub-01/ses-01/meg`)
  })
})

/**
 * Orchestration harness for applyMneBidsStaging: a mutable in-memory dest
 * dir (flat files), a staging listing, and a spy ctx. `failMergeAt` throws
 * on the Nth copyFile (1-based) so we can assert partial-copy cleanup.
 */
function orchestrationHarness(opts: {
  staging: Record<string, Uint8Array>
  destInitial?: string[]
  failMergeAt?: number
}) {
  const events: string[] = []
  const destFiles = new Set<string>(opts.destInitial ?? [])
  let copyCount = 0
  const ctx = {
    async recordCreatedTree() {
      events.push('recordCreatedTree')
    },
    async commit() {
      events.push('commit')
      return { operationId: 'op1' }
    },
    async rollback() {
      events.push('rollback')
    },
  }
  const fs = {
    // destDir always exists in these tests; staging paths don't (only listed).
    exists: async (p: string) => p === DEST,
    readDir: async (p: string) => {
      if (p === DEST) {
        return [...destFiles].map((name) => ({ name, isDirectory: false }))
      }
      const set = new Set<string>()
      for (const rel of Object.keys(opts.staging)) {
        if (`${STAGE}/${rel}`.startsWith(`${p}/`) && !rel.includes('/')) {
          set.add(rel)
        }
      }
      return [...set].map((name) => ({ name, isDirectory: false }))
    },
    copyFile: async (_src: string, dst: string) => {
      copyCount++
      if (opts.failMergeAt === copyCount) {
        events.push('copyFile:throw')
        throw new Error('disk full')
      }
      events.push('copyFile')
      destFiles.add(dst.slice(DEST.length + 1))
    },
    mkdir: async () => {},
    remove: async (p: string) => {
      if (p === STAGE) {
        events.push('remove:staging')
      } else if (p.startsWith(`${DEST}/`)) {
        const name = p.slice(DEST.length + 1)
        events.push(`remove:dest:${name}`)
        destFiles.delete(name)
      }
    },
  }
  return { ctx, fs, events, destFiles }
}

describe('applyMneBidsStaging (orchestration — audit P1.6 + P1.1)', () => {
  it('empty destination: records, merges, commits, drops staging', async () => {
    const { ctx, fs, events, destFiles } = orchestrationHarness({
      staging: { 'a.json': new Uint8Array([1]), 'b.json': new Uint8Array([2]) },
      destInitial: [],
    })
    const n = await applyMneBidsStaging(STAGE, DEST, ctx, fs)
    expect(n).toBe(2)
    expect(events).toEqual([
      'recordCreatedTree',
      'copyFile',
      'copyFile',
      'commit',
      'remove:staging',
    ])
    expect([...destFiles].sort()).toEqual(['a.json', 'b.json'])
  })

  it('non-empty destination: refuses BEFORE recording; never deletes user files', async () => {
    const { ctx, fs, events, destFiles } = orchestrationHarness({
      staging: { 'a.json': new Uint8Array([1]) },
      destInitial: ['preexisting.txt'],
    })
    await expect(
      applyMneBidsStaging(STAGE, DEST, ctx, fs),
    ).rejects.toBeInstanceOf(MneBidsNonEmptyDestinationError)
    expect(events).not.toContain('recordCreatedTree')
    expect(events).not.toContain('copyFile')
    expect(events.some((e) => e.startsWith('remove:dest:'))).toBe(false)
    expect([...destFiles]).toEqual(['preexisting.txt']) // user file intact
    expect(events).toContain('rollback')
    expect(events).toContain('remove:staging')
  })

  it('merge failure: rolls back AND removes the partial copies + staging (P1.1)', async () => {
    const { ctx, fs, events, destFiles } = orchestrationHarness({
      staging: { 'a.json': new Uint8Array([1]), 'b.json': new Uint8Array([2]) },
      destInitial: [],
      failMergeAt: 2, // a.json copied, b.json throws
    })
    await expect(applyMneBidsStaging(STAGE, DEST, ctx, fs)).rejects.toThrow(
      /disk full/,
    )
    expect(events).toContain('rollback')
    // the already-copied a.json was removed from destDir, not orphaned
    expect(events).toContain('remove:dest:a.json')
    expect([...destFiles]).toEqual([])
    expect(events).toContain('remove:staging')
  })
})
