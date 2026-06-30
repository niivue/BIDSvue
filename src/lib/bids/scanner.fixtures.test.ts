// Snapshot tests against the two reference BIDS datasets named in CLAUDE.md
// "Test fixtures". The fixtures aren't committed to the repo (gitignored),
// so each developer provides their own copies under datasets/. Tests skip
// cleanly when the fixtures aren't present, so CI stays green without them.

import { describe, expect, test } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type FileSystemAdapter, scanDataset } from './scanner'
import type { Dataset, FolderNode, GroupNode, TreeNode } from './types'

const FIXTURES = [
  {
    label: 'BrainHealth/AgingBrain',
    path: join(process.cwd(), 'datasets', 'BrainHealth', 'AgingBrain'),
  },
  {
    label: 'dbic/QA',
    path: join(process.cwd(), 'datasets', 'dbic', 'QA'),
  },
] as const

const nodeFs: FileSystemAdapter = {
  async readDir(path) {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
      isSymlink: e.isSymbolicLink(),
    }))
  },
  async readTextFile(path) {
    return readFile(path, 'utf8')
  },
}

interface TreeSummary {
  folders: number
  files: number
  groups: number
  specialFolders: string[]
  bidsIgnoredCount: number
  subjectFolders: string[]
}

function summarize(tree: TreeNode): TreeSummary {
  const acc: TreeSummary = {
    folders: 0,
    files: 0,
    groups: 0,
    specialFolders: [],
    bidsIgnoredCount: 0,
    subjectFolders: [],
  }
  const visit = (node: TreeNode): void => {
    if (node.kind === 'folder') {
      acc.folders++
      if (node.flags.specialFolder !== undefined) {
        acc.specialFolders.push(`${node.name}:${node.flags.specialFolder}`)
      }
      if (node.flags.bidsIgnored === true) acc.bidsIgnoredCount++
      if (node.level === 'subject') acc.subjectFolders.push(node.name)
      for (const c of node.children) visit(c)
    } else if (node.kind === 'group') {
      acc.groups++
    } else {
      acc.files++
    }
  }
  visit(tree)
  acc.specialFolders.sort()
  acc.subjectFolders.sort()
  return acc
}

function findFolder(
  tree: FolderNode,
  predicate: (f: FolderNode) => boolean,
): FolderNode | null {
  if (predicate(tree)) return tree
  for (const child of tree.children) {
    if (child.kind === 'folder') {
      const found = findFolder(child, predicate)
      if (found !== null) return found
    }
  }
  return null
}

function describeRows(
  folder: FolderNode,
): Array<{ prefix: string; stem: string; exts: string[] }> {
  const rows: Array<{ prefix: string; stem: string; exts: string[] }> = []
  for (const child of folder.children) {
    if (child.kind === 'group') {
      rows.push({
        prefix: child.commonPrefix,
        stem: stemFromGroup(child),
        exts: child.suffixes,
      })
    }
  }
  return rows
}

function stemFromGroup(group: GroupNode): string {
  const first = group.members[0]
  const noExt = first.name.slice(0, first.name.length - first.extension.length)
  return group.commonPrefix !== '' && noExt.startsWith(group.commonPrefix)
    ? noExt.slice(group.commonPrefix.length)
    : noExt
}

for (const fixture of FIXTURES) {
  const present =
    existsSync(fixture.path) && statSync(fixture.path).isDirectory()
  const fn = present ? describe : describe.skip
  fn(
    `fixture: ${fixture.label}${present ? '' : ' (skipped — not present locally)'}`,
    () => {
      let dataset: Dataset

      test('scans without error', async () => {
        const result = await scanDataset(fixture.path, { fs: nodeFs })
        expect(result.ok).toBe(true)
        if (result.ok) dataset = result.dataset
      })

      test('snapshot summary is stable', () => {
        const summary = summarize(dataset.tree)
        expect(summary).toMatchSnapshot()
      })

      test('worked example: anat folder produces the expected paired row', () => {
        // The BIDS-validated anat lives under sub-XXX/anat. The
        // sourcedata/sub-XXX/anat copy holds .dicom.tgz archives and is
        // explicitly out of scope (specialFolder flag set), so we filter it out.
        const anat = findFolder(
          dataset.tree,
          (f) =>
            f.level === 'datatype' &&
            f.name === 'anat' &&
            f.flags.specialFolder === undefined,
        )
        expect(anat).not.toBeNull()
        if (anat === null) return
        const rows = describeRows(anat)
        expect(rows.length).toBeGreaterThan(0)
        for (const row of rows) {
          expect(row.exts).toContain('.nii.gz')
          expect(row.exts).toContain('.json')
        }
      })

      test('default scan excludes hidden special folders (sourcedata, dotfile-named)', () => {
        // With showHiddenFiles off (the default), the scanner now skips
        // top-level sourcedata/ and any dotfile-named entry (.heudiconv/,
        // .bidsvue/, .git/, ...). Any specialFolder flag that survives the
        // default scan therefore points at derivatives/ or code/ -- both
        // visible-but-dimmed in the UI.
        const summary = summarize(dataset.tree)
        for (const flagged of summary.specialFolders) {
          const tag = flagged.split(':').pop() ?? ''
          if (
            tag === 'sourcedata' ||
            tag === 'heudiconv' ||
            tag === 'bidsvue' ||
            tag === 'git'
          ) {
            throw new Error(
              `default scan should have filtered ${flagged}; the showHiddenFiles toggle is gating this entry`,
            )
          }
        }
      })

      test('root folder is in byPath so the Preview can resolve a root click', () => {
        // Regression for the M1 smoke-run bug where clicking the dataset root
        // hit the empty-state branch because index.byPath was missing the
        // outermost folder.
        expect(dataset.index.byPath.get(dataset.root)).toBe(dataset.tree)
      })

      test('dotfiles are filtered by default (showHiddenFiles off)', () => {
        // Default scan above passed includeHidden=undefined which resolves to
        // false. No path in byPath should have a dotfile component beyond the
        // dataset's own ancestor path.
        const offendingPaths: string[] = []
        for (const path of dataset.index.byPath.keys()) {
          const insideDataset = path.slice(dataset.root.length)
          if (/\/\./.test(insideDataset)) offendingPaths.push(path)
        }
        expect(offendingPaths).toEqual([])
      })

      test('includeHidden:true surfaces dotfiles that exist in the fixture', async () => {
        // Re-scan with hidden files visible. Both fixtures have .heudiconv/.
        const result = await scanDataset(fixture.path, {
          fs: nodeFs,
          includeHidden: true,
        })
        expect(result.ok).toBe(true)
        if (!result.ok) return
        const summary = summarize(result.dataset.tree)
        const hiddenSpecials = summary.specialFolders.filter((s) =>
          s.includes(':heudiconv'),
        )
        expect(hiddenSpecials.length).toBeGreaterThan(0)
      })
    },
  )
}
