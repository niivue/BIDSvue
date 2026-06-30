// KIT / Yokogawa / Ricoh `.con` / `.sqd` binary header parser.
//
// Format: little-endian binary; documented (loosely) in MNE-Python's
// `mne/io/kit/kit.py` and the Yokogawa MEG-Vision SDK. The file is
// a "directory of directories": offset 0 starts a sequence of 16-byte
// dir entries (`offset:u32, size:i32, max_count:i32, count:i32`).
// dirs[0] describes itself (its `count` is the total number of dir
// entries); other indices point at format sub-blocks.
//
// Indices we care about (matching `KIT.DIR_INDEX_*` in MNE):
//   1  SYSTEM       -- version + sysid + nchan + names
//   4  CHANNELS     -- per-channel records; size from the dir entry
//   8  ACQ_COND     -- sfreq + n_samples (continuous mode)
//   26 DIG_POINTS   -- cardinal landmarks (NAS / LPA / RPA) + HPI
//
// Signal data lives in dir index 9 (RAW_DATA); we never touch it.

import type { Point3 } from '../../recording'

// ---------------------------------------------------------------------------
// Little-endian byte reader.
// ---------------------------------------------------------------------------

class LeReader {
  private off = 0
  constructor(private readonly view: DataView) {}

  tell(): number {
    return this.off
  }

  seek(pos: number): void {
    if (pos < 0 || pos > this.view.byteLength) {
      throw new RangeError(
        `LeReader.seek(${pos}) out of range (buffer is ${this.view.byteLength} bytes)`,
      )
    }
    this.off = pos
  }

  private ensure(n: number): void {
    if (this.off + n > this.view.byteLength) {
      throw new RangeError(
        `LeReader: read of ${n} bytes at offset ${this.off} would overrun the ${this.view.byteLength}-byte buffer`,
      )
    }
  }

  readInt32(): number {
    this.ensure(4)
    const v = this.view.getInt32(this.off, true)
    this.off += 4
    return v
  }

  readUint32(): number {
    this.ensure(4)
    const v = this.view.getUint32(this.off, true)
    this.off += 4
    return v
  }

  readFloat64(): number {
    this.ensure(8)
    const v = this.view.getFloat64(this.off, true)
    this.off += 8
    return v
  }

  /** Read `n` bytes and return the leading C-string (NUL-trimmed, then trim
   *  whitespace from both ends). */
  readCString(n: number): string {
    this.ensure(n)
    const bytes = new Uint8Array(
      this.view.buffer,
      this.view.byteOffset + this.off,
      n,
    )
    this.off += n
    const nul = bytes.indexOf(0)
    const slice = nul < 0 ? bytes : bytes.subarray(0, nul)
    return DECODER.decode(slice).trim()
  }

  skip(n: number): void {
    this.ensure(n)
    this.off += n
  }
}

const DECODER = new TextDecoder('utf-8')

// ---------------------------------------------------------------------------
// KIT constants. Mirror `mne/io/kit/constants.py`; only the values
// our parser depends on.
// ---------------------------------------------------------------------------

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

const KIT_CHANNEL = {
  NULL: 0,
  MAGNETOMETER: 1,
  AXIAL_GRADIOMETER: 2,
  PLANAR_GRADIOMETER: 3,
  AXIAL_GRADIOMETER_2ND: 4,
  MAGNETOMETER_REFERENCE: 0x101,
  AXIAL_GRADIOMETER_REFERENCE: 0x102,
  PLANAR_GRADIOMETER_REFERENCE: 0x103,
  AXIAL_GRADIOMETER_2ND_REFERENCE: 0x104,
  TRIGGER: -1,
  EEG: -2,
  ECG: -3,
  ETC: -4, // catch-all misc
} as const

/** Acquisition-type values for the ACQ_COND block. */
const KIT_ACQ = {
  CONTINUOUS: 1,
  EVOKED: 2,
  EPOCHS: 3,
} as const

// ---------------------------------------------------------------------------
// Parsed shapes.
// ---------------------------------------------------------------------------

export interface KitChannel {
  /** KIT channel-type code (the discriminant the classifier uses). */
  type: number
  /** Channel name. For MEG channels this comes from the trailing
   *  NCHAR bytes of the per-channel record; for MISC channels it's
   *  the same. For NULL or unknown types, an empty string. */
  name: string
}

export interface KitDigPoint {
  /** Lower-case 8-byte tag from the file (`fidnz`, `fidt9`, `fidt10`,
   *  `hpi_1`..`hpi_5`, or an empty string for free head-shape points). */
  name: string
  /** [x, y, z] in METERS, KIT head coordinate frame. */
  r: Point3
}

export interface KitHeader {
  /** Format version (file format major version, not MEG-Vision version). */
  version: number
  /** Revision within the version. */
  revision: number
  /** System ID (vendor-specific; 51/52/53/...). */
  sysId: number
  /** System name (free text from the file). */
  systemName: string
  /** Sampling frequency in Hz. */
  sfreq: number
  /** Number of recorded samples. */
  nSamples: number
  /** Number of channels. */
  nchan: number
  /** Channels in source order. */
  channels: KitChannel[]
  /** Digitization points (cardinal landmarks + HPI + head shape). */
  digPoints: KitDigPoint[]
  /**
   * Acquisition mode: `'continuous'` or `'epoched'`. Maps directly
   * to BIDS `_meg.json.RecordingType`.
   */
  acqType: 'continuous' | 'epoched'
}

/**
 * Parse a KIT `.con` / `.sqd` file header. Walks the directory table
 * + the SYSTEM / CHANNELS / ACQ_COND / DIG_POINTS sub-blocks. Skips
 * the RAW_DATA payload entirely.
 */
export function parseKit(buf: Uint8Array): KitHeader {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const r = new LeReader(view)

  // ---- Directory table at offset 0 ----
  // dirs[0] is self-describing: count == total number of dir entries.
  // We read the rest based on dirs[0].count. KIT files have on the
  // order of 20-30 entries in practice; cap at 1024 to defend against
  // a crafted file with an enormous count overflow (round-9 security
  // audit — KIT_DIR_INDEX values stay well under this bound).
  const dirs: { offset: number; size: number; count: number }[] = []
  const dir0 = readDirEntry(r)
  if (dir0.count < 1 || dir0.count > 1024) {
    throw new RangeError(
      `parseKit: directory-table count ${dir0.count} out of range (1..1024)`,
    )
  }
  dirs.push(dir0)
  for (let i = 1; i < dir0.count; i++) {
    dirs.push(readDirEntry(r))
  }

  // ---- System sub-block ----
  const sys = dirs[KIT_DIR_INDEX.SYSTEM]
  if (sys === undefined || sys.count === 0) {
    throw new Error('parseKit: missing SYSTEM directory entry')
  }
  r.seek(sys.offset)
  const version = r.readInt32()
  const revision = r.readInt32()
  const sysId = r.readInt32()
  const systemName = r.readCString(128)
  r.skip(128) // model_name
  const nchan = r.readInt32()
  if (nchan < 0 || nchan > 100000) {
    throw new Error(`parseKit: implausible nchan ${nchan}`)
  }

  // ---- Acquisition conditions ----
  const acq = dirs[KIT_DIR_INDEX.ACQ_COND]
  if (acq === undefined || acq.count === 0) {
    throw new Error('parseKit: missing ACQ_COND directory entry')
  }
  r.seek(acq.offset)
  const acqTypeRaw = r.readInt32()
  const sfreq = r.readFloat64()
  if (!(sfreq > 0)) {
    throw new Error(`parseKit: non-positive sfreq ${sfreq}`)
  }
  let nSamples = 0
  let acqType: 'continuous' | 'epoched'
  if (acqTypeRaw === KIT_ACQ.CONTINUOUS) {
    r.skip(4) // samples_count placeholder
    nSamples = r.readInt32()
    acqType = 'continuous'
  } else if (acqTypeRaw === KIT_ACQ.EVOKED || acqTypeRaw === KIT_ACQ.EPOCHS) {
    const frameLen = r.readInt32()
    r.readInt32() // pretrigger_length
    r.readInt32() // average_count
    const nEpochs = r.readInt32()
    nSamples = acqTypeRaw === KIT_ACQ.EVOKED ? frameLen : frameLen * nEpochs
    acqType = 'epoched'
  } else {
    throw new Error(
      `parseKit: unknown acquisition type ${acqTypeRaw} (expected 1/2/3)`,
    )
  }

  // ---- Per-channel records ----
  // Each record starts with `type:i32`; the rest of the layout depends
  // on type. We don't need to fully decode every field -- type +
  // optional name is enough for BIDS.
  const chanDir = dirs[KIT_DIR_INDEX.CHANNELS]
  if (chanDir === undefined || chanDir.count === 0) {
    throw new Error('parseKit: missing CHANNELS directory entry')
  }
  const channels: KitChannel[] = []
  for (let i = 0; i < nchan; i++) {
    r.seek(chanDir.offset + chanDir.size * i)
    channels.push(readChannelRecord(r, chanDir.size))
  }

  // ---- Digitization points (optional) ----
  const digPoints: KitDigPoint[] = []
  const digDir = dirs[KIT_DIR_INDEX.DIG_POINTS]
  if (digDir !== undefined && digDir.count > 0) {
    // Same defensive bound as the dir-table count above: real KIT
    // files have ≲ 1000 dig points; reject crafted overflows that
    // would otherwise drive an O(2^31) loop before any RangeError
    // from r.readCString fires (round-9 security audit).
    if (digDir.count > 100000) {
      throw new RangeError(
        `parseKit: DIG_POINTS count ${digDir.count} exceeds plausible bound (≤ 100000)`,
      )
    }
    r.seek(digDir.offset)
    for (let i = 0; i < digDir.count; i++) {
      const name = r.readCString(8).toLowerCase()
      const x = r.readFloat64()
      const y = r.readFloat64()
      const z = r.readFloat64()
      digPoints.push({ name, r: [x, y, z] })
    }
  }

  return {
    version,
    revision,
    sysId,
    systemName,
    sfreq,
    nSamples,
    nchan,
    channels,
    digPoints,
    acqType,
  }
}

function readDirEntry(r: LeReader): {
  offset: number
  size: number
  count: number
} {
  const offset = r.readUint32()
  const size = r.readInt32()
  r.readInt32() // max_count -- unused
  const count = r.readInt32()
  return { offset, size, count }
}

/**
 * Read one channel record. The record's full size is dictated by the
 * CHANNELS dir entry's `size` field; we only pull out the type + the
 * trailing name (if any) and trust the caller to seek to the next
 * record's start.
 *
 * Per-type layouts (from MNE's `_get_kit_info`):
 *  - MEG family (1, 2, 3, 4, 0x101..0x104):
 *      type:i32  loc:f64[5]  misc:16  name:NCHAR
 *  - MISC family (TRIGGER, EEG, ECG, ETC):
 *      type:i32  channel_no:i32  4 bytes skipped  name:NCHAR
 *  - NULL (0):
 *      type:i32  (no name)
 */
function readChannelRecord(r: LeReader, recordSize: number): KitChannel {
  const start = r.tell()
  const type = r.readInt32()
  let name = ''
  switch (type) {
    case KIT_CHANNEL.MAGNETOMETER:
    case KIT_CHANNEL.AXIAL_GRADIOMETER:
    case KIT_CHANNEL.PLANAR_GRADIOMETER:
    case KIT_CHANNEL.AXIAL_GRADIOMETER_2ND:
    case KIT_CHANNEL.MAGNETOMETER_REFERENCE:
    case KIT_CHANNEL.AXIAL_GRADIOMETER_REFERENCE:
    case KIT_CHANNEL.PLANAR_GRADIOMETER_REFERENCE:
    case KIT_CHANNEL.AXIAL_GRADIOMETER_2ND_REFERENCE:
      r.skip(5 * 8) // loc f64[5]
      r.skip(16) // misc fields
      name = readKitChannelName(r, type, recordSize - (r.tell() - start))
      break
    case KIT_CHANNEL.TRIGGER:
    case KIT_CHANNEL.EEG:
    case KIT_CHANNEL.ECG:
    case KIT_CHANNEL.ETC:
      r.readInt32() // channel_no
      r.skip(4) // reserved
      name = readKitChannelName(r, type, recordSize - (r.tell() - start))
      break
    case KIT_CHANNEL.NULL:
      // No further fields.
      break
    default:
      // Unknown type -- skip the rest of the record. Don't throw;
      // a future system extension shouldn't break import of the
      // tags we DO understand.
      break
  }
  // Always snap the cursor back to the canonical end-of-record so
  // the caller can advance to the next record without arithmetic.
  // (The caller does its own seek() anyway, but this keeps debug
  // dumps tidy.)
  r.seek(Math.min(start + recordSize, r.tell()))
  return { type, name }
}

/**
 * Read the per-type name suffix. `NCHAR` map (from MNE):
 *  - MAGNETOMETER / AXIAL_GRAD: 6
 *  - TRIGGER / ECG / ETC: 32
 *  - EEG: 8
 *
 * Returns empty string for types not in the map; bounds-checked
 * against `available` so we don't overrun the record.
 */
function readKitChannelName(
  r: LeReader,
  type: number,
  available: number,
): string {
  const NCHAR: Record<number, number> = {
    [KIT_CHANNEL.MAGNETOMETER]: 6,
    [KIT_CHANNEL.AXIAL_GRADIOMETER]: 6,
    [KIT_CHANNEL.PLANAR_GRADIOMETER]: 6,
    [KIT_CHANNEL.AXIAL_GRADIOMETER_2ND]: 6,
    [KIT_CHANNEL.TRIGGER]: 32,
    [KIT_CHANNEL.EEG]: 8,
    [KIT_CHANNEL.ECG]: 32,
    [KIT_CHANNEL.ETC]: 32,
  }
  const n = NCHAR[type]
  if (n === undefined || available < n) return ''
  return r.readCString(n)
}

// ---------------------------------------------------------------------------
// Derived helpers consumed by `kitRecording.ts`.
// ---------------------------------------------------------------------------

export function recordingDurationSeconds(h: KitHeader): number {
  if (h.nSamples <= 0) return 0
  return h.nSamples / h.sfreq
}

/** Re-export KIT channel-type constants so callers can `switch` on them. */
export const KIT_CH = KIT_CHANNEL
