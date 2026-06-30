import { describe, expect, test } from 'bun:test'
import { buildSyntheticNiftiHeader, parseNiftiHeader } from './niftiHeader'

describe('parseNiftiHeader', () => {
  test('round-trips a little-endian header', () => {
    const buf = buildSyntheticNiftiHeader({
      dim: [3, 64, 64, 30, 1, 1, 1, 1],
      pixdim: [-1, 2, 2, 2.5, 1, 1, 1, 1],
      qformCode: 1,
      sformCode: 2,
      quaternBCD: [0.1, 0.2, 0.3],
      qoffsetXYZ: [-32, -32, -15],
      srowX: [2, 0, 0, -32],
      srowY: [0, 2, 0, -32],
      srowZ: [0, 0, 2.5, -15],
    })
    const hdr = parseNiftiHeader(buf)
    expect(hdr).not.toBeNull()
    if (hdr === null) return
    expect(hdr.endianness).toBe('le')
    expect(hdr.dim[1]).toBe(64)
    expect(hdr.dim[2]).toBe(64)
    expect(hdr.dim[3]).toBe(30)
    expect(hdr.pixdim[0]).toBeCloseTo(-1, 5)
    expect(hdr.pixdim[1]).toBeCloseTo(2, 5)
    expect(hdr.qformCode).toBe(1)
    expect(hdr.sformCode).toBe(2)
    expect(hdr.quaternBCD[0]).toBeCloseTo(0.1, 5)
    expect(hdr.srowX[0]).toBeCloseTo(2, 5)
    expect(hdr.srowZ[3]).toBeCloseTo(-15, 5)
  })

  test('big-endian header is detected and parsed', () => {
    const buf = buildSyntheticNiftiHeader({
      bigEndian: true,
      dim: [3, 16, 16, 8, 1, 1, 1, 1],
      qformCode: 1,
    })
    const hdr = parseNiftiHeader(buf)
    expect(hdr).not.toBeNull()
    if (hdr === null) return
    expect(hdr.endianness).toBe('be')
    expect(hdr.dim[1]).toBe(16)
    expect(hdr.qformCode).toBe(1)
  })

  test('rejects buffer shorter than 348 bytes', () => {
    expect(parseNiftiHeader(new Uint8Array(347))).toBeNull()
  })

  test('rejects buffer with wrong sizeof_hdr (NIfTI-2 540 or random)', () => {
    const buf = new Uint8Array(348)
    new DataView(buf.buffer).setInt32(0, 540, true)
    expect(parseNiftiHeader(buf)).toBeNull()
    new DataView(buf.buffer).setInt32(0, 0, true)
    expect(parseNiftiHeader(buf)).toBeNull()
  })
})
