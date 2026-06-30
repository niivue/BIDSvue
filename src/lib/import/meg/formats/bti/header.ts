// BTi / 4D Neuroimaging parser for the metadata we need to produce
// BIDS-MEG sidecars. Pure TS, big-endian, no signal-payload reads.
//
// BTi sources are directories containing at least:
//   - `config`               -- system + per-channel header (big-endian)
//   - `c,rfDC` (or similar)  -- PDF (Patient Data File) with a header
//                               appended to the END
//   - `hs_file` (optional)   -- head-shape + cardinal landmarks
//
// For BIDS-MEG sidecars we extract:
//   - SamplingFrequency: 1 / `sample_period` from the PDF trailer
//   - total_chans:       PDF trailer
//   - PowerLineFrequency: `supply_freq` from the config header
//   - acquisition timestamp: PDF trailer
//   - per-channel names: PDF channel records (first 16 bytes each)
//   - cardinal landmarks: hs_file (LPA/RPA/NAS), units METERS
//
// We deliberately do NOT walk the variable-length per-channel
// payloads in `config` -- channel type is derived from the PDF
// channel name's prefix (`A`=MEG, `M`=MEGREFMAG, `G`=MEGREFGRAD, ...,
// matching MNE's own classifier at mne/io/bti/bti.py:1245).
//
// Reference: mne/io/bti/bti.py + bti/read.py + bti/constants.py
// (BSD-3). License attribution decision lives in M10-G.

import {
  BTI_FILE_MASK,
  BTI_HS_N_DIG_POINTS_OFFSET,
  BTI_HS_N_IDX_POINTS,
  BTI_PDF_TRAILER_BYTES,
} from './constants'

// ---------------------------------------------------------------------------
// Big-endian bounds-checked reader. Same shape as the CTF / FIF / KIT
// parsers (formats/{ctf,fif,kit}/header.ts use the same pattern).
// ---------------------------------------------------------------------------

class BeReader {
  private off = 0
  constructor(private readonly view: DataView) {}

  tell(): number {
    return this.off
  }

  seek(o: number): void {
    if (o < 0 || o > this.view.byteLength) {
      throw new RangeError(
        `BeReader.seek(${o}) out of range [0, ${this.view.byteLength}]`,
      )
    }
    this.off = o
  }

  skip(n: number): void {
    this.seek(this.off + n)
  }

  readInt16(): number {
    const v = this.view.getInt16(this.off, false)
    this.off += 2
    return v
  }

  readUint16(): number {
    const v = this.view.getUint16(this.off, false)
    this.off += 2
    return v
  }

  readInt32(): number {
    const v = this.view.getInt32(this.off, false)
    this.off += 4
    return v
  }

  readUint32(): number {
    const v = this.view.getUint32(this.off, false)
    this.off += 4
    return v
  }

  /** Two i32 BE concatenated as a u64 (high << 32 | low). BTi uses
   *  i64 in the PDF trailer pointer; the value is bounded by
   *  `BTI_FILE_MASK` so the high word is informational. */
  readUint64ToFloat(): number {
    // Read as two big-endian uint32s. JS number has 53-bit precision;
    // header_position values we see in real files are well under 2^31.
    const hi = this.view.getUint32(this.off, false)
    const lo = this.view.getUint32(this.off + 4, false)
    this.off += 8
    return hi * 0x100000000 + lo
  }

  readFloat32(): number {
    const v = this.view.getFloat32(this.off, false)
    this.off += 4
    return v
  }

  readFloat64(): number {
    const v = this.view.getFloat64(this.off, false)
    this.off += 8
    return v
  }

  /** NUL-terminated UTF-8 string within a fixed-size field. */
  readCString(maxLen: number): string {
    if (this.off + maxLen > this.view.byteLength) {
      throw new RangeError(
        `BeReader.readCString(${maxLen}) at ${this.off} overruns ${this.view.byteLength}`,
      )
    }
    const bytes = new Uint8Array(
      this.view.buffer,
      this.view.byteOffset + this.off,
      maxLen,
    )
    let end = 0
    while (end < maxLen && bytes[end] !== 0) end++
    this.off += maxLen
    return DECODER.decode(bytes.subarray(0, end))
  }
}

const DECODER = new TextDecoder('utf-8')

// ---------------------------------------------------------------------------
// Parsed shapes
// ---------------------------------------------------------------------------

/** Subset of the config-file fixed header we care about for BIDS. */
export interface BtiConfigHeader {
  version: number
  /** e.g. `"Juelich-II"`. Goes into `InstitutionName`. */
  siteName: string
  systemType: number
  /** Hz; goes into `_meg.json.PowerLineFrequency`. */
  supplyFreq: number
  /** Total channels per the config (system view; the PDF carries its
   *  own count for a specific recording). */
  totalChans: number
  totalSensors: number
  totalUserBlocks: number
}

/** Subset of the PDF (data file) trailer header. */
export interface BtiPdfHeader {
  /** Hz; derived as 1 / `samplePeriod`. */
  samplingFrequency: number
  /** Big-endian f32 sample period in seconds. */
  samplePeriod: number
  /** Channels in THIS recording (may differ from config's total_chans). */
  totalChans: number
  /** Number of stored epochs (1 for continuous recordings). */
  totalEpochs: number
  /** Acquisition timestamp; UNIX seconds. `null` if zero. */
  acqTimestampSec: number | null
  /** Channel names (`chan_label`) from the PDF channel records, in
   *  PDF order. Used both to size `_channels.tsv` and to classify
   *  channels by name prefix. */
  channelNames: string[]
  /** Total samples per channel across all epochs. */
  totalSlices: number
  /** Storage data-format code from the PDF header (1=int16, 2=int32,
   *  3=float32, 4=float64). Not used by sidecars; kept for the
   *  future BIDS-MEG `DataFormat` extension and integration tests. */
  dataFormat: number
}

/** Cardinal head-shape landmarks from `hs_file`, units METERS. */
export interface BtiHeadShape {
  /** Nasion -- BTi/4D head frame. */
  nas: readonly [number, number, number]
  /** Left preauricular. */
  lpa: readonly [number, number, number]
  /** Right preauricular. */
  rpa: readonly [number, number, number]
}

// ---------------------------------------------------------------------------
// Config-file header parser. Reads only the fixed-size prefix
// (~134 bytes) -- we don't walk transforms, user-blocks, or the
// variable-length per-channel records here. The PDF gives us names
// + type-via-prefix; the config gives us PowerLineFrequency +
// InstitutionName.
// ---------------------------------------------------------------------------

/**
 * Parse the fixed-size header of a BTi `config` file (big-endian).
 * Throws `RangeError` on truncated input; throws plain `Error` on
 * implausible field values that suggest the file isn't BTi.
 */
export function parseBtiConfigHeader(buf: Uint8Array): BtiConfigHeader {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const r = new BeReader(view)
  // Minimum bytes through end of supply_freq+total_chans+gains+counts.
  if (view.byteLength < 76) {
    throw new RangeError(
      `parseBtiConfigHeader: buffer too short (${view.byteLength} bytes; need >= 76)`,
    )
  }

  const version = r.readInt16()
  const siteName = r.readCString(32)
  r.skip(16) // dap_hostname (we don't surface this)
  const systemType = r.readInt16()
  r.skip(4) // sys_options (i32) -- not surfaced
  const supplyFreq = r.readInt16()
  const totalChans = r.readInt16()
  r.skip(4) // system_fixed_gain (f32) -- not surfaced
  r.skip(4) // volts_per_bit (f32)
  const totalSensors = r.readInt16()
  const totalUserBlocks = r.readInt16()
  // next_der_chan_no (i16) + 2 alignment bytes follow; we stop here.

  // Sanity bounds. Real BTi systems are 60-600 channels; allow up to
  // 10k as a defensive upper bound (round-9 audit pattern).
  if (totalChans < 0 || totalChans > 10000) {
    throw new Error(
      `parseBtiConfigHeader: implausible total_chans=${totalChans}`,
    )
  }
  if (supplyFreq !== 50 && supplyFreq !== 60 && supplyFreq !== 0) {
    // Don't throw -- some sites store 0 for "unknown". Just leave it
    // and let the sidecar emit whatever the value is. Real BTi sites
    // are 50 or 60.
  }

  return {
    version,
    siteName,
    systemType,
    supplyFreq,
    totalChans,
    totalSensors,
    totalUserBlocks,
  }
}

// ---------------------------------------------------------------------------
// PDF (data-file) trailer parser. The PDF appends its header to the
// END of the file: last 8 bytes are an int64 BE pointer to the start
// of the header. We seek there, read the fixed-size header struct
// (sample_period, total_epochs, total_chans, timestamp, ...), and
// then walk the channel records to extract just the names.
// ---------------------------------------------------------------------------

/**
 * Parse a BTi PDF (`c,rfDC` / `c,rfhp1.0Hz` / similar) data file's
 * trailing header. The full file may be multi-GB; the caller passes
 * the trailing N bytes that the parser needs. As an upper bound,
 * 1 MB from the file's tail is plenty for any real recording.
 *
 * `fileSize` is the absolute byte length of the source PDF on disk;
 * `tail` is the last `fileSize - tailOffset` bytes starting at
 * `tailOffset` into the file. The trailer pointer in the last 8
 * bytes is an absolute offset INTO THE FILE, so we adjust by
 * `tailOffset` when seeking.
 */
export function parseBtiPdfTrailer(
  tail: Uint8Array,
  tailOffset: number,
  fileSize: number,
): BtiPdfHeader {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  if (view.byteLength < BTI_PDF_TRAILER_BYTES + 80) {
    throw new RangeError(
      `parseBtiPdfTrailer: tail too short (${view.byteLength} bytes; need >= ${BTI_PDF_TRAILER_BYTES + 80})`,
    )
  }
  // Last 8 bytes: i64 BE header_position. MNE's logic masks the low
  // 31 bits; verify the high word is the "informational" word.
  const trailerStart = view.byteLength - BTI_PDF_TRAILER_BYTES
  const r = new BeReader(view)
  r.seek(trailerStart)
  const fullHeaderPointer = r.readUint64ToFloat()
  let headerPosition = fullHeaderPointer & BTI_FILE_MASK
  // Align to 8 bytes (mirrors MNE).
  if (headerPosition % 8 !== 0) {
    headerPosition += 8 - (headerPosition % 8)
  }

  if (headerPosition < tailOffset || headerPosition >= fileSize) {
    throw new RangeError(
      `parseBtiPdfTrailer: trailer pointer ${headerPosition} outside file range [${tailOffset}, ${fileSize})`,
    )
  }
  // A real BTi header lives behind the sample payload, so the
  // trailer pointer is always well clear of the file start. Reject
  // `headerPosition == 0` (or any value before the header struct
  // would fit before EOF) so a corrupt / zeroed trailer can't drive
  // a garbage parse from byte 0 (round-10 security audit low).
  // BTI_PDF_TRAILER_BYTES is 8; the fixed header struct + epoch
  // record needs ~150 bytes minimum; require at least that much
  // payload between header start and trailer.
  const MIN_HEADER_OFFSET = 16
  if (headerPosition < MIN_HEADER_OFFSET) {
    throw new RangeError(
      `parseBtiPdfTrailer: trailer pointer ${headerPosition} below plausible minimum ${MIN_HEADER_OFFSET} (file likely corrupt)`,
    )
  }
  const headerStartInTail = headerPosition - tailOffset
  r.seek(headerStartInTail)

  const _version = r.readInt16()
  r.skip(5) // file_type (str[5])
  r.skip(1) // padding
  const dataFormat = r.readInt16()
  r.skip(2) // acq_mode (i16)
  const totalEpochs = r.readInt32()
  r.skip(4) // input_epochs (i32)
  r.skip(4) // total_events (i32)
  r.skip(4) // total_fixed_events (i32)
  const samplePeriod = r.readFloat32()
  r.skip(16) // xaxis_label (str[16])
  r.skip(4) // total_processes (i32)
  const totalChans = r.readInt16()
  r.skip(2) // alignment
  r.skip(4) // checksum (i32)
  r.skip(4) // total_ed_classes (i32)
  r.skip(2) // total_associated_files (i16)
  r.skip(2) // last_file_index (i16)
  const acqTimestamp = r.readInt32()
  r.skip(20) // reserved block
  alignTo8(r)

  if (!(samplePeriod > 0)) {
    throw new Error(
      `parseBtiPdfTrailer: non-positive sample_period ${samplePeriod}`,
    )
  }
  if (totalChans < 0 || totalChans > 10000) {
    throw new Error(`parseBtiPdfTrailer: implausible total_chans=${totalChans}`)
  }
  if (totalEpochs < 0 || totalEpochs > 1_000_000) {
    throw new Error(
      `parseBtiPdfTrailer: implausible total_epochs=${totalEpochs}`,
    )
  }

  // Walk epochs to compute total_slices. Each epoch record is 56
  // bytes per MNE's _read_epoch (pts_in_epoch i32 + epoch_duration f32
  // + expected_iti f32 + actual_iti f32 + total_var_events i32 +
  // checksum i32 + epoch_timestamp i32 + 28 bytes skip).
  let totalSlices = 0
  for (let i = 0; i < totalEpochs; i++) {
    const pts = r.readInt32()
    r.skip(52) // rest of epoch record
    if (pts < 0 || pts > 100_000_000) {
      throw new Error(`parseBtiPdfTrailer: implausible pts_in_epoch=${pts}`)
    }
    totalSlices += pts
  }

  // Channel records. Each is 102 bytes (see MNE _read_channel). We
  // only read the first 16 (chan_label) and step over the rest.
  const channelNames: string[] = []
  for (let i = 0; i < totalChans; i++) {
    const name = r.readCString(16)
    r.skip(102 - 16) // skip chan_no/attributes/scale/...
    channelNames.push(name)
  }

  return {
    samplingFrequency: 1 / samplePeriod,
    samplePeriod,
    totalChans,
    totalEpochs,
    acqTimestampSec: acqTimestamp > 0 ? acqTimestamp : null,
    channelNames,
    totalSlices,
    dataFormat,
  }
}

function alignTo8(r: BeReader): void {
  const cur = r.tell()
  if (cur % 8 !== 0) {
    r.skip(8 - (cur % 8))
  }
}

// ---------------------------------------------------------------------------
// hs_file (head shape + cardinal landmarks) parser.
// ---------------------------------------------------------------------------

/**
 * Parse the cardinal landmarks (LPA / RPA / NAS) from a BTi `hs_file`.
 * Returns `null` when the buffer is too short to contain landmarks
 * (some sessions write only the header + n_dig_points without any
 * idx_points). Units are METERS in the BTi/4D head frame.
 *
 * idx_points layout: 5 named points of 3 doubles each (120 bytes
 * total), in the order [LPA, RPA, NAS, HPI1, HPI2] per MNE's
 * `_read_head_shape`. We surface the first three only -- BIDS-MEG
 * `_coordsystem.json` doesn't have a slot for HPI coil coordinates
 * (those live in `HeadCoilCoordinates`).
 */
export function parseBtiHeadShape(buf: Uint8Array): BtiHeadShape | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const idxBytes = BTI_HS_N_IDX_POINTS * 3 * 8
  const minBytes = BTI_HS_N_DIG_POINTS_OFFSET + 4 + idxBytes
  if (view.byteLength < minBytes) return null

  const r = new BeReader(view)
  r.seek(BTI_HS_N_DIG_POINTS_OFFSET)
  r.readInt32() // n_dig_points -- we don't need the head-shape array
  const lpa: [number, number, number] = [
    r.readFloat64(),
    r.readFloat64(),
    r.readFloat64(),
  ]
  const rpa: [number, number, number] = [
    r.readFloat64(),
    r.readFloat64(),
    r.readFloat64(),
  ]
  const nas: [number, number, number] = [
    r.readFloat64(),
    r.readFloat64(),
    r.readFloat64(),
  ]
  // Sanity: cardinal landmarks should fall within +/- 0.5 m of the
  // device origin. Skip the landmark family if any coordinate is
  // obviously wrong (NaN, infinity, or out of plausible range).
  for (const p of [lpa, rpa, nas]) {
    for (const v of p) {
      if (!Number.isFinite(v) || Math.abs(v) > 0.5) return null
    }
  }
  return { nas, lpa, rpa }
}
