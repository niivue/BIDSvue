import { describe, expect, test } from 'bun:test'

import { type TarEntry, buildTar } from './tar'

function readField(buf: Uint8Array, start: number, len: number): string {
  let end = start
  while (end < start + len && buf[end] !== 0) end++
  return new TextDecoder().decode(buf.subarray(start, end))
}

function readOctal(buf: Uint8Array, start: number, len: number): number {
  const s = readField(buf, start, len).trim()
  return s === '' ? 0 : Number.parseInt(s, 8)
}

const HEADER = 512
const BLOCK = 512

describe('buildTar', () => {
  test('emits the USTAR magic + version', () => {
    const entry: TarEntry = {
      path: 'foo',
      contents: new Uint8Array([1, 2, 3]),
    }
    const tar = buildTar([entry])
    expect(readField(tar, 257, 6)).toBe('ustar')
    expect(tar[263]).toBe(0x30) // '0'
    expect(tar[264]).toBe(0x30)
  })

  test('writes name, size and mode', () => {
    const entry: TarEntry = {
      path: 'a/b/c.txt',
      contents: new TextEncoder().encode('hello'),
      mode: 0o644,
    }
    const tar = buildTar([entry])
    expect(readField(tar, 0, 100)).toBe('a/b/c.txt')
    expect(readOctal(tar, 100, 8)).toBe(0o644)
    expect(readOctal(tar, 124, 12)).toBe(5)
  })

  test('writes file body padded to a 512-byte block', () => {
    const entry: TarEntry = {
      path: 'small.bin',
      contents: new Uint8Array([0xaa, 0xbb, 0xcc]),
    }
    const tar = buildTar([entry])
    const body = tar.subarray(HEADER, HEADER + 3)
    expect(Array.from(body)).toEqual([0xaa, 0xbb, 0xcc])
    // The remaining bytes of the data block are zero padding.
    for (let i = HEADER + 3; i < HEADER + BLOCK; i++) {
      expect(tar[i]).toBe(0)
    }
  })

  test('appends two zero-block end-of-archive terminator', () => {
    const tar = buildTar([{ path: 'a', contents: new Uint8Array([1]) }])
    // total = 512 (header) + 512 (padded data) + 2*512 (terminator)
    expect(tar.length).toBe(HEADER + BLOCK + 2 * BLOCK)
    // The last two blocks are entirely zero.
    for (let i = tar.length - 2 * BLOCK; i < tar.length; i++) {
      expect(tar[i]).toBe(0)
    }
  })

  test('checksum equals the sum of all 512 header bytes (with the cksum field treated as spaces)', () => {
    const entry: TarEntry = {
      path: 'check.bin',
      contents: new Uint8Array([0]),
    }
    const tar = buildTar([entry])
    // Re-compute the expected checksum by zeroing the cksum field
    // (148..156) to spaces and summing.
    let sum = 0
    for (let i = 0; i < HEADER; i++) {
      if (i >= 148 && i < 156) sum += 0x20
      else sum += tar[i]
    }
    expect(readOctal(tar, 148, 8)).toBe(sum)
  })

  test('supports multiple entries in deterministic order', () => {
    const tar = buildTar([
      { path: 'first.txt', contents: new TextEncoder().encode('one') },
      { path: 'second.txt', contents: new TextEncoder().encode('two!') },
    ])
    expect(readField(tar, 0, 100)).toBe('first.txt')
    expect(readField(tar, HEADER + BLOCK, 100)).toBe('second.txt')
  })

  test('uses prefix field for paths >100 chars', () => {
    // 109-char path. The splitter walks left → right looking for the
    // first `/` that leaves ≤100 chars on the right, which yields
    // prefix="sub-01/<50 a's>", name="<40 b's>/T1w.nii.gz".
    const longDir = `sub-01/${'a'.repeat(50)}/${'b'.repeat(40)}`
    const path = `${longDir}/T1w.nii.gz`
    const tar = buildTar([{ path, contents: new Uint8Array([0]) }])
    const name = readField(tar, 0, 100)
    const prefix = readField(tar, 345, 155)
    expect(prefix.length).toBeGreaterThan(0)
    expect(name.length).toBeGreaterThan(0)
    expect(`${prefix}/${name}`).toBe(path)
  })

  test('rejects empty path', () => {
    expect(() => buildTar([{ path: '', contents: new Uint8Array() }])).toThrow(
      /empty/,
    )
  })
})
