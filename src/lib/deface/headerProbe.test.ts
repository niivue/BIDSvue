import { describe, expect, test } from 'bun:test'
import { gunzipSync, gzipSync } from 'fflate'
import {
  FourDRejectedError,
  NIFTI_DT_COMPLEX64,
  NIFTI_DT_COMPLEX128,
  NIFTI_DT_COMPLEX256,
  NIFTI_HEADER_PROBE_SIZE,
  type PartialReadFs,
  classifyNiftiKind,
  ensureNotFourD,
  parseNiftiHeaderBytes,
  probeNiftiDimensions,
  probeNiftiKind,
} from './headerProbe'

/**
 * Build a synthetic NIfTI-1 header. Fills the first 352 bytes with the
 * minimum fields the probe inspects: sizeof_hdr (offset 0), dim[0..7]
 * (offset 40), datatype (offset 70). Everything else stays zero — the
 * probe ignores it.
 */
function makeHeader(
  rank: number,
  dims: [number, number, number, number, number, number, number],
  opts: { bigEndian?: boolean; sizeofHdr?: number; datatype?: number } = {},
): Uint8Array {
  const buf = new Uint8Array(352)
  const view = new DataView(buf.buffer)
  const little = !opts.bigEndian
  view.setInt32(0, opts.sizeofHdr ?? 348, little)
  view.setInt16(40, rank, little)
  view.setInt16(42, dims[0], little)
  view.setInt16(44, dims[1], little)
  view.setInt16(46, dims[2], little)
  view.setInt16(48, dims[3], little)
  view.setInt16(50, dims[4], little)
  view.setInt16(52, dims[5], little)
  view.setInt16(54, dims[6], little)
  view.setInt16(70, opts.datatype ?? 16, little) // datatype = FLOAT32 by default
  return buf
}

/** In-memory PartialReadFs scoped to one path. Both methods return the
 *  same bytes; `readPartialGzipBytes` re-gunzips the gzipped payload
 *  the caller supplied so the path's extension drives which method
 *  the probe picks. */
function makeFs(entries: Record<string, Uint8Array>): PartialReadFs {
  return {
    async readPartialBytes(path, size) {
      const v = entries[path]
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return v.subarray(0, Math.min(size, v.byteLength))
    },
    async readPartialGzipBytes(path, size) {
      const v = entries[path]
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      const decompressed = unzipBytes(v)
      return decompressed.subarray(0, Math.min(size, decompressed.byteLength))
    },
  }
}

function unzipBytes(bytes: Uint8Array): Uint8Array {
  return gunzipSync(bytes)
}

describe('parseNiftiHeaderBytes', () => {
  test('reads dims from a little-endian NIfTI-1 header', () => {
    const hdr = makeHeader(3, [192, 256, 256, 1, 1, 1, 1])
    const dims = parseNiftiHeaderBytes(hdr)
    expect(dims).toEqual({
      rank: 3,
      dim1: 192,
      dim2: 256,
      dim3: 256,
      dim4: 1,
      datatype: 16,
    })
  })

  test('reads dims from a big-endian NIfTI-1 header', () => {
    const hdr = makeHeader(3, [192, 256, 256, 1, 1, 1, 1], { bigEndian: true })
    const dims = parseNiftiHeaderBytes(hdr)
    expect(dims).toEqual({
      rank: 3,
      dim1: 192,
      dim2: 256,
      dim3: 256,
      dim4: 1,
      datatype: 16,
    })
  })

  test('reads datatype from NIfTI-1 header', () => {
    const hdr = makeHeader(4, [1, 1, 1, 2048, 1, 1, 1], {
      datatype: NIFTI_DT_COMPLEX64,
    })
    const dims = parseNiftiHeaderBytes(hdr)
    expect(dims.datatype).toBe(NIFTI_DT_COMPLEX64)
  })

  test('reads a 4D BOLD header', () => {
    const hdr = makeHeader(4, [64, 64, 36, 280, 1, 1, 1])
    const dims = parseNiftiHeaderBytes(hdr)
    expect(dims.rank).toBe(4)
    expect(dims.dim4).toBe(280)
  })

  test('rejects NIfTI-2 (sizeof_hdr=540)', () => {
    const hdr = makeHeader(3, [192, 256, 256, 1, 1, 1, 1], {
      sizeofHdr: 540,
    })
    expect(() => parseNiftiHeaderBytes(hdr, 'x.nii')).toThrow(/NIfTI-2/)
  })

  test('rejects garbage sizeof_hdr', () => {
    const hdr = makeHeader(3, [192, 256, 256, 1, 1, 1, 1], {
      sizeofHdr: 12345,
    })
    expect(() => parseNiftiHeaderBytes(hdr, 'x.nii')).toThrow(
      /not a valid NIfTI-1 header/,
    )
  })

  test('rejects rank outside 1..7', () => {
    const hdr = makeHeader(0, [1, 1, 1, 1, 1, 1, 1])
    expect(() => parseNiftiHeaderBytes(hdr, 'x.nii')).toThrow(/dim\[0\]/)
  })

  test('rejects too-small buffer', () => {
    expect(() => parseNiftiHeaderBytes(new Uint8Array(40), 'x.nii')).toThrow(
      /need at least 70/,
    )
  })
})

describe('probeNiftiDimensions', () => {
  test('reads raw .nii via readPartialBytes', async () => {
    const hdr = makeHeader(3, [192, 256, 256, 1, 1, 1, 1])
    const fs = makeFs({ '/T1w.nii': hdr })
    const dims = await probeNiftiDimensions('/T1w.nii', fs)
    expect(dims.rank).toBe(3)
    expect(dims.dim4).toBe(1)
  })

  test('reads gzipped .nii.gz via readPartialGzipBytes', async () => {
    const hdr = makeHeader(4, [64, 64, 36, 280, 1, 1, 1])
    const gzipped = gzipSync(hdr)
    const fs = makeFs({ '/sub-01_bold.nii.gz': gzipped })
    const dims = await probeNiftiDimensions('/sub-01_bold.nii.gz', fs)
    expect(dims.rank).toBe(4)
    expect(dims.dim4).toBe(280)
  })

  test('rejects unknown extension', async () => {
    const fs = makeFs({})
    await expect(probeNiftiDimensions('/x.png', fs)).rejects.toThrow(
      /not a NIfTI path/,
    )
  })

  test('asks for exactly the probe-size budget', async () => {
    const hdr = makeHeader(3, [192, 256, 256, 1, 1, 1, 1])
    let requested = -1
    const fs: PartialReadFs = {
      async readPartialBytes(_path, size) {
        requested = size
        return hdr
      },
      async readPartialGzipBytes() {
        throw new Error('unused')
      },
    }
    await probeNiftiDimensions('/T1w.nii', fs)
    expect(requested).toBe(NIFTI_HEADER_PROBE_SIZE)
  })
})

describe('ensureNotFourD', () => {
  test('accepts 3D T1w', async () => {
    const hdr = makeHeader(3, [192, 256, 256, 1, 1, 1, 1])
    const fs = makeFs({ '/T1w.nii': hdr })
    await expect(ensureNotFourD('/T1w.nii', fs)).resolves.toBeUndefined()
  })

  test('rejects 4D BOLD by rank', async () => {
    const hdr = makeHeader(4, [64, 64, 36, 280, 1, 1, 1])
    const fs = makeFs({ '/bold.nii': hdr })
    await expect(ensureNotFourD('/bold.nii', fs)).rejects.toBeInstanceOf(
      FourDRejectedError,
    )
  })

  test('rejects rank=3 but dim[4]>1 (degenerate 4D)', async () => {
    // Some pipelines write rank=3 with a sneaky non-trivial dim[4].
    // The Day-1 plan calls for `dim[4] > 1` to also reject.
    const hdr = makeHeader(3, [192, 256, 256, 17, 1, 1, 1])
    const fs = makeFs({ '/oddball.nii': hdr })
    await expect(ensureNotFourD('/oddball.nii', fs)).rejects.toBeInstanceOf(
      FourDRejectedError,
    )
  })

  test('error message names the path, rank, and dim[4]', async () => {
    const hdr = makeHeader(4, [64, 64, 36, 280, 1, 1, 1])
    const fs = makeFs({ '/sub-99_bold.nii': hdr })
    try {
      await ensureNotFourD('/sub-99_bold.nii', fs)
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(FourDRejectedError)
      const e = err as FourDRejectedError
      expect(e.path).toBe('/sub-99_bold.nii')
      expect(e.rank).toBe(4)
      expect(e.dim4).toBe(280)
      expect(e.message).toContain('sub-99_bold.nii')
      expect(e.message).toContain('rank=4')
      expect(e.message).toContain('dim[4]=280')
    }
  })
})

describe('classifyNiftiKind', () => {
  test("single-voxel NIfTI-MRS (1x1x1xN) routes to 'svs'", () => {
    expect(
      classifyNiftiKind({
        rank: 4,
        dim1: 1,
        dim2: 1,
        dim3: 1,
        dim4: 2048,
        datatype: NIFTI_DT_COMPLEX64,
      }),
    ).toBe('svs')
  })

  test("non-complex 1x1x1xN still routes to 'svs' (dim-only rule)", () => {
    // Mirrors NiiVue's niftiBufferIsSignal: datatype is NOT consulted for
    // signal detection — the signal reader handles non-complex 1-D buffers.
    expect(
      classifyNiftiKind({
        rank: 4,
        dim1: 1,
        dim2: 1,
        dim3: 1,
        dim4: 1024,
        datatype: 16, // FLOAT32
      }),
    ).toBe('svs')
  })

  test("MRSI (complex + spatial extent) routes to 'file-only'", () => {
    expect(
      classifyNiftiKind({
        rank: 4,
        dim1: 16,
        dim2: 16,
        dim3: 8,
        dim4: 2048,
        datatype: NIFTI_DT_COMPLEX64,
      }),
    ).toBe('file-only')
  })

  test("COMPLEX128 + spatial extent also routes to 'file-only'", () => {
    expect(
      classifyNiftiKind({
        rank: 3,
        dim1: 32,
        dim2: 32,
        dim3: 16,
        dim4: 1,
        datatype: NIFTI_DT_COMPLEX128,
      }),
    ).toBe('file-only')
  })

  test("COMPLEX256 + spatial extent also routes to 'file-only'", () => {
    // Long-double complex (datatype 2048). Very rare in BIDS, but
    // routing it to NiivueViewer would crash the volume parser.
    expect(
      classifyNiftiKind({
        rank: 3,
        dim1: 32,
        dim2: 32,
        dim3: 16,
        dim4: 1,
        datatype: NIFTI_DT_COMPLEX256,
      }),
    ).toBe('file-only')
  })

  test("3D T1w (uint16, spatial) routes to 'volume'", () => {
    expect(
      classifyNiftiKind({
        rank: 3,
        dim1: 192,
        dim2: 256,
        dim3: 256,
        dim4: 1,
        datatype: 4, // INT16
      }),
    ).toBe('volume')
  })

  test("4D BOLD (uint16, spatial) routes to 'volume'", () => {
    expect(
      classifyNiftiKind({
        rank: 4,
        dim1: 64,
        dim2: 64,
        dim3: 36,
        dim4: 280,
        datatype: 4,
      }),
    ).toBe('volume')
  })

  test("complex with zero spatial extent (1x1x1x1) routes to 'volume' (fail-open)", () => {
    expect(
      classifyNiftiKind({
        rank: 1,
        dim1: 1,
        dim2: 1,
        dim3: 1,
        dim4: 1,
        datatype: NIFTI_DT_COMPLEX64,
      }),
    ).toBe('volume')
  })
})

describe('probeNiftiKind', () => {
  test("reads a real SVS-shaped .nii as 'svs'", async () => {
    const hdr = makeHeader(4, [1, 1, 1, 2048, 1, 1, 1], {
      datatype: NIFTI_DT_COMPLEX64,
    })
    const fs = makeFs({ '/svs.nii': hdr })
    expect(await probeNiftiKind('/svs.nii', fs)).toBe('svs')
  })

  test("reads a gzipped SVS .nii.gz as 'svs'", async () => {
    const hdr = makeHeader(4, [1, 1, 1, 1024, 1, 1, 1], {
      datatype: NIFTI_DT_COMPLEX64,
    })
    const gzipped = gzipSync(hdr)
    const fs = makeFs({ '/sub-01_run-01_svs.nii.gz': gzipped })
    expect(await probeNiftiKind('/sub-01_run-01_svs.nii.gz', fs)).toBe('svs')
  })

  test("reads a MRSI .nii.gz as 'file-only'", async () => {
    const hdr = makeHeader(4, [16, 16, 8, 2048, 1, 1, 1], {
      datatype: NIFTI_DT_COMPLEX64,
    })
    const gzipped = gzipSync(hdr)
    const fs = makeFs({ '/mrsi.nii.gz': gzipped })
    expect(await probeNiftiKind('/mrsi.nii.gz', fs)).toBe('file-only')
  })

  test("reads a regular T1w as 'volume'", async () => {
    const hdr = makeHeader(3, [192, 256, 256, 1, 1, 1, 1])
    const fs = makeFs({ '/T1w.nii.gz': gzipSync(hdr) })
    expect(await probeNiftiKind('/T1w.nii.gz', fs)).toBe('volume')
  })

  test("fails open to 'volume' on ENOENT", async () => {
    const fs = makeFs({})
    expect(await probeNiftiKind('/missing.nii.gz', fs)).toBe('volume')
  })

  test("fails open to 'volume' on non-NIfTI extension", async () => {
    const fs = makeFs({})
    expect(await probeNiftiKind('/image.png', fs)).toBe('volume')
  })

  test("fails open to 'volume' on NIfTI-2", async () => {
    const hdr = makeHeader(3, [192, 256, 256, 1, 1, 1, 1], { sizeofHdr: 540 })
    const fs = makeFs({ '/T1w.nii': hdr })
    expect(await probeNiftiKind('/T1w.nii', fs)).toBe('volume')
  })

  test("fails open to 'volume' on truncated header", async () => {
    const fs: PartialReadFs = {
      async readPartialBytes() {
        return new Uint8Array(40) // less than the 70-byte parse minimum
      },
      async readPartialGzipBytes() {
        return new Uint8Array(40)
      },
    }
    expect(await probeNiftiKind('/short.nii', fs)).toBe('volume')
  })
})
