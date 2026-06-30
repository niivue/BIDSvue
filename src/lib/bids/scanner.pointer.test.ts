// Scanner pointer-detection tests with a mocked DirEntry + readLink
// + statFollowing adapter (no real filesystem). Models the DataLad /
// git-annex layout closely enough that the scanner walk runs end-to-
// end and the pointer flag round-trips into the resulting FileNode.
//
// Mocked, not fixture-based, per the CLAUDE.md test-discipline:
// pointer state across machines is too fragile to commit a real
// `datalad clone` to the repo, and the scanner is the part that
// matters.
//
// Adapter behaviour mirrors Tauri's plugin-fs:
//   - `readDir` returns lstat-style dirents — a symlink is reported
//     as `isSymlink: true, isFile: false, isDirectory: false`
//     whether or not its target exists. This is what Rust's
//     `DirEntry.file_type()` produces.
//   - `statFollowing` follows the link and returns `null` for
//     broken targets. The scanner uses this to decide
//     `contentPresent`.

import { describe, expect, test } from 'bun:test'
import type { DirEntry } from '@tauri-apps/plugin-fs'
import { type FileSystemAdapter, scanDataset } from './scanner'
import type { FileNode, TreeNode } from './types'

interface MockFile {
  text?: string
  isSymlink?: boolean
  linkTarget?: string
  /**
   * For symlinks: whether the target resolves to a real file
   * (`datalad get` ran). Drives `statFollowing` — un-fetched
   * pointers leave this `false` (the default). For regular files
   * this field is ignored; the file's mere presence in the mock
   * tree means it exists.
   */
  targetExists?: boolean
}

interface MockDir {
  [name: string]: MockFile | MockDir | undefined
}

function isFileEntry(v: MockFile | MockDir): v is MockFile {
  return (
    'text' in v || 'isSymlink' in v || 'linkTarget' in v || 'targetExists' in v
  )
}

function buildAdapter(root: string, tree: MockDir): FileSystemAdapter {
  function locate(path: string): MockFile | MockDir | null {
    if (path === root) return tree
    if (!path.startsWith(`${root}/`)) return null
    const rel = path.slice(root.length + 1)
    let node: MockFile | MockDir = tree
    for (const part of rel.split('/')) {
      if (isFileEntry(node)) return null
      const child = node[part]
      if (child === undefined) return null
      node = child
    }
    return node
  }

  return {
    async readDir(path) {
      const node = locate(path)
      if (node === null || isFileEntry(node)) {
        throw new Error(`mock readDir: not a directory: ${path}`)
      }
      const out: DirEntry[] = []
      for (const [name, child] of Object.entries(node)) {
        if (child === undefined) continue
        if (isFileEntry(child)) {
          // Match plugin-fs's lstat-style dirent flags: a symlink
          // is `isSymlink: true, isFile: false` regardless of
          // whether its target resolves.
          const isSymlink = child.isSymlink === true
          const isFile = !isSymlink
          out.push({ name, isDirectory: false, isFile, isSymlink })
        } else {
          out.push({
            name,
            isDirectory: true,
            isFile: false,
            isSymlink: false,
          })
        }
      }
      return out
    },
    async readTextFile(path) {
      const node = locate(path)
      if (node === null || !isFileEntry(node) || node.text === undefined) {
        throw new Error(`mock readTextFile: not a text file: ${path}`)
      }
      return node.text
    },
    async readLink(path) {
      const node = locate(path)
      if (
        node === null ||
        !isFileEntry(node) ||
        node.linkTarget === undefined
      ) {
        throw new Error(`mock readLink: not a symlink: ${path}`)
      }
      return node.linkTarget
    },
    async statFollowing(path) {
      const node = locate(path)
      if (node === null) return null
      if (!isFileEntry(node)) return { size: 0 } // regular dir
      if (node.linkTarget !== undefined) {
        // Symlink: follows to the target only if `targetExists`.
        return node.targetExists === true ? { size: 0 } : null
      }
      // Regular file present in the mock tree.
      return { size: node.text?.length ?? 0 }
    },
  }
}

function collectFiles(tree: TreeNode, out: FileNode[] = []): FileNode[] {
  if (tree.kind === 'file') out.push(tree)
  else if (tree.kind === 'folder') {
    for (const c of tree.children) collectFiles(c, out)
  } else {
    for (const m of tree.members) out.push(m)
  }
  return out
}

const ROOT = '/study'

describe('scanner — DataLad / git-annex pointer detection', () => {
  test('detects an un-fetched annex pointer and records its size + hash', async () => {
    const annexBasename =
      'MD5E-s5712417--0d1e0a7ff7063250404f45a955a66203.nii.gz'
    const tree: MockDir = {
      'dataset_description.json': {
        text: '{"Name":"x","BIDSVersion":"1.10.0"}',
      },
      'sub-01': {
        anat: {
          'sub-01_T1w.json': { text: '{}' },
          'sub-01_T1w.nii.gz': {
            isSymlink: true,
            // Standard `datalad clone` relative target.
            linkTarget: `../../.git/annex/objects/jJ/2v/${annexBasename}/${annexBasename}`,
            // targetExists left unset → un-fetched.
          },
        },
      },
    }
    const adapter = buildAdapter(ROOT, tree)
    const result = await scanDataset(ROOT, { fs: adapter })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const files = collectFiles(result.dataset.tree)
    const nii = files.find((f) => f.name === 'sub-01_T1w.nii.gz')
    expect(nii).toBeDefined()
    if (nii === undefined) return
    expect(nii.flags.pointer).toBeDefined()
    expect(nii.flags.pointer?.backend).toBe('git-annex')
    expect(nii.flags.pointer?.size).toBe(5712417)
    expect(nii.flags.pointer?.hash).toBe('0d1e0a7ff7063250404f45a955a66203')
    expect(nii.flags.pointer?.contentPresent).toBe(false)
    expect(nii.flags.pointer?.extension).toBe('.nii.gz')
  })

  test('marks a fetched pointer (statFollowing resolves) as contentPresent: true', async () => {
    // `datalad get` resolved the symlink — the target file now
    // exists on disk. plugin-fs still reports `isFile: false` for
    // the dirent (lstat semantics), so the scanner relies on
    // `statFollowing` to know the file is fetched.
    const annexBasename = 'MD5E-s100--cafebabe.nii.gz'
    const tree: MockDir = {
      'dataset_description.json': {
        text: '{"Name":"x","BIDSVersion":"1.10.0"}',
      },
      'sub-01': {
        anat: {
          'sub-01_T1w.nii.gz': {
            isSymlink: true,
            targetExists: true,
            linkTarget: `../../.git/annex/objects/aB/cD/${annexBasename}/${annexBasename}`,
          },
        },
      },
    }
    const adapter = buildAdapter(ROOT, tree)
    const result = await scanDataset(ROOT, { fs: adapter })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const files = collectFiles(result.dataset.tree)
    const nii = files.find((f) => f.name === 'sub-01_T1w.nii.gz')
    expect(nii?.flags.pointer?.contentPresent).toBe(true)
    expect(nii?.flags.pointer?.size).toBe(100)
  })

  test('skips non-annex symlinks (preserves the legacy cycle guard)', async () => {
    const tree: MockDir = {
      'dataset_description.json': {
        text: '{"Name":"x","BIDSVersion":"1.10.0"}',
      },
      'sub-01': {
        anat: {
          'sub-01_T1w.json': { text: '{}' },
          // Symlink to another regular file, NOT into .git/annex/objects.
          'symlinked.nii.gz': {
            isSymlink: true,
            linkTarget: '../../shared/T1w.nii.gz',
          },
        },
      },
    }
    const adapter = buildAdapter(ROOT, tree)
    const result = await scanDataset(ROOT, { fs: adapter })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const files = collectFiles(result.dataset.tree)
    expect(files.find((f) => f.name === 'symlinked.nii.gz')).toBeUndefined()
  })

  test('regular files unaffected — no pointer flag set', async () => {
    const tree: MockDir = {
      'dataset_description.json': {
        text: '{"Name":"x","BIDSVersion":"1.10.0"}',
      },
      'sub-01': {
        anat: {
          'sub-01_T1w.json': { text: '{}' },
          'sub-01_T1w.nii.gz': { text: 'mock-bytes' },
        },
      },
    }
    const adapter = buildAdapter(ROOT, tree)
    const result = await scanDataset(ROOT, { fs: adapter })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const files = collectFiles(result.dataset.tree)
    for (const f of files) expect(f.flags.pointer).toBeUndefined()
  })

  test('pointer file pairs with its sidecar like any other data file', async () => {
    const annexBasename = 'MD5E-s100--abc.nii.gz'
    const tree: MockDir = {
      'dataset_description.json': {
        text: '{"Name":"x","BIDSVersion":"1.10.0"}',
      },
      'sub-01': {
        anat: {
          'sub-01_T1w.json': { text: '{}' },
          'sub-01_T1w.nii.gz': {
            isSymlink: true,
            linkTarget: `../../.git/annex/objects/aB/cD/${annexBasename}/${annexBasename}`,
          },
        },
      },
    }
    const adapter = buildAdapter(ROOT, tree)
    const result = await scanDataset(ROOT, { fs: adapter })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Walk the anat folder; the .json + .nii.gz should coalesce into one group.
    const sub01 = result.dataset.tree.children.find(
      (c) => c.kind === 'folder' && c.name === 'sub-01',
    )
    expect(sub01?.kind).toBe('folder')
    if (sub01?.kind !== 'folder') return
    const anat = sub01.children.find(
      (c) => c.kind === 'folder' && c.name === 'anat',
    )
    expect(anat?.kind).toBe('folder')
    if (anat?.kind !== 'folder') return
    const groups = anat.children.filter((c) => c.kind === 'group')
    expect(groups.length).toBe(1)
    if (groups[0]?.kind !== 'group') return
    expect(groups[0].members.length).toBe(2)
    const ext = groups[0].members.map((m) => m.extension).sort()
    expect(ext).toEqual(['.json', '.nii.gz'])
  })

  test('regression: fetch-then-rescan flips contentPresent from false to true', async () => {
    // Reproduces the OpenNeuro ds005016 user-reported failure:
    // before audit-round-29 fix, the scanner relied on dirent
    // `isFile` to flip contentPresent, but plugin-fs's lstat
    // semantics keep `isFile: false` for all symlinks. The fix
    // probes statFollowing instead. This test demonstrates the
    // expected before/after.
    const annexBasename = 'MD5E-s5712417--abcdef.nii.gz'
    const treeBefore: MockDir = {
      'dataset_description.json': {
        text: '{"Name":"x","BIDSVersion":"1.10.0"}',
      },
      'sub-7538': {
        'ses-01': {
          anat: {
            'sub-7538_ses-01_run-01_T1w.nii': {
              isSymlink: true,
              linkTarget: `../../../.git/annex/objects/aa/bb/${annexBasename}/${annexBasename}`,
              // un-fetched
            },
          },
        },
      },
    }
    const treeAfter = JSON.parse(JSON.stringify(treeBefore)) as MockDir
    const subAfter = treeAfter['sub-7538'] as MockDir
    const sesAfter = subAfter['ses-01'] as MockDir
    const anatAfter = sesAfter.anat as MockDir
    ;(anatAfter['sub-7538_ses-01_run-01_T1w.nii'] as MockFile).targetExists =
      true

    // Initial scan: un-fetched.
    let result = await scanDataset(ROOT, { fs: buildAdapter(ROOT, treeBefore) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const before = collectFiles(result.dataset.tree).find(
      (f) => f.name === 'sub-7538_ses-01_run-01_T1w.nii',
    )
    expect(before?.flags.pointer?.contentPresent).toBe(false)

    // After `datalad get`: target exists, rescan should pick it up.
    result = await scanDataset(ROOT, { fs: buildAdapter(ROOT, treeAfter) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const after = collectFiles(result.dataset.tree).find(
      (f) => f.name === 'sub-7538_ses-01_run-01_T1w.nii',
    )
    expect(after?.flags.pointer?.contentPresent).toBe(true)
  })

  test('detectPointersBatch path produces the same flags as the singular path', async () => {
    // Build an adapter that ONLY implements the batched probe (the
    // singular readLink + statFollowing still exist as required, but
    // we count batch calls to confirm the scanner used it).
    const annexBasename = 'MD5E-s2048--feedface.nii.gz'
    const tree: MockDir = {
      'dataset_description.json': {
        text: '{"Name":"x","BIDSVersion":"1.10.0"}',
      },
      'sub-01': {
        anat: {
          'sub-01_T1w.nii.gz': {
            isSymlink: true,
            targetExists: true,
            linkTarget: `../../.git/annex/objects/aB/cD/${annexBasename}/${annexBasename}`,
          },
          'sub-01_acq-hires_T1w.nii.gz': {
            isSymlink: true,
            // un-fetched
            linkTarget: `../../.git/annex/objects/aB/cD/${annexBasename}/${annexBasename}`,
          },
        },
      },
    }
    const base = buildAdapter(ROOT, tree)
    let batchCalls = 0
    let singularCalls = 0
    const adapter: FileSystemAdapter = {
      ...base,
      async readLink(path) {
        singularCalls++
        return base.readLink?.(path) as Promise<string>
      },
      async detectPointersBatch(paths) {
        batchCalls++
        const probes = []
        for (const p of paths) {
          const target = await base.readLink?.(p).catch(() => null)
          const sized = await base.statFollowing?.(p)
          probes.push({
            target: target ?? null,
            size: sized?.size ?? null,
            error: null,
          })
        }
        return probes
      },
    }
    const result = await scanDataset(ROOT, { fs: adapter })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(batchCalls).toBeGreaterThan(0)
    expect(singularCalls).toBe(0)
    const files = collectFiles(result.dataset.tree)
    const fetched = files.find((f) => f.name === 'sub-01_T1w.nii.gz')
    const unfetched = files.find(
      (f) => f.name === 'sub-01_acq-hires_T1w.nii.gz',
    )
    expect(fetched?.flags.pointer?.contentPresent).toBe(true)
    expect(unfetched?.flags.pointer?.contentPresent).toBe(false)
    expect(fetched?.flags.pointer?.size).toBe(2048)
  })

  test('detectPointersBatch error per entry treats path as not-a-pointer', async () => {
    const tree: MockDir = {
      'dataset_description.json': {
        text: '{"Name":"x","BIDSVersion":"1.10.0"}',
      },
      'sub-01': {
        anat: {
          'sub-01_T1w.nii.gz': {
            isSymlink: true,
            linkTarget: '../../shared/whatever.nii.gz',
          },
        },
      },
    }
    const base = buildAdapter(ROOT, tree)
    const adapter: FileSystemAdapter = {
      ...base,
      async detectPointersBatch(paths) {
        // Simulate Rust rejecting the path entirely (e.g., unauthorized
        // — though in production the scanner wouldn't reach an
        // unauthorized path).
        return paths.map(() => ({
          target: null,
          size: null,
          error: 'mock: not authorized',
        }))
      },
    }
    const result = await scanDataset(ROOT, { fs: adapter })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const files = collectFiles(result.dataset.tree)
    // Symlink stayed skipped (target null → not a pointer).
    expect(files.find((f) => f.name === 'sub-01_T1w.nii.gz')).toBeUndefined()
  })
})
