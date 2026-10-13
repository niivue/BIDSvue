import { describe, expect, test } from 'bun:test'
import { RelocateError, relocateImportRoot } from './relocate'

/** In-memory tree: a set of directory paths plus file paths. */
function memFs(dirs: string[], files: string[] = []) {
  const d = new Set(dirs)
  const f = new Set(files)
  const calls: string[] = []
  const children = (p: string) =>
    [...d, ...f].filter(
      (x) =>
        x !== p &&
        x.startsWith(`${p}/`) &&
        !x.slice(p.length + 1).includes('/'),
    )
  return {
    d,
    f,
    calls,
    fs: {
      exists: async (p: string) => d.has(p) || f.has(p),
      readDir: async (p: string) =>
        children(p).map((x) => ({
          name: x.slice(p.length + 1),
          isDirectory: d.has(x),
        })),
      rename: async (from: string, to: string) => {
        calls.push(`rename ${from} -> ${to}`)
        for (const set of [d, f]) {
          for (const x of [...set]) {
            if (x === from || x.startsWith(`${from}/`)) {
              set.delete(x)
              set.add(to + x.slice(from.length))
            }
          }
        }
      },
      remove: async (p: string) => {
        calls.push(`remove ${p}`)
        d.delete(p)
      },
    },
  }
}

const out = '/run/outputs/ingest'
const staging = `${out}/bidsvue-import`
const final = `${out}/bids`

describe('relocateImportRoot', () => {
  test('moves a locator-nested root to bids and prunes the empty locator folders', async () => {
    const root = `${staging}/crlab/generic`
    const m = memFs(
      [out, staging, `${staging}/crlab`, root, `${root}/sub-01`],
      [`${root}/dataset_description.json`],
    )
    expect(
      await relocateImportRoot({
        fs: m.fs,
        stagingDir: staging,
        roots: [root],
        finalRoot: final,
      }),
    ).toBe(final)
    expect(m.f.has(`${final}/dataset_description.json`)).toBe(true)
    expect(m.d.has(`${final}/sub-01`)).toBe(true)
    expect(m.d.has(staging)).toBe(false)
    expect(m.d.has(`${staging}/crlab`)).toBe(false)
  })

  test('keeps staging folders that still hold converter leftovers', async () => {
    const root = `${staging}/crlab/generic`
    const m = memFs([
      out,
      staging,
      `${staging}/crlab`,
      root,
      `${staging}/.heudiconv`,
    ])
    await relocateImportRoot({
      fs: m.fs,
      stagingDir: staging,
      roots: [root],
      finalRoot: final,
    })
    expect(m.d.has(`${staging}/crlab`)).toBe(false)
    expect(m.d.has(staging)).toBe(true)
  })

  test('renames the staging folder itself when it is the root', async () => {
    const m = memFs(
      [out, staging, `${staging}/sub-01`],
      [`${staging}/dataset_description.json`],
    )
    await relocateImportRoot({
      fs: m.fs,
      stagingDir: `${staging}/`,
      roots: [],
      finalRoot: final,
    })
    expect(m.calls).toEqual([`rename ${staging} -> ${final}`])
    expect(m.d.has(`${final}/sub-01`)).toBe(true)
  })

  test('refuses several roots without touching the disk', async () => {
    const m = memFs([out, staging])
    const p = relocateImportRoot({
      fs: m.fs,
      stagingDir: staging,
      roots: [`${staging}/a`, `${staging}/b`],
      finalRoot: final,
    })
    await expect(p).rejects.toBeInstanceOf(RelocateError)
    expect(m.calls).toEqual([])
  })

  test('refuses to overwrite an existing bids folder', async () => {
    const m = memFs([out, staging, `${staging}/x`, final])
    await expect(
      relocateImportRoot({
        fs: m.fs,
        stagingDir: staging,
        roots: [`${staging}/x`],
        finalRoot: final,
      }),
    ).rejects.toThrow('already exists')
    expect(m.calls).toEqual([])
  })

  test('refuses a root outside the staging folder', async () => {
    const m = memFs([out, staging, '/elsewhere'])
    await expect(
      relocateImportRoot({
        fs: m.fs,
        stagingDir: staging,
        roots: ['/elsewhere'],
        finalRoot: final,
      }),
    ).rejects.toThrow('outside the staging folder')
  })
})
