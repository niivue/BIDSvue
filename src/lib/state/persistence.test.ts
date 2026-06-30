// Per-dataset prefs round-trip via the FS adapter. Mirrors the scanner's
// node:fs-adapter pattern so the tests run outside the Tauri runtime.
//
// App-level prefs (LazyStore-backed) are smoke-tested manually -- mocking the
// store package isn't worth the complexity for what's effectively a
// thin key/value wrapper.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type PersistenceFs,
  absolutizeFromRoot,
  datasetPrefsLocation,
  isSafeRelativeChildPath,
  loadDatasetPrefs,
  relativizeFromRoot,
  saveDatasetPrefs,
} from './persistence'

const nodeFs: PersistenceFs = {
  async exists(path) {
    try {
      await readFile(path)
      return true
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return false
      // Directory: readFile fails with EISDIR; that means it exists.
      if (err.code === 'EISDIR') return true
      throw e
    }
  },
  async mkdir(path, options) {
    await mkdir(path, { recursive: options.recursive })
  },
  async readTextFile(path) {
    return await readFile(path, 'utf8')
  },
  async writeTextFile(path, contents) {
    await writeFile(path, contents, 'utf8')
  },
}

const tempRoots: string[] = []

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bidsvue-persist-'))
  tempRoots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots.length = 0
})

describe('relativizeFromRoot / absolutizeFromRoot', () => {
  test('relativizes a child path under POSIX root', () => {
    expect(relativizeFromRoot('/tmp/dataset', '/tmp/dataset/sub-01/anat')).toBe(
      'sub-01/anat',
    )
  })

  test('returns empty string when path equals root', () => {
    expect(relativizeFromRoot('/tmp/dataset', '/tmp/dataset')).toBe('')
  })

  test('returns null when path is outside the root', () => {
    expect(relativizeFromRoot('/tmp/dataset', '/tmp/other/file')).toBeNull()
    expect(relativizeFromRoot('/tmp/dataset', '/tmp/datasetX/file')).toBeNull()
  })

  test('round-trips relative <-> absolute', () => {
    const root = '/tmp/x/dataset'
    const abs = '/tmp/x/dataset/sub-01/ses-01/anat'
    const rel = relativizeFromRoot(root, abs)
    expect(rel).not.toBeNull()
    expect(absolutizeFromRoot(root, rel as string)).toBe(abs)
  })

  test('handles trailing separators on the root', () => {
    expect(relativizeFromRoot('/tmp/dataset/', '/tmp/dataset/sub-01')).toBe(
      'sub-01',
    )
    expect(absolutizeFromRoot('/tmp/dataset/', 'sub-01')).toBe(
      '/tmp/dataset/sub-01',
    )
  })

  test('uses backslash separator when root looks Windows-ish', () => {
    expect(
      relativizeFromRoot('C:\\data\\study', 'C:\\data\\study\\sub-01'),
    ).toBe('sub-01')
    expect(absolutizeFromRoot('C:\\data\\study', 'sub-01/anat')).toBe(
      'C:\\data\\study\\sub-01\\anat',
    )
  })
})

describe('datasetPrefsLocation', () => {
  test('places prefs.json directly under the per-dataset state dir', () => {
    // Post M6 close-out: the function takes the already-resolved
    // state-dir (under app-data) and returns the prefs file path
    // beside it. No more nested `.bidsvue/`.
    const { dir, file } = datasetPrefsLocation('/tmp/state/abc123')
    expect(dir).toBe('/tmp/state/abc123')
    expect(file).toBe('/tmp/state/abc123/prefs.json')
  })
})

describe('loadDatasetPrefs', () => {
  test('returns null when the prefs file does not exist', async () => {
    const stateDir = makeTempRoot()
    const result = await loadDatasetPrefs(stateDir, nodeFs)
    expect(result).toBeNull()
  })

  test('reads expanded folders from disk', async () => {
    const stateDir = makeTempRoot()
    await writeFile(
      join(stateDir, 'prefs.json'),
      JSON.stringify({
        schemaVersion: 1,
        expandedFolders: ['sub-01', 'sub-01/anat', 'sub-02'],
      }),
    )
    const result = await loadDatasetPrefs(stateDir, nodeFs)
    expect(result).toEqual({
      schemaVersion: 1,
      expandedFolders: ['sub-01', 'sub-01/anat', 'sub-02'],
    })
  })

  test('returns null on malformed JSON without throwing', async () => {
    const stateDir = makeTempRoot()
    await writeFile(join(stateDir, 'prefs.json'), '{not json')
    const result = await loadDatasetPrefs(stateDir, nodeFs)
    expect(result).toBeNull()
  })

  test('drops non-string entries from expandedFolders', async () => {
    const stateDir = makeTempRoot()
    await writeFile(
      join(stateDir, 'prefs.json'),
      JSON.stringify({
        schemaVersion: 1,
        expandedFolders: ['sub-01', 42, null, 'sub-02'],
      }),
    )
    const result = await loadDatasetPrefs(stateDir, nodeFs)
    expect(result?.expandedFolders).toEqual(['sub-01', 'sub-02'])
  })
})

describe('isSafeRelativeChildPath', () => {
  test('accepts ordinary relative paths', () => {
    expect(isSafeRelativeChildPath('sub-01')).toBe(true)
    expect(isSafeRelativeChildPath('sub-01/anat')).toBe(true)
    expect(isSafeRelativeChildPath('sub-01/ses-01/func')).toBe(true)
  })

  test('rejects empty string and root markers', () => {
    expect(isSafeRelativeChildPath('')).toBe(false)
    expect(isSafeRelativeChildPath('/')).toBe(false)
    expect(isSafeRelativeChildPath('\\')).toBe(false)
  })

  test('rejects absolute POSIX paths', () => {
    expect(isSafeRelativeChildPath('/etc/passwd')).toBe(false)
    expect(isSafeRelativeChildPath('/Users/chris/secrets')).toBe(false)
  })

  test('rejects Windows drive letters and UNC-style paths', () => {
    expect(isSafeRelativeChildPath('C:\\Users')).toBe(false)
    expect(isSafeRelativeChildPath('c:/Users')).toBe(false)
    expect(isSafeRelativeChildPath('\\\\server\\share')).toBe(false)
  })

  test('rejects any segment that is exactly ".."', () => {
    expect(isSafeRelativeChildPath('..')).toBe(false)
    expect(isSafeRelativeChildPath('../etc')).toBe(false)
    expect(isSafeRelativeChildPath('sub-01/../sub-02')).toBe(false)
    expect(isSafeRelativeChildPath('a\\b\\..\\c')).toBe(false)
  })

  test('does not reject inert ".." substrings inside a segment', () => {
    expect(isSafeRelativeChildPath('sub-..weird')).toBe(true)
    expect(isSafeRelativeChildPath('a..b/c')).toBe(true)
  })
})

describe('loadDatasetPrefs filters tampered expandedFolders entries', () => {
  test('drops entries that would escape the dataset root', async () => {
    const stateDir = makeTempRoot()
    await writeFile(
      join(stateDir, 'prefs.json'),
      JSON.stringify({
        schemaVersion: 1,
        expandedFolders: [
          'sub-01',
          '../../../etc',
          '/absolute/path',
          'sub-01/../../../escape',
          'C:\\Windows',
          'sub-02',
        ],
      }),
    )
    const result = await loadDatasetPrefs(stateDir, nodeFs)
    expect(result?.expandedFolders).toEqual(['sub-01', 'sub-02'])
  })
})

describe('saveDatasetPrefs', () => {
  test('writes prefs.json directly under the state dir', async () => {
    const stateDir = makeTempRoot()
    await saveDatasetPrefs(
      stateDir,
      { schemaVersion: 1, expandedFolders: ['sub-01'] },
      nodeFs,
    )
    const written = await readFile(join(stateDir, 'prefs.json'), 'utf8')
    const parsed = JSON.parse(written)
    expect(parsed.expandedFolders).toEqual(['sub-01'])
    expect(parsed.schemaVersion).toBe(1)
  })

  test('sorts expanded folders so the file is diff-friendly', async () => {
    const stateDir = makeTempRoot()
    await saveDatasetPrefs(
      stateDir,
      {
        schemaVersion: 1,
        expandedFolders: ['sub-02', 'sub-01', 'sub-01/anat'],
      },
      nodeFs,
    )
    const parsed = JSON.parse(
      await readFile(join(stateDir, 'prefs.json'), 'utf8'),
    )
    expect(parsed.expandedFolders).toEqual(['sub-01', 'sub-01/anat', 'sub-02'])
  })

  test('round-trips: save -> load reproduces input', async () => {
    const stateDir = makeTempRoot()
    const prefs = {
      schemaVersion: 1,
      expandedFolders: ['sub-01', 'sub-01/anat', 'sub-02', 'sub-02/func'],
    }
    await saveDatasetPrefs(stateDir, prefs, nodeFs)
    const reloaded = await loadDatasetPrefs(stateDir, nodeFs)
    expect(reloaded).toEqual({
      ...prefs,
      expandedFolders: [...prefs.expandedFolders].sort(),
    })
  })

  test('overwrites an existing prefs file', async () => {
    const stateDir = makeTempRoot()
    await saveDatasetPrefs(
      stateDir,
      { schemaVersion: 1, expandedFolders: ['a'] },
      nodeFs,
    )
    await saveDatasetPrefs(
      stateDir,
      { schemaVersion: 1, expandedFolders: ['b'] },
      nodeFs,
    )
    const reloaded = await loadDatasetPrefs(stateDir, nodeFs)
    expect(reloaded?.expandedFolders).toEqual(['b'])
  })
})
