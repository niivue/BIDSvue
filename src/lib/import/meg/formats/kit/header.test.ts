import { describe, expect, test } from 'bun:test'
import { KIT_CH, parseKit, recordingDurationSeconds } from './header'

// ---------------------------------------------------------------------------
// Synthetic KIT `.con` builder for parser tests.
//
// KIT is LITTLE-endian. The file is a "directory of directories":
// a sequence of 16-byte dir entries starting at offset 0. dirs[0] is
// self-describing -- its `count` is the total number of dir entries.
// Each entry: offset(u32) size(i32) max_count(i32) count(i32).
//
// For tests we synthesize a stripped-down file with only the dirs
// the parser reads: 0 (self), 1 (SYSTEM), 4 (CHANNELS), 5 (CAL placeholder),
// 8 (ACQ_COND), 26 (DIG_POINTS). The remaining indices (2, 3, 6, 7, 9-25,
// 27-N) get empty placeholder entries so the indices align.
//
// Total dir count is fixed at 30 so DIR_INDEX_DIG_POINTS (26) is within
// range; this mirrors what real KIT files emit.
// ---------------------------------------------------------------------------

const DIR_COUNT = 30
const DIR_ENTRY_BYTES = 16
const DIR_TABLE_BYTES = DIR_COUNT * DIR_ENTRY_BYTES

const KIT_DIR_INDEX = {
  DIR: 0,
  SYSTEM: 1,
  CHANNELS: 4,
  CALIBRATION: 5,
  ACQ_COND: 8,
  RAW_DATA: 9,
  COREG: 12,
  DIG_POINTS: 26,
} as const

interface SyntheticKit {
  version?: number
  revision?: number
  sysId?: number
  systemName?: string
  sfreq: number
  nSamples?: number
  acqType?: 1 | 2 | 3 // 1=continuous, 2=evoked, 3=epochs
  channels: { type: number; name?: string }[]
  digPoints?: { name: string; r: [number, number, number] }[]
}

function buildKit(opts: SyntheticKit): Uint8Array {
  // Compute sub-block bodies, then assemble the final buffer with
  // the dir table at offset 0 + each sub-block back-to-back after.
  const nchan = opts.channels.length

  // ---- SYSTEM (dir index 1) ----
  // Layout we parse: version(i32) + revision(i32) + sysId(i32) +
  // systemName(128) + modelName(128) + nchan(i32).
  const sysBuf = new Uint8Array(4 * 3 + 128 + 128 + 4)
  {
    const v = new DataView(sysBuf.buffer)
    v.setInt32(0, opts.version ?? 2, true)
    v.setInt32(4, opts.revision ?? 3, true)
    v.setInt32(8, opts.sysId ?? 53, true)
    const nameBytes = new TextEncoder().encode(opts.systemName ?? 'TEST-KIT')
    sysBuf.set(nameBytes.subarray(0, Math.min(nameBytes.byteLength, 127)), 12)
    // model name skipped (zero-filled)
    v.setInt32(12 + 128 + 128, nchan, true)
  }

  // ---- ACQ_COND (dir index 8) ----
  // Continuous layout: acq_type(i32) + sfreq(f64) + pad(i32) + n_samples(i32) = 20 bytes.
  // Epoched / evoked layout: acq_type(i32) + sfreq(f64) + frame_len(i32) +
  //   pretrigger(i32) + avg_count(i32) + n_epochs(i32) = 28 bytes.
  // Allocate the larger size; the parser walks only what each branch needs.
  const acqBuf = new Uint8Array(28)
  {
    const v = new DataView(acqBuf.buffer)
    const acqType = opts.acqType ?? 1
    v.setInt32(0, acqType, true)
    v.setFloat64(4, opts.sfreq, true)
    if (acqType === 1) {
      // continuous
      v.setInt32(12, 0, true) // pad
      v.setInt32(16, opts.nSamples ?? 0, true)
    } else {
      // epoched / evoked: write some reasonable defaults so the
      // parser walks all four fields without overrunning.
      v.setInt32(12, 100, true) // frame_len
      v.setInt32(16, 0, true) // pretrigger
      v.setInt32(20, 1, true) // average_count
      v.setInt32(24, 1, true) // n_epochs
    }
  }

  // ---- CHANNELS (dir index 4) ----
  // Per-channel record size depends on the channel-type layout
  // we want to test. KIT uses fixed-size records across all channel
  // types within a file. For the test we pick a size big enough for
  // the largest layout we emit (MEG: 4+5*8+16+6 = 66, MISC trigger:
  // 4+4+4+32 = 44, EEG: 4+4+4+8 = 20). Round up to 96 bytes (matches
  // real-world record sizes).
  const RECORD_SIZE = 96
  const chanBuf = new Uint8Array(RECORD_SIZE * nchan)
  for (let i = 0; i < nchan; i++) {
    const ch = opts.channels[i]
    const v = new DataView(chanBuf.buffer, i * RECORD_SIZE, RECORD_SIZE)
    v.setInt32(0, ch.type, true)
    if (
      ch.type === KIT_CH.MAGNETOMETER ||
      ch.type === KIT_CH.AXIAL_GRADIOMETER ||
      ch.type === KIT_CH.PLANAR_GRADIOMETER ||
      ch.type === KIT_CH.AXIAL_GRADIOMETER_2ND
    ) {
      // 5 f64 loc placeholders + 16-byte misc -> name at offset
      // 4 + 40 + 16 = 60.
      const nameOff = 60
      const NCHAR = 6
      writeFixedString(chanBuf, i * RECORD_SIZE + nameOff, ch.name ?? '', NCHAR)
    } else if (
      ch.type === KIT_CH.TRIGGER ||
      ch.type === KIT_CH.ECG ||
      ch.type === KIT_CH.ETC
    ) {
      // 4 (type) + 4 (channel_no) + 4 (reserved) -> name at offset 12, len 32.
      writeFixedString(chanBuf, i * RECORD_SIZE + 12, ch.name ?? '', 32)
    } else if (ch.type === KIT_CH.EEG) {
      // 4 + 4 + 4 -> name at offset 12, len 8.
      writeFixedString(chanBuf, i * RECORD_SIZE + 12, ch.name ?? '', 8)
    }
  }

  // ---- DIG_POINTS (dir index 26) ----
  // Layout per point: name(8) + 3*f64 = 32 bytes.
  const DIG_RECORD = 8 + 3 * 8
  const digCount = opts.digPoints?.length ?? 0
  const digBuf = new Uint8Array(DIG_RECORD * digCount)
  if (opts.digPoints !== undefined) {
    for (let i = 0; i < opts.digPoints.length; i++) {
      const d = opts.digPoints[i]
      writeFixedString(digBuf, i * DIG_RECORD, d.name, 8)
      const v = new DataView(digBuf.buffer, i * DIG_RECORD + 8, 24)
      v.setFloat64(0, d.r[0], true)
      v.setFloat64(8, d.r[1], true)
      v.setFloat64(16, d.r[2], true)
    }
  }

  // ---- Assemble ----
  const blocks: { dirIndex: number; bytes: Uint8Array; recordSize: number }[] =
    [
      {
        dirIndex: KIT_DIR_INDEX.SYSTEM,
        bytes: sysBuf,
        recordSize: sysBuf.byteLength,
      },
      {
        dirIndex: KIT_DIR_INDEX.CHANNELS,
        bytes: chanBuf,
        recordSize: RECORD_SIZE,
      },
      {
        dirIndex: KIT_DIR_INDEX.ACQ_COND,
        bytes: acqBuf,
        recordSize: acqBuf.byteLength,
      },
      {
        dirIndex: KIT_DIR_INDEX.DIG_POINTS,
        bytes: digBuf,
        recordSize: DIG_RECORD,
      },
    ]

  const blockSize = blocks.reduce((acc, b) => acc + b.bytes.byteLength, 0)
  const totalSize = DIR_TABLE_BYTES + blockSize
  const out = new Uint8Array(totalSize)
  const view = new DataView(out.buffer)

  // dirs[0] -- self-describing: offset=0, size=16, max_count=DIR_COUNT, count=DIR_COUNT
  writeDirEntry(view, 0, {
    offset: 0,
    size: DIR_ENTRY_BYTES,
    maxCount: DIR_COUNT,
    count: DIR_COUNT,
  })
  // Initialise all other dirs to zero (empty placeholder entries).
  for (let i = 1; i < DIR_COUNT; i++) {
    writeDirEntry(view, i * DIR_ENTRY_BYTES, {
      offset: 0,
      size: 0,
      maxCount: 0,
      count: 0,
    })
  }

  // Place each block in turn after the dir table; write its dir entry.
  let cursor = DIR_TABLE_BYTES
  for (const block of blocks) {
    out.set(block.bytes, cursor)
    const count =
      block.dirIndex === KIT_DIR_INDEX.CHANNELS
        ? nchan
        : block.dirIndex === KIT_DIR_INDEX.DIG_POINTS
          ? digCount
          : 1
    writeDirEntry(view, block.dirIndex * DIR_ENTRY_BYTES, {
      offset: cursor,
      size: block.recordSize,
      maxCount: count,
      count,
    })
    cursor += block.bytes.byteLength
  }

  return out
}

function writeDirEntry(
  view: DataView,
  off: number,
  e: { offset: number; size: number; maxCount: number; count: number },
): void {
  view.setUint32(off, e.offset, true)
  view.setInt32(off + 4, e.size, true)
  view.setInt32(off + 8, e.maxCount, true)
  view.setInt32(off + 12, e.count, true)
}

function writeFixedString(
  buf: Uint8Array,
  off: number,
  str: string,
  n: number,
): void {
  const bytes = new TextEncoder().encode(str)
  buf.set(bytes.subarray(0, Math.min(bytes.byteLength, n - 1)), off)
}

// ---------------------------------------------------------------------------

describe('parseKit', () => {
  test('reads version, sfreq, nchan from a synthetic minimal .con', () => {
    const buf = buildKit({
      sfreq: 1000,
      nSamples: 10000,
      channels: [
        { type: KIT_CH.AXIAL_GRADIOMETER, name: 'AG001' },
        { type: KIT_CH.AXIAL_GRADIOMETER, name: 'AG002' },
        { type: KIT_CH.TRIGGER, name: 'TRIG' },
      ],
    })
    const h = parseKit(buf)
    expect(h.version).toBe(2)
    expect(h.sysId).toBe(53)
    expect(h.systemName).toBe('TEST-KIT')
    expect(h.sfreq).toBe(1000)
    expect(h.nSamples).toBe(10000)
    expect(h.nchan).toBe(3)
    expect(h.acqType).toBe('continuous')
  })

  test('computes RecordingDuration from nSamples / sfreq', () => {
    const buf = buildKit({
      sfreq: 1000,
      nSamples: 9999,
      channels: [{ type: KIT_CH.AXIAL_GRADIOMETER }],
    })
    const h = parseKit(buf)
    expect(recordingDurationSeconds(h)).toBeCloseTo(9.999, 5)
  })

  test('returns 0 duration when nSamples is missing or zero', () => {
    const buf = buildKit({
      sfreq: 1000,
      nSamples: 0,
      channels: [{ type: KIT_CH.AXIAL_GRADIOMETER }],
    })
    expect(recordingDurationSeconds(parseKit(buf))).toBe(0)
  })

  test('extracts channel types in source order', () => {
    const buf = buildKit({
      sfreq: 1000,
      nSamples: 100,
      channels: [
        { type: KIT_CH.MAGNETOMETER, name: 'M1' },
        { type: KIT_CH.AXIAL_GRADIOMETER, name: 'G1' },
        { type: KIT_CH.MAGNETOMETER_REFERENCE },
        { type: KIT_CH.TRIGGER, name: 'TRIG' },
        { type: KIT_CH.EEG, name: 'EEG001' },
      ],
    })
    const h = parseKit(buf)
    expect(h.channels.map((c) => c.type)).toEqual([
      KIT_CH.MAGNETOMETER,
      KIT_CH.AXIAL_GRADIOMETER,
      KIT_CH.MAGNETOMETER_REFERENCE,
      KIT_CH.TRIGGER,
      KIT_CH.EEG,
    ])
    expect(h.channels.map((c) => c.name)).toEqual([
      'M1',
      'G1',
      '', // MAG_REF: no NCHAR entry -> empty
      'TRIG',
      'EEG001',
    ])
  })

  test('extracts cardinal dig points (fidnz / fidt9 / fidt10)', () => {
    const buf = buildKit({
      sfreq: 1000,
      nSamples: 100,
      channels: [{ type: KIT_CH.AXIAL_GRADIOMETER }],
      digPoints: [
        { name: 'fidnz', r: [0, 0.1, 0] },
        { name: 'fidt9', r: [-0.08, 0, 0] },
        { name: 'fidt10', r: [0.08, 0, 0] },
      ],
    })
    const h = parseKit(buf)
    expect(h.digPoints).toHaveLength(3)
    const nas = h.digPoints.find((d) => d.name === 'fidnz')
    expect(nas?.r[1]).toBeCloseTo(0.1, 5)
  })

  test('marks epoched acquisition correctly', () => {
    const buf = buildKit({
      sfreq: 600,
      acqType: 3,
      channels: [{ type: KIT_CH.AXIAL_GRADIOMETER }],
    })
    const h = parseKit(buf)
    expect(h.acqType).toBe('epoched')
  })

  test('throws on truncated buffer', () => {
    const full = buildKit({
      sfreq: 1000,
      nSamples: 100,
      channels: [{ type: KIT_CH.AXIAL_GRADIOMETER }],
    })
    expect(() => parseKit(full.subarray(0, 100))).toThrow()
  })

  test('throws on non-positive sfreq', () => {
    const buf = buildKit({
      sfreq: 0,
      nSamples: 100,
      channels: [{ type: KIT_CH.AXIAL_GRADIOMETER }],
    })
    expect(() => parseKit(buf)).toThrow(/non-positive sfreq/)
  })
})
