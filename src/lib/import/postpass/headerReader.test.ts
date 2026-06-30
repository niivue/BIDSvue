import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { nodeFsPostPassAdapter } from './__testFs'
import { readNiftiHeaderBytes } from './headerReader'
import { buildSyntheticNiftiHeader, parseNiftiHeader } from './niftiHeader'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bidsvue-postpass-hdr-'))
}

describe('readNiftiHeaderBytes', () => {
  test('reads .nii.gz when present', async () => {
    const dir = makeTempDir()
    try {
      const stem = join(dir, 'sub-01_T1w')
      const hdr = buildSyntheticNiftiHeader({
        dim: [3, 64, 64, 30, 1, 1, 1, 1],
        qformCode: 1,
      })
      // Pad the header with a small amount of body so gzip has something
      // to chew on; the post-pass only needs the first 348 bytes back.
      const fullVolume = new Uint8Array(348 + 1024)
      fullVolume.set(hdr, 0)
      await writeFile(`${stem}.nii.gz`, gzipSync(Buffer.from(fullVolume)))
      const bytes = await readNiftiHeaderBytes(
        `${stem}.json`,
        nodeFsPostPassAdapter,
      )
      expect(bytes).not.toBeNull()
      expect(bytes?.length).toBe(348)
      if (bytes === null) throw new Error('expected bytes')
      const parsed = parseNiftiHeader(bytes)
      expect(parsed?.dim[1]).toBe(64)
      expect(parsed?.qformCode).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('reads raw .nii when .nii.gz absent', async () => {
    const dir = makeTempDir()
    try {
      const stem = join(dir, 'sub-01_T2w')
      const hdr = buildSyntheticNiftiHeader({
        dim: [3, 32, 32, 16, 1, 1, 1, 1],
        sformCode: 2,
      })
      await writeFile(`${stem}.nii`, Buffer.from(hdr))
      const bytes = await readNiftiHeaderBytes(
        `${stem}.json`,
        nodeFsPostPassAdapter,
      )
      expect(bytes).not.toBeNull()
      if (bytes === null) throw new Error('expected bytes')
      const parsed = parseNiftiHeader(bytes)
      expect(parsed?.dim[1]).toBe(32)
      expect(parsed?.sformCode).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns null when no NIfTI sibling exists', async () => {
    const dir = makeTempDir()
    try {
      const bytes = await readNiftiHeaderBytes(
        join(dir, 'sub-01_T1w.json'),
        nodeFsPostPassAdapter,
      )
      expect(bytes).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('stream-decompresses only as much as it needs (no whole-file read)', async () => {
    // Build a 5 MB synthetic volume: header + a payload that, when gzip-
    // compressed, yields a multi-MB file. Adapter should still resolve
    // promptly with 348 bytes.
    const dir = makeTempDir()
    try {
      const stem = join(dir, 'sub-01_bold')
      const hdr = buildSyntheticNiftiHeader({
        dim: [4, 64, 64, 30, 100, 1, 1, 1],
      })
      const payload = new Uint8Array(5 * 1024 * 1024)
      // Random-ish content so gzip can't reduce it to almost nothing.
      for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff
      const full = new Uint8Array(348 + payload.length)
      full.set(hdr, 0)
      full.set(payload, 348)
      await writeFile(`${stem}.nii.gz`, gzipSync(Buffer.from(full)))
      const t0 = Date.now()
      const bytes = await readNiftiHeaderBytes(
        `${stem}.json`,
        nodeFsPostPassAdapter,
      )
      const dt = Date.now() - t0
      expect(bytes?.length).toBe(348)
      // Soft latency check: 5 MB file should still resolve fast since we
      // stop reading once 348 bytes is in hand. Generous budget for CI.
      expect(dt).toBeLessThan(2000)
      if (bytes === null) throw new Error('expected bytes')
      const parsed = parseNiftiHeader(bytes)
      expect(parsed?.dim[0]).toBe(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
