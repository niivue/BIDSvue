// FIFF (Functional Imaging File Format) header parser. Pure-TS port
// of the subset of `mne/_fiff/tag.py` + `meas_info.py` we need to
// produce a BIDS-MEG sidecar. Vendor-targeted at Elekta / MEGIN /
// Neuromag systems; CTF + KIT + BTi data can ALSO end up in a FIF
// file (MNE-Python converts them on read), but we don't try to
// detect that here -- those flow through M10-B (CTF) / M10-D (KIT)
// / M10-E (BTi) by source-path extension.
//
// Signal data (the FIFF_DATA_BUFFER tags inside FIFFB_RAW_DATA) is
// NEVER read by this parser. We walk tag headers (16 bytes each)
// and skip payloads we don't need by advancing the cursor past
// `size` bytes -- the parser's memory footprint stays bounded
// regardless of file size, which matters a lot for FIF since a
// single multi-GB raw file is normal.

import type { Point3 } from '../../recording'

// ---------------------------------------------------------------------------
// Big-endian byte reader. Same shape as the CTF reader; FIFF is also
// wholly big-endian regardless of the recording host's byte order.
// ---------------------------------------------------------------------------

class BeReader {
  private off = 0
  constructor(private readonly view: DataView) {}

  tell(): number {
    return this.off
  }

  seek(pos: number): void {
    if (pos < 0 || pos > this.view.byteLength) {
      throw new RangeError(
        `BeReader.seek(${pos}) out of range (buffer is ${this.view.byteLength} bytes)`,
      )
    }
    this.off = pos
  }

  byteLength(): number {
    return this.view.byteLength
  }

  remaining(): number {
    return this.view.byteLength - this.off
  }

  private ensure(n: number): void {
    if (this.off + n > this.view.byteLength) {
      throw new RangeError(
        `BeReader: read of ${n} bytes at offset ${this.off} would overrun the ${this.view.byteLength}-byte buffer`,
      )
    }
  }

  readInt32(): number {
    this.ensure(4)
    const v = this.view.getInt32(this.off, false)
    this.off += 4
    return v
  }

  readUint32(): number {
    this.ensure(4)
    const v = this.view.getUint32(this.off, false)
    this.off += 4
    return v
  }

  readFloat32(): number {
    this.ensure(4)
    const v = this.view.getFloat32(this.off, false)
    this.off += 4
    return v
  }

  readFloat64(): number {
    this.ensure(8)
    const v = this.view.getFloat64(this.off, false)
    this.off += 8
    return v
  }

  /** Read `n` bytes and return the leading C-string (up to the first NUL). */
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
    return DECODER.decode(slice)
  }

  skip(n: number): void {
    this.ensure(n)
    this.off += n
  }
}

const DECODER = new TextDecoder('utf-8')

// ---------------------------------------------------------------------------
// FIFF constants. Mirror `mne/_fiff/constants.py` -- only the values
// our parser depends on are mirrored here.
// ---------------------------------------------------------------------------

const FIFF = {
  // Tag kinds (just the ones we read).
  FIFF_FILE_ID: 100,
  FIFF_BLOCK_START: 104,
  FIFF_BLOCK_END: 105,
  FIFF_NCHAN: 200,
  FIFF_SFREQ: 201,
  FIFF_CH_INFO: 203,
  FIFF_MEAS_DATE: 204,
  FIFF_FIRST_SAMPLE: 208,
  FIFF_LAST_SAMPLE: 209,
  FIFF_DIG_POINT: 213,
  FIFF_LINE_FREQ: 235,

  // Block types (payload of BLOCK_START / BLOCK_END tags).
  FIFFB_MEAS: 100,
  FIFFB_MEAS_INFO: 101,
  FIFFB_RAW_DATA: 102,
  FIFFB_PROCESSED_DATA: 103,
  FIFFB_ISOTRAK: 107,

  // Channel kinds (FIFF_CH_INFO.kind values).
  FIFFV_MEG_CH: 1,
  FIFFV_EEG_CH: 2,
  FIFFV_STIM_CH: 3,
  FIFFV_MCG_CH: 201,
  FIFFV_EOG_CH: 202,
  FIFFV_REF_MEG_CH: 301,
  FIFFV_EMG_CH: 302,
  FIFFV_ECG_CH: 402,
  FIFFV_MISC_CH: 502,

  // Dig point kinds (FIFF_DIG_POINT.kind values).
  FIFFV_POINT_CARDINAL: 1,
  FIFFV_POINT_HPI: 2,
  FIFFV_POINT_EEG: 3,
  FIFFV_POINT_EXTRA: 4,

  // Dig point ident values for FIFFV_POINT_CARDINAL.
  FIFFV_POINT_LPA: 1,
  FIFFV_POINT_NASION: 2,
  FIFFV_POINT_RPA: 3,

  // `next` field sentinels.
  FIFFV_NEXT_SEQ: 0, // next tag is immediately after this one's payload
  FIFFV_NEXT_NONE: -1, // end of stream
} as const

/** Per-channel struct size on disk. Matches the layout in `_read_ch_info_struct`
 *  -- 6 i32/f32 + 48-byte loc + 2 i32 + 16-byte name = 96 bytes. */
const CH_INFO_STRUCT_SIZE = 4 * 6 + 48 + 4 * 2 + 16

/** Per-dig-point struct size on disk. Matches `_read_dig_point_struct`
 *  -- 2 i32 + 3 f32 = 20 bytes. */
const DIG_POINT_STRUCT_SIZE = 4 * 2 + 4 * 3

// ---------------------------------------------------------------------------
// Parsed shapes. Vendor-agnostic where possible; FIF-specific extras
// (the FIFF kind / coil_type integers) flow through verbatim so the
// channel classifier in `formats/fif/channels.ts` doesn't have to
// re-parse.
// ---------------------------------------------------------------------------

/**
 * One channel as it appears in a FIFF_CH_INFO tag. Most fields are
 * forwarded verbatim; `kind` and `coil_type` are the discriminants
 * the BIDS classifier uses, `loc` is reserved for `_coordsystem.json`
 * + per-channel position metadata when we wire that in.
 */
export interface FifChannel {
  scanno: number
  logno: number
  /** FIFFV_*_CH (1=MEG, 2=EEG, 3=STIM, ...). */
  kind: number
  range: number
  cal: number
  /** FIFFV_COIL_VV_MAG_* / FIFFV_COIL_VV_PLANAR_* / ... */
  coilType: number
  /** Channel location vector (12 floats: position + orientation matrix). */
  loc: readonly number[]
  /** FIFF_UNIT_* enum -- 107 = Tesla, 112 = Volt, ... */
  unit: number
  /** Decimal exponent multiplier for `unit` (e.g. -12 = pico). */
  unitMul: number
  /** NUL-terminated 16-byte channel name. */
  name: string
}

/**
 * One digitization point. For `_coordsystem.json` we only care about
 * the cardinal landmarks (`kind === FIFFV_POINT_CARDINAL`); HPI / EEG
 * / extra-head-shape points are exposed in case a future writer wants
 * to put them under `DigitizedHeadPoints`.
 */
export interface FifDigPoint {
  kind: number
  /** For cardinals: 1=LPA, 2=Nasion, 3=RPA. */
  ident: number
  /** [x, y, z] in meters, Neuromag head coordinate frame. */
  r: Point3
}

/** Parsed FIFF header. Only the fields the BIDS-MEG writers consume. */
export interface FifHeader {
  /** Sampling frequency in Hz. */
  sfreq: number
  /** Channel count. */
  nchan: number
  /** First sample of the recording (0-based; can be negative for some pipelines). */
  firstSample: number
  /** Last sample of the recording. */
  lastSample: number
  /** Power-line frequency (50 or 60 Hz) if recorded, else null. */
  lineFreq: number | null
  /** ISO 8601 UTC string built from FIFF_MEAS_DATE, or null when absent. */
  measDate: string | null
  /** Channels in source order. */
  channels: FifChannel[]
  /** Digitization points. Empty when no FIFFB_ISOTRAK block was found. */
  digPoints: FifDigPoint[]
}

/**
 * Parse a FIFF file's header. Walks tags linearly until either the
 * `next == -1` sentinel or the end of the buffer. We don't follow the
 * `FIFF_DIR_POINTER` directory at end-of-file -- a forward walk is
 * cheap once we skip past payloads we don't need, and the directory
 * is optional anyway (some files omit it).
 *
 * Throws on truncated buffers or implausible NCHAN values; otherwise
 * tolerates missing optional tags (LINE_FREQ, MEAS_DATE, DIG_POINTs).
 */
export function parseFif(buf: Uint8Array): FifHeader {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const r = new BeReader(view)

  let sfreq: number | null = null
  let nchan: number | null = null
  let firstSample: number | null = null
  let lastSample: number | null = null
  let lineFreq: number | null = null
  let measDate: string | null = null
  const channels: FifChannel[] = []
  const digPoints: FifDigPoint[] = []

  while (r.remaining() >= 16) {
    const tagStart = r.tell()
    const kind = r.readInt32()
    r.readUint32() // type -- used by MNE's dispatcher; we discriminate by kind here
    const size = r.readInt32()
    const next = r.readInt32()
    const payloadStart = r.tell()

    if (size < 0 || payloadStart + size > view.byteLength) {
      throw new RangeError(
        `parseFif: tag at ${tagStart} declares size=${size} which overruns the ${view.byteLength}-byte buffer`,
      )
    }

    switch (kind) {
      case FIFF.FIFF_NCHAN:
        nchan = r.readInt32()
        break
      case FIFF.FIFF_SFREQ:
        sfreq = r.readFloat32()
        break
      case FIFF.FIFF_FIRST_SAMPLE:
        firstSample = r.readInt32()
        break
      case FIFF.FIFF_LAST_SAMPLE:
        lastSample = r.readInt32()
        break
      case FIFF.FIFF_LINE_FREQ:
        lineFreq = r.readFloat32()
        break
      case FIFF.FIFF_MEAS_DATE: {
        const secs = r.readInt32()
        const usecs = r.readInt32()
        // FIFF stores seconds + microseconds since UNIX epoch. Build
        // an ISO 8601 string (millisecond precision; FIF's microsecond
        // value rounds to ms — BIDS doesn't require sub-second
        // precision in _scans.tsv).
        const ms = secs * 1000 + Math.round(usecs / 1000)
        measDate = new Date(ms).toISOString()
        break
      }
      case FIFF.FIFF_CH_INFO:
        if (size !== CH_INFO_STRUCT_SIZE) {
          throw new Error(
            `parseFif: FIFF_CH_INFO tag has size=${size}, expected ${CH_INFO_STRUCT_SIZE}`,
          )
        }
        channels.push(readChannelInfo(r))
        break
      case FIFF.FIFF_DIG_POINT:
        if (size !== DIG_POINT_STRUCT_SIZE) {
          throw new Error(
            `parseFif: FIFF_DIG_POINT tag has size=${size}, expected ${DIG_POINT_STRUCT_SIZE}`,
          )
        }
        digPoints.push(readDigPoint(r))
        break
      default:
        // Skip everything else (BLOCK_START / BLOCK_END payloads,
        // FIFF_FILE_ID, calibration matrices, FIFFB_RAW_DATA buffers,
        // ...). We don't actually need to track block nesting for the
        // tags we care about -- FIFF_NCHAN / FIFF_SFREQ appear at most
        // once per file, FIFF_CH_INFO is always inside MEAS_INFO, etc.
        break
    }

    // Defensive cursor: any tag-specific reader might have stopped
    // short of the full payload (e.g. ch_info reading 96 bytes when
    // size is exactly 96 leaves us at payloadStart + size, but if a
    // future variant has trailing alignment bytes the cursor would
    // be short). Snap back to the canonical end-of-payload.
    r.seek(payloadStart + size)

    if (next === FIFF.FIFFV_NEXT_NONE) break
    if (next !== FIFF.FIFFV_NEXT_SEQ) {
      // Positive `next` is an absolute file offset for the next tag.
      // Used by directory entries; for our linear walk we honour it
      // so we can't accidentally re-read the same tag.
      //
      // Reject zero / backward / non-advancing `next` offsets: a
      // crafted file pointing at or before the current tag start
      // would otherwise re-read the same bytes forever (round-9
      // security audit — DoS on malformed import).
      if (next <= tagStart) {
        throw new RangeError(
          `parseFif: tag at ${tagStart} declares non-advancing next=${next} (must be > ${tagStart})`,
        )
      }
      r.seek(next)
    }
  }

  if (sfreq === null) {
    throw new Error('parseFif: required FIFF_SFREQ tag not found')
  }
  if (nchan === null) {
    throw new Error('parseFif: required FIFF_NCHAN tag not found')
  }
  if (!(sfreq > 0)) {
    throw new Error(`parseFif: non-positive sfreq ${sfreq}`)
  }
  if (nchan < 0 || nchan > 100000) {
    throw new Error(`parseFif: implausible nchan ${nchan}`)
  }
  // FIRST/LAST_SAMPLE live in the RAW_DATA block, after MEAS_INFO. If
  // the buffer is only a header truncation we may not have hit them
  // yet -- emit zero so RecordingDuration becomes 0 instead of NaN.
  // The orchestrator's BIDS-validator pass would flag this.
  firstSample = firstSample ?? 0
  lastSample = lastSample ?? -1

  if (channels.length !== nchan) {
    throw new Error(
      `parseFif: FIFF_NCHAN=${nchan} but found ${channels.length} FIFF_CH_INFO tags`,
    )
  }

  return {
    sfreq,
    nchan,
    firstSample,
    lastSample,
    lineFreq,
    measDate,
    channels,
    digPoints,
  }
}

function readChannelInfo(r: BeReader): FifChannel {
  const scanno = r.readInt32()
  const logno = r.readInt32()
  const kind = r.readInt32()
  const range = r.readFloat32()
  const cal = r.readFloat32()
  const coilType = r.readInt32()
  const loc: number[] = new Array(12)
  for (let i = 0; i < 12; i++) loc[i] = r.readFloat32()
  const unit = r.readInt32()
  const unitMul = r.readInt32()
  const name = r.readCString(16)
  return { scanno, logno, kind, range, cal, coilType, loc, unit, unitMul, name }
}

function readDigPoint(r: BeReader): FifDigPoint {
  const kind = r.readInt32()
  const ident = r.readInt32()
  const x = r.readFloat32()
  const y = r.readFloat32()
  const z = r.readFloat32()
  return { kind, ident, r: [x, y, z] }
}

// ---------------------------------------------------------------------------
// Derived helpers consumed by `fifRecording.ts` / writers.
// ---------------------------------------------------------------------------

/**
 * `RecordingDuration` in seconds. FIF stores it as `firstSample` and
 * `lastSample` (both inclusive); duration = (last - first + 1) / sfreq.
 * Returns 0 when the header didn't include the RAW_DATA boundaries
 * (truncated buffer / file with no recorded signal).
 */
export function recordingDurationSeconds(h: FifHeader): number {
  const n = h.lastSample - h.firstSample + 1
  if (n <= 0) return 0
  return n / h.sfreq
}

/** Re-export the FIFF constants so callers can switch on them without redefinition. */
export const FIFF_KIND = {
  MEG: FIFF.FIFFV_MEG_CH,
  EEG: FIFF.FIFFV_EEG_CH,
  STIM: FIFF.FIFFV_STIM_CH,
  MCG: FIFF.FIFFV_MCG_CH,
  EOG: FIFF.FIFFV_EOG_CH,
  REF_MEG: FIFF.FIFFV_REF_MEG_CH,
  EMG: FIFF.FIFFV_EMG_CH,
  ECG: FIFF.FIFFV_ECG_CH,
  MISC: FIFF.FIFFV_MISC_CH,
} as const

export const FIFF_DIG = {
  CARDINAL: FIFF.FIFFV_POINT_CARDINAL,
  HPI: FIFF.FIFFV_POINT_HPI,
  EEG: FIFF.FIFFV_POINT_EEG,
  EXTRA: FIFF.FIFFV_POINT_EXTRA,
  LPA: FIFF.FIFFV_POINT_LPA,
  NASION: FIFF.FIFFV_POINT_NASION,
  RPA: FIFF.FIFFV_POINT_RPA,
} as const
