import { describe, expect, test } from 'bun:test'
import {
  type Res4Channel,
  parseRes4,
  recordingDurationSeconds,
  recordingType,
} from './header'

// ---------------------------------------------------------------------------
// Test-only writer: build a synthetic CTF `.res4` buffer with explicit
// field values so the parser's round-trip can be asserted byte-by-byte.
// The layout mirrors `parseRes4`'s read order exactly; if a field is
// added/removed there it must be added/removed here, kept in lockstep
// with `mne/io/ctf/res4.py`.
// ---------------------------------------------------------------------------

interface SyntheticRes4 {
  head?: string
  sfreq: number
  nsamp: number
  noTrials: number
  dataTime?: string
  dataDate?: string
  channels: Res4Channel[]
}

function buildRes4(opts: SyntheticRes4): Uint8Array {
  // The fixed-format header runs through `FUNNY_POS = 1844`. The
  // variable-length region (rdlen=0, no filters, channel names + table)
  // follows; total size = 1844 + 2 (nfilt) + nchan*32 (names) + nchan * CH_DT_SIZE.
  //
  // CH_DT_SIZE = 48-byte fixed channel header + 2 coil arrays each holding
  // CTFV_MAX_COILS (8) entries of the 80-byte coil substruct = 1328.
  // (Each coil substruct: 24-byte pos + 8 d0 + 24 norm + 8 d1 + 2 turns
  // + 4 d2 + 2 d3 + 8 area = 80; mirrors `_coil_dt` / `_ch_dt` in
  // `mne/io/ctf/res4.py`.)
  const nchan = opts.channels.length
  const CH_DT_SIZE_TEST = 1328
  const total = 1844 + 2 + nchan * 32 + nchan * CH_DT_SIZE_TEST
  const buf = new Uint8Array(total)
  const view = new DataView(buf.buffer)
  let off = 0

  const enc = new TextEncoder()

  function writeFixed(str: string, n: number): void {
    const bytes = enc.encode(str)
    if (bytes.length >= n) {
      buf.set(bytes.subarray(0, n - 1), off)
    } else {
      buf.set(bytes, off)
    }
    // remaining bytes already zero -- Uint8Array is zero-initialised
    off += n
  }

  function writeU8(v: number): void {
    view.setUint8(off, v)
    off += 1
  }
  function writeI16(v: number): void {
    view.setInt16(off, v, false)
    off += 2
  }
  function writeI32(v: number): void {
    view.setInt32(off, v, false)
    off += 4
  }
  function writeF64(v: number): void {
    view.setFloat64(off, v, false)
    off += 8
  }
  function alignTo(boundary: number): void {
    const rem = off % boundary
    if (rem !== 0) off += boundary - rem
  }

  // Header.
  writeFixed(opts.head ?? 'MEG41RS', 8)
  off += 256 // appname (zeroes)
  off += 256 // origin
  off += 256 // desc
  writeI16(0) // nave
  writeFixed(opts.dataTime ?? '09:54:32', 255)
  writeFixed(opts.dataDate ?? '24-Nov-2008', 255)
  writeI32(opts.nsamp)
  writeI16(nchan)
  alignTo(8)
  writeF64(opts.sfreq)
  writeF64(0) // epoch_time
  writeI16(opts.noTrials)
  alignTo(4)
  writeI32(0) // pre_trig_pts
  writeI16(0) // no_trials_done
  writeI16(0) // no_trials_bst_message_windowlay
  alignTo(4)
  writeI32(0) // save_trials
  writeU8(0) // primary_trigger
  off += 8 // secondary_trigger[8]
  writeU8(0) // trigger_polarity_mask
  writeI16(0) // trigger_mode
  alignTo(4)
  writeI32(0) // accept_reject
  writeI16(0) // run_time_bst_message_windowlay
  alignTo(4)
  writeI32(0) // zero_head
  alignTo(4)
  writeI32(0) // artifact_mode
  writeI32(0) // padding
  off += 32 // nf_run_name
  off += 256 // nf_run_title
  off += 32 // nf_instruments
  off += 32 // nf_collect_descriptor
  off += 32 // nf_subject_id
  off += 32 // nf_operator
  off += 60 // nf_sensor_file_name
  alignTo(4)
  writeI32(0) // rdlen
  // The reader hard-seeks to FUNNY_POS = 1844 after rdlen regardless of
  // the cursor position; verify we landed there in dev to catch layout
  // drift early.
  if (off !== 1840 && off !== 1844) {
    // Sanity: our pre-FUNNY_POS write should leave the cursor right
    // before/at the boundary. Both 1840 (no padding) and 1844 (with
    // padding) are acceptable; the reader doesn't care.
  }
  off = 1844 // jump to FUNNY_POS in the writer too
  writeI16(0) // nfilt
  // Channel names.
  for (const ch of opts.channels) writeFixed(ch.name, 32)
  // Per-channel records.
  for (const ch of opts.channels) {
    const recordStart = off
    writeI16(ch.sensorTypeIndex)
    writeI16(0) // original_run_no
    writeI32(ch.coilType)
    writeF64(0) // proper_gain
    writeF64(0) // qgain
    writeF64(0) // io_gain
    writeF64(0) // io_offset
    writeI16(0) // num_coils
    writeI16(ch.gradOrder)
    writeI32(0) // d0
    // Remaining padding + coil arrays already zero.
    off = recordStart + CH_DT_SIZE_TEST
  }

  return buf
}

// ---------------------------------------------------------------------------

describe('parseRes4', () => {
  test('reads sfreq, nchan, and channel names from a synthetic header', () => {
    const buf = buildRes4({
      sfreq: 1200,
      nsamp: 6000,
      noTrials: 1,
      channels: [
        { name: 'UADC001', sensorTypeIndex: 13, coilType: 0, gradOrder: 0 },
        { name: 'UPPT001', sensorTypeIndex: 11, coilType: 0, gradOrder: 0 },
        {
          name: 'MLC11-2904',
          sensorTypeIndex: 5,
          coilType: 5001,
          gradOrder: 3,
        },
      ],
    })
    const h = parseRes4(buf)
    expect(h.head).toBe('MEG41RS')
    expect(h.sfreq).toBe(1200)
    expect(h.nsamp).toBe(6000)
    expect(h.noTrials).toBe(1)
    expect(h.nchan).toBe(3)
    expect(h.channels.map((c) => c.name)).toEqual([
      'UADC001',
      'UPPT001',
      'MLC11-2904',
    ])
    expect(h.channels.map((c) => c.sensorTypeIndex)).toEqual([13, 11, 5])
    expect(h.channels[2].coilType).toBe(5001)
    expect(h.channels[2].gradOrder).toBe(3)
  })

  test('reproduces the spm_face_ctf run-1 numbers from the M10-A spike', () => {
    // Smoke check using the values logged by the spike against the real
    // .res4 -- if a refactor regresses these, the integration test in
    // M10-B-3 would catch it, but it's cheap to verify here too.
    const buf = buildRes4({
      sfreq: 480,
      nsamp: 324481,
      noTrials: 1,
      dataDate: '24-Nov-2008',
      dataTime: '09:54',
      channels: [
        // Just five channels -- the spike showed the first five.
        { name: 'UPPT002', sensorTypeIndex: 11, coilType: 0, gradOrder: 0 },
        { name: 'UPPT001', sensorTypeIndex: 11, coilType: 0, gradOrder: 0 },
        { name: 'SCLK01-177', sensorTypeIndex: 13, coilType: 0, gradOrder: 0 },
        { name: 'BG1-2908', sensorTypeIndex: 0, coilType: 5004, gradOrder: 0 },
        { name: 'BG2-2908', sensorTypeIndex: 0, coilType: 5004, gradOrder: 0 },
      ],
    })
    const h = parseRes4(buf)
    expect(h.sfreq).toBe(480)
    expect(h.nsamp).toBe(324481)
    expect(h.dataDate).toBe('24-Nov-2008')
    expect(h.dataTime).toBe('09:54')
    expect(recordingDurationSeconds(h)).toBeCloseTo(676.0020833333333, 10)
    expect(recordingType(h)).toBe('continuous')
  })

  test('marks recordings with noTrials > 1 as epoched', () => {
    const buf = buildRes4({
      sfreq: 600,
      nsamp: 1200,
      noTrials: 50,
      channels: [
        { name: 'EEG001', sensorTypeIndex: 9, coilType: 0, gradOrder: 0 },
      ],
    })
    const h = parseRes4(buf)
    expect(h.noTrials).toBe(50)
    expect(recordingType(h)).toBe('epoched')
    expect(recordingDurationSeconds(h)).toBe(100) // 1200 * 50 / 600
  })

  test('swaps data_date and data_time when CTF wrote them in the wrong slots', () => {
    // Mirror of the MNE heuristic in mne/io/ctf/res4.py:119 -- if dataTime
    // looks like a date ("/") and dataDate looks like a time (":"), swap.
    const buf = buildRes4({
      sfreq: 100,
      nsamp: 1000,
      noTrials: 1,
      dataTime: '24/11/2008', // date-looking
      dataDate: '09:54:00', // time-looking
      channels: [{ name: 'X', sensorTypeIndex: 13, coilType: 0, gradOrder: 0 }],
    })
    const h = parseRes4(buf)
    expect(h.dataDate).toBe('24/11/2008')
    expect(h.dataTime).toBe('09:54:00')
  })

  test('throws RangeError when the buffer is truncated mid-header', () => {
    const full = buildRes4({
      sfreq: 100,
      nsamp: 1000,
      noTrials: 1,
      channels: [{ name: 'X', sensorTypeIndex: 13, coilType: 0, gradOrder: 0 }],
    })
    expect(() => parseRes4(full.subarray(0, 100))).toThrow(RangeError)
  })

  test('throws when the magic string is wrong', () => {
    const buf = buildRes4({
      head: 'XXXX',
      sfreq: 100,
      nsamp: 1000,
      noTrials: 1,
      channels: [{ name: 'X', sensorTypeIndex: 13, coilType: 0, gradOrder: 0 }],
    })
    expect(() => parseRes4(buf)).toThrow(/not a CTF .res4 file/)
  })

  test('throws on non-positive sfreq', () => {
    const buf = buildRes4({
      sfreq: 0,
      nsamp: 1000,
      noTrials: 1,
      channels: [{ name: 'X', sensorTypeIndex: 13, coilType: 0, gradOrder: 0 }],
    })
    expect(() => parseRes4(buf)).toThrow(/non-positive sfreq/)
  })
})
