// Coverage for the scanner's participants.tsv parser. Uses a small
// in-memory fs adapter so we don't depend on an on-disk fixture.

import { describe, expect, test } from 'bun:test'
import { type FileSystemAdapter, scanDataset } from './scanner'

interface InMemoryEntry {
  isFile: boolean
  isDirectory: boolean
  text?: string
}

function fixtureFs(layout: Record<string, InMemoryEntry>): FileSystemAdapter {
  return {
    async readDir(path) {
      const prefix = `${path}/`
      const seen = new Set<string>()
      const out: Array<{
        name: string
        isFile: boolean
        isDirectory: boolean
        isSymlink: boolean
      }> = []
      for (const fullPath of Object.keys(layout)) {
        if (!fullPath.startsWith(prefix)) continue
        const remainder = fullPath.slice(prefix.length)
        const slash = remainder.indexOf('/')
        const head = slash === -1 ? remainder : remainder.slice(0, slash)
        if (seen.has(head)) continue
        seen.add(head)
        const directHit = layout[`${prefix}${head}`]
        if (directHit !== undefined && slash === -1) {
          out.push({
            name: head,
            isFile: directHit.isFile,
            isDirectory: directHit.isDirectory,
            isSymlink: false,
          })
        } else {
          out.push({
            name: head,
            isFile: false,
            isDirectory: true,
            isSymlink: false,
          })
        }
      }
      return out
    },
    async readTextFile(path) {
      const entry = layout[path]
      if (entry === undefined || entry.text === undefined) {
        throw new Error(`ENOENT: ${path}`)
      }
      return entry.text
    },
  }
}

describe('scanner participants.tsv parsing', () => {
  test('absent participants.tsv → dataset.participants is null', async () => {
    const layout: Record<string, InMemoryEntry> = {
      '/r/dataset_description.json': {
        isFile: true,
        isDirectory: false,
        text: JSON.stringify({ Name: 'x', BIDSVersion: '1.11.1' }),
      },
    }
    const result = await scanDataset('/r', { fs: fixtureFs(layout) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.participants).toBeNull()
  })

  test('ds005016-shaped fixture (participant_id + sex + group) parses into rows', async () => {
    const tsv = [
      'participant_id\tsex\tgroup',
      'sub-7000\tfemale\tSMH',
      'sub-7002\tmale\tMBSR+',
      'sub-7004\tfemale\tMBSR+',
      '', // trailing blank line — should be filtered
    ].join('\n')
    const layout: Record<string, InMemoryEntry> = {
      '/r/dataset_description.json': {
        isFile: true,
        isDirectory: false,
        text: JSON.stringify({ Name: 'x', BIDSVersion: '1.11.1' }),
      },
      '/r/participants.tsv': {
        isFile: true,
        isDirectory: false,
        text: tsv,
      },
    }
    const result = await scanDataset('/r', { fs: fixtureFs(layout) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const participants = result.dataset.participants
    expect(participants).not.toBeNull()
    expect(participants?.columns).toEqual(['participant_id', 'sex', 'group'])
    expect(participants?.rows.length).toBe(3)
    expect(participants?.rows[0]).toEqual({
      participant_id: 'sub-7000',
      sex: 'female',
      group: 'SMH',
    })
  })

  test('rows with short cell counts pad missing cells with the BIDS n/a sentinel', async () => {
    // Audit 2026-05-18 #14: scanner used to pad with `''`, the TsvEditor
    // with `n/a`. Unifying on `parseTsv` aligns both on `n/a` so the
    // dashboard's participants pies and the editor view never disagree.
    const tsv = ['participant_id\tsex\tgroup', 'sub-01\tF'].join('\n')
    const layout: Record<string, InMemoryEntry> = {
      '/r/dataset_description.json': {
        isFile: true,
        isDirectory: false,
        text: JSON.stringify({ Name: 'x', BIDSVersion: '1.11.1' }),
      },
      '/r/participants.tsv': {
        isFile: true,
        isDirectory: false,
        text: tsv,
      },
    }
    const result = await scanDataset('/r', { fs: fixtureFs(layout) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.participants?.rows[0]).toEqual({
      participant_id: 'sub-01',
      sex: 'F',
      group: 'n/a',
    })
  })

  test('wide rows (more cells than header) → participants null, scan still succeeds', async () => {
    // Audit 2026-05-18 #14: was previously silently truncated. Now
    // surfaces as a parsing failure; the dashboard's participants
    // section degrades to "no data" rather than the scanner inventing
    // a partial view.
    const tsv = ['participant_id\tsex', 'sub-01\tF\textra-cell'].join('\n')
    const layout: Record<string, InMemoryEntry> = {
      '/r/dataset_description.json': {
        isFile: true,
        isDirectory: false,
        text: JSON.stringify({ Name: 'x', BIDSVersion: '1.11.1' }),
      },
      '/r/participants.tsv': {
        isFile: true,
        isDirectory: false,
        text: tsv,
      },
    }
    const result = await scanDataset('/r', { fs: fixtureFs(layout) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.participants).toBeNull()
  })

  test('BOM-prefixed file parses cleanly (Excel exports)', async () => {
    const tsv = '﻿participant_id\tsex\nsub-01\tF'
    const layout: Record<string, InMemoryEntry> = {
      '/r/dataset_description.json': {
        isFile: true,
        isDirectory: false,
        text: JSON.stringify({ Name: 'x', BIDSVersion: '1.11.1' }),
      },
      '/r/participants.tsv': {
        isFile: true,
        isDirectory: false,
        text: tsv,
      },
    }
    const result = await scanDataset('/r', { fs: fixtureFs(layout) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.participants?.columns).toEqual([
      'participant_id',
      'sex',
    ])
  })

  test('header-only file → table with no rows (not null)', async () => {
    const layout: Record<string, InMemoryEntry> = {
      '/r/dataset_description.json': {
        isFile: true,
        isDirectory: false,
        text: JSON.stringify({ Name: 'x', BIDSVersion: '1.11.1' }),
      },
      '/r/participants.tsv': {
        isFile: true,
        isDirectory: false,
        text: 'participant_id\tsex',
      },
    }
    const result = await scanDataset('/r', { fs: fixtureFs(layout) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.participants?.columns).toEqual([
      'participant_id',
      'sex',
    ])
    expect(result.dataset.participants?.rows).toEqual([])
  })

  test('handles CRLF line endings', async () => {
    const tsv = 'participant_id\tsex\r\nsub-01\tF\r\nsub-02\tM\r\n'
    const layout: Record<string, InMemoryEntry> = {
      '/r/dataset_description.json': {
        isFile: true,
        isDirectory: false,
        text: JSON.stringify({ Name: 'x', BIDSVersion: '1.11.1' }),
      },
      '/r/participants.tsv': {
        isFile: true,
        isDirectory: false,
        text: tsv,
      },
    }
    const result = await scanDataset('/r', { fs: fixtureFs(layout) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dataset.participants?.rows.length).toBe(2)
  })
})
