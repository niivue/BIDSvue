import { describe, expect, it } from 'bun:test'
import type { Dataset, FileNode } from '$lib/bids/types'
import { buildDatasetSummary } from './datasetSummary'

function file(suffix: string): FileNode {
  return {
    kind: 'file',
    path: `/x/${suffix}`,
    name: suffix,
    entities: {},
    suffix,
    extension: '.nii.gz',
    flags: {} as FileNode['flags'],
  }
}

function ds(opts: {
  name?: string
  subjects: string[]
  sessions: string[] // `${sub}/${ses}` keys
  suffixes: Record<string, number>
}): Dataset {
  const bySubject = new Map(opts.subjects.map((s) => [s, [file('T1w')]]))
  const bySubjectSession = new Map(opts.sessions.map((k) => [k, [file('T1w')]]))
  const bySuffix = new Map(
    Object.entries(opts.suffixes).map(([suf, n]) => [
      suf,
      Array.from({ length: n }, () => file(suf)),
    ]),
  )
  return {
    root: '/x',
    description: opts.name
      ? ({ Name: opts.name } as Dataset['description'])
      : null,
    participants: null,
    tree: {} as Dataset['tree'],
    index: { byPath: new Map(), bySubject, bySubjectSession, bySuffix },
    bidsIgnorePatterns: [],
  }
}

describe('buildDatasetSummary', () => {
  it('reports name, subjects, sessions, suffix counts (sorted desc)', () => {
    const out = buildDatasetSummary(
      ds({
        name: 'Study A',
        subjects: ['02', '01'],
        sessions: ['01/pre', '01/post', '02/pre'],
        suffixes: { T1w: 2, bold: 5 },
      }),
    )
    expect(out).toContain('Dataset name: Study A')
    expect(out).toContain('Subjects: 2')
    expect(out).toContain('sub-01, sub-02') // sorted
    expect(out).toContain('Sessions: 2 distinct (ses-post, ses-pre)')
    expect(out).toContain('3 subject-session combinations')
    // bold (5) sorts before T1w (2)
    expect(out.indexOf('bold: 5')).toBeLessThan(out.indexOf('T1w: 2'))
  })

  it('handles unnamed, sessionless, suffixless datasets', () => {
    const out = buildDatasetSummary(
      ds({ subjects: ['01'], sessions: [], suffixes: {} }),
    )
    expect(out).toContain('Dataset name: (unnamed)')
    expect(out).toContain('Sessions: none')
    expect(out).toContain('(no BIDS-suffixed files)')
  })

  it('caps the inline subject-id list at 50', () => {
    const subjects = Array.from({ length: 60 }, (_, i) =>
      String(i + 1).padStart(2, '0'),
    )
    const out = buildDatasetSummary(
      ds({ subjects, sessions: [], suffixes: {} }),
    )
    expect(out).toContain('Subjects: 60')
    expect(out).toContain('(+10 more)')
  })

  // Audit 2026-06-21 P2: every field is bounded so a hostile/huge
  // dataset can't generate a multi-MB summary.
  it('caps the session-label list at 50', () => {
    const sessions = Array.from({ length: 70 }, (_, i) => `01/s${i}`)
    const out = buildDatasetSummary(
      ds({ subjects: ['01'], sessions, suffixes: {} }),
    )
    expect(out).toContain('Sessions: 70 distinct')
    expect(out).toContain('(+20 more)')
  })

  it('caps the suffix rows at 100 with an aggregate remainder', () => {
    const suffixes: Record<string, number> = {}
    for (let i = 0; i < 130; i++)
      suffixes[`sfx${String(i).padStart(3, '0')}`] = 1
    const out = buildDatasetSummary(
      ds({ subjects: ['01'], sessions: [], suffixes }),
    )
    // 130 suffixes, 100 shown, 30 in the remainder (1 file each).
    expect(out).toContain('(+30 more suffixes, 30 files)')
  })

  it('caps the dataset name by bytes', () => {
    const out = buildDatasetSummary(
      ds({
        name: 'z'.repeat(5000),
        subjects: ['01'],
        sessions: [],
        suffixes: {},
      }),
    )
    const nameLine = out.split('\n')[0]
    // Whole line is "Dataset name: " (14) + <= 256 bytes of name.
    expect(new TextEncoder().encode(nameLine).length).toBeLessThanOrEqual(
      14 + 256,
    )
  })

  it('enforces a final byte ceiling on the whole summary', () => {
    // Many suffixes each with a long name push the body past 32 KiB even
    // after per-row capping is bypassed — final guard truncates.
    const suffixes: Record<string, number> = {}
    for (let i = 0; i < 100; i++) suffixes[`${'q'.repeat(500)}${i}`] = i + 1
    const out = buildDatasetSummary(
      ds({ subjects: ['01'], sessions: [], suffixes }),
    )
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(
      32 * 1024 + '\n[summary truncated]'.length,
    )
    expect(out).toContain('[summary truncated]')
  })
})
// resolveReadViaBridge moved to readBridge.ts — see readBridge.test.ts.
