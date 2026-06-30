import { describe, expect, test } from 'bun:test'
import {
  FIFF_DIG,
  FIFF_KIND,
  parseFif,
  recordingDurationSeconds,
} from './header'

// ---------------------------------------------------------------------------
// Test-only writer: build a synthetic FIFF tag stream with explicit
// field values. The layout mirrors `parseFif`'s read order exactly;
// if a field is added/removed there it must be added/removed here,
// kept in lockstep with `mne/_fiff/tag.py`.
//
// Each tag is 16-byte header (kind/type/size/next) + size-byte
// payload. We don't write a directory pointer or block-nesting tags
// because the parser doesn't track nesting -- it just picks up the
// tags it knows by kind.
// ---------------------------------------------------------------------------

interface SyntheticChannel {
  scanno: number
  logno: number
  kind: number
  range: number
  cal: number
  coilType: number
  loc: readonly number[] // 12 floats; auto-padded with zeros if shorter
  unit: number
  unitMul: number
  name: string
}

interface SyntheticDigPoint {
  kind: number
  ident: number
  r: readonly [number, number, number]
}

interface SyntheticFif {
  sfreq: number
  nchan: number
  firstSample?: number
  lastSample?: number
  lineFreq?: number
  measDateSeconds?: number
  measDateMicros?: number
  channels: SyntheticChannel[]
  digPoints?: SyntheticDigPoint[]
}

const FIFFT_INT = 3
const FIFFT_FLOAT = 4
const FIFFT_DIG_POINT_STRUCT = 33
const FIFFT_CH_INFO_STRUCT = 30
const FIFFV_NEXT_SEQ = 0
const FIFFV_NEXT_NONE = -1

const TAGS = {
  FIFF_NCHAN: 200,
  FIFF_SFREQ: 201,
  FIFF_CH_INFO: 203,
  FIFF_MEAS_DATE: 204,
  FIFF_FIRST_SAMPLE: 208,
  FIFF_LAST_SAMPLE: 209,
  FIFF_DIG_POINT: 213,
  FIFF_LINE_FREQ: 235,
}

class Writer {
  private chunks: Uint8Array[] = []
  private size = 0
  view(): DataView {
    const out = new Uint8Array(this.size)
    let off = 0
    for (const c of this.chunks) {
      out.set(c, off)
      off += c.byteLength
    }
    return new DataView(out.buffer, 0, out.byteLength)
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.size)
    let off = 0
    for (const c of this.chunks) {
      out.set(c, off)
      off += c.byteLength
    }
    return out
  }
  push(buf: Uint8Array): void {
    this.chunks.push(buf)
    this.size += buf.byteLength
  }
  i32(v: number): Uint8Array {
    const a = new Uint8Array(4)
    new DataView(a.buffer).setInt32(0, v, false)
    return a
  }
  u32(v: number): Uint8Array {
    const a = new Uint8Array(4)
    new DataView(a.buffer).setUint32(0, v, false)
    return a
  }
  f32(v: number): Uint8Array {
    const a = new Uint8Array(4)
    new DataView(a.buffer).setFloat32(0, v, false)
    return a
  }
  /** Write a NUL-padded fixed-width string. */
  fixedStr(s: string, n: number): Uint8Array {
    const a = new Uint8Array(n)
    const enc = new TextEncoder().encode(s)
    a.set(enc.subarray(0, Math.min(enc.byteLength, n - 1)), 0)
    return a
  }
}

function buildFif(opts: SyntheticFif): Uint8Array {
  const w = new Writer()
  // Helper: emit one tag.
  const tag = (kind: number, type: number, payload: Uint8Array): void => {
    w.push(w.i32(kind))
    w.push(w.u32(type))
    w.push(w.i32(payload.byteLength))
    w.push(w.i32(FIFFV_NEXT_SEQ))
    w.push(payload)
  }

  tag(TAGS.FIFF_NCHAN, FIFFT_INT, w.i32(opts.nchan))
  tag(TAGS.FIFF_SFREQ, FIFFT_FLOAT, w.f32(opts.sfreq))
  if (opts.measDateSeconds !== undefined) {
    const p = new Uint8Array(8)
    const v = new DataView(p.buffer)
    v.setInt32(0, opts.measDateSeconds, false)
    v.setInt32(4, opts.measDateMicros ?? 0, false)
    tag(TAGS.FIFF_MEAS_DATE, FIFFT_INT, p)
  }
  if (opts.lineFreq !== undefined) {
    tag(TAGS.FIFF_LINE_FREQ, FIFFT_FLOAT, w.f32(opts.lineFreq))
  }
  for (const ch of opts.channels) {
    // 96-byte channel struct.
    const p = new Uint8Array(96)
    const v = new DataView(p.buffer)
    v.setInt32(0, ch.scanno, false)
    v.setInt32(4, ch.logno, false)
    v.setInt32(8, ch.kind, false)
    v.setFloat32(12, ch.range, false)
    v.setFloat32(16, ch.cal, false)
    v.setInt32(20, ch.coilType, false)
    for (let i = 0; i < 12; i++) {
      v.setFloat32(24 + i * 4, ch.loc[i] ?? 0, false)
    }
    v.setInt32(72, ch.unit, false)
    v.setInt32(76, ch.unitMul, false)
    const nameBytes = new TextEncoder().encode(ch.name)
    p.set(nameBytes.subarray(0, Math.min(nameBytes.byteLength, 15)), 80)
    tag(TAGS.FIFF_CH_INFO, FIFFT_CH_INFO_STRUCT, p)
  }
  if (opts.digPoints !== undefined) {
    for (const d of opts.digPoints) {
      const p = new Uint8Array(20)
      const v = new DataView(p.buffer)
      v.setInt32(0, d.kind, false)
      v.setInt32(4, d.ident, false)
      v.setFloat32(8, d.r[0], false)
      v.setFloat32(12, d.r[1], false)
      v.setFloat32(16, d.r[2], false)
      tag(TAGS.FIFF_DIG_POINT, FIFFT_DIG_POINT_STRUCT, p)
    }
  }
  if (opts.firstSample !== undefined) {
    tag(TAGS.FIFF_FIRST_SAMPLE, FIFFT_INT, w.i32(opts.firstSample))
  }
  if (opts.lastSample !== undefined) {
    // Final tag in the stream: set next = NONE so the parser stops
    // cleanly rather than reading past EOF.
    w.push(w.i32(TAGS.FIFF_LAST_SAMPLE))
    w.push(w.u32(FIFFT_INT))
    w.push(w.i32(4))
    w.push(w.i32(FIFFV_NEXT_NONE))
    w.push(w.i32(opts.lastSample))
  }
  return w.bytes()
}

// Common channel templates -- a typical Neuromag Vectorview row.
function magCh(
  name: string,
  scanno: number,
  coilType = 3022,
): SyntheticChannel {
  return {
    scanno,
    logno: scanno,
    kind: FIFF_KIND.MEG,
    range: 1,
    cal: 1,
    coilType,
    loc: new Array(12).fill(0),
    unit: 107, // FIFF_UNIT_T
    unitMul: 0,
    name,
  }
}
function planarCh(
  name: string,
  scanno: number,
  coilType = 3012,
): SyntheticChannel {
  return {
    scanno,
    logno: scanno,
    kind: FIFF_KIND.MEG,
    range: 1,
    cal: 1,
    coilType,
    loc: new Array(12).fill(0),
    unit: 107,
    unitMul: 0,
    name,
  }
}
function stimCh(name: string, scanno: number): SyntheticChannel {
  return {
    scanno,
    logno: scanno,
    kind: FIFF_KIND.STIM,
    range: 1,
    cal: 1,
    coilType: 0,
    loc: new Array(12).fill(0),
    unit: 112, // FIFF_UNIT_V
    unitMul: 0,
    name,
  }
}

// ---------------------------------------------------------------------------

describe('parseFif', () => {
  test('reads sfreq, nchan, and channel names from a synthetic header', () => {
    const buf = buildFif({
      sfreq: 1000,
      nchan: 3,
      firstSample: 0,
      lastSample: 9999,
      channels: [
        magCh('MEG0111', 1, 3022),
        planarCh('MEG0112', 2, 3012),
        stimCh('STI 001', 3),
      ],
    })
    const h = parseFif(buf)
    expect(h.sfreq).toBe(1000)
    expect(h.nchan).toBe(3)
    expect(h.channels.map((c) => c.name)).toEqual([
      'MEG0111',
      'MEG0112',
      'STI 001',
    ])
    expect(h.channels[0].kind).toBe(FIFF_KIND.MEG)
    expect(h.channels[0].coilType).toBe(3022)
    expect(h.channels[1].coilType).toBe(3012)
    expect(h.channels[2].kind).toBe(FIFF_KIND.STIM)
  })

  test('computes RecordingDuration from FIRST/LAST_SAMPLE inclusive', () => {
    const buf = buildFif({
      sfreq: 1000,
      nchan: 1,
      firstSample: 0,
      lastSample: 9999, // inclusive -> 10000 samples / 1000 Hz = 10.0 s
      channels: [magCh('MEG0111', 1)],
    })
    const h = parseFif(buf)
    expect(recordingDurationSeconds(h)).toBe(10)
  })

  test('returns 0 duration when last_sample tag is absent', () => {
    const buf = buildFif({
      sfreq: 1000,
      nchan: 1,
      // No firstSample / lastSample -> parser defaults to first=0,
      // last=-1, duration is 0.
      channels: [magCh('MEG0111', 1)],
    })
    const h = parseFif(buf)
    expect(recordingDurationSeconds(h)).toBe(0)
  })

  test('parses MEAS_DATE into an ISO 8601 UTC string', () => {
    // 2024-01-15T12:34:56.789Z = 1705321996 seconds + 789000 us.
    const buf = buildFif({
      sfreq: 1000,
      nchan: 1,
      measDateSeconds: 1705321996,
      measDateMicros: 789000,
      channels: [magCh('MEG0111', 1)],
    })
    const h = parseFif(buf)
    expect(h.measDate).toBe('2024-01-15T12:33:16.789Z')
  })

  test('parses LINE_FREQ as a float', () => {
    const buf = buildFif({
      sfreq: 1000,
      nchan: 1,
      lineFreq: 60,
      channels: [magCh('MEG0111', 1)],
    })
    const h = parseFif(buf)
    expect(h.lineFreq).toBe(60)
  })

  test('extracts cardinal dig points (NAS / LPA / RPA)', () => {
    const buf = buildFif({
      sfreq: 1000,
      nchan: 1,
      channels: [magCh('MEG0111', 1)],
      digPoints: [
        {
          kind: FIFF_DIG.CARDINAL,
          ident: FIFF_DIG.LPA,
          r: [-0.08, 0, 0],
        },
        {
          kind: FIFF_DIG.CARDINAL,
          ident: FIFF_DIG.NASION,
          r: [0, 0.1, 0],
        },
        {
          kind: FIFF_DIG.CARDINAL,
          ident: FIFF_DIG.RPA,
          r: [0.08, 0, 0],
        },
      ],
    })
    const h = parseFif(buf)
    expect(h.digPoints).toHaveLength(3)
    const nas = h.digPoints.find((d) => d.ident === FIFF_DIG.NASION)
    expect(nas?.r[1]).toBeCloseTo(0.1, 5)
  })

  test('throws on truncated buffer', () => {
    const full = buildFif({
      sfreq: 1000,
      nchan: 1,
      channels: [magCh('MEG0111', 1)],
    })
    expect(() => parseFif(full.subarray(0, 30))).toThrow()
  })

  test('throws when SFREQ is missing', () => {
    // Just an NCHAN tag with FIFFV_NEXT_NONE -- no sfreq.
    const buf = new Uint8Array(20)
    const v = new DataView(buf.buffer)
    v.setInt32(0, 200, false) // FIFF_NCHAN
    v.setUint32(4, 3, false) // type int
    v.setInt32(8, 4, false) // size
    v.setInt32(12, FIFFV_NEXT_NONE, false)
    v.setInt32(16, 1, false) // nchan = 1
    expect(() => parseFif(buf)).toThrow(/FIFF_SFREQ tag not found/)
  })

  test('throws when CH_INFO count disagrees with NCHAN', () => {
    const buf = buildFif({
      sfreq: 1000,
      nchan: 5, // says 5 channels
      channels: [magCh('MEG0111', 1)], // only one provided
    })
    expect(() => parseFif(buf)).toThrow(/FIFF_NCHAN=5.*found 1 FIFF_CH_INFO/)
  })

  test('throws on non-positive sfreq', () => {
    const buf = buildFif({
      sfreq: 0,
      nchan: 1,
      channels: [magCh('MEG0111', 1)],
    })
    expect(() => parseFif(buf)).toThrow(/non-positive sfreq/)
  })
})
