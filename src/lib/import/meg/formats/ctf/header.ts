// CTF `.res4` binary header parser. Pure-TS port of the relevant subset
// of `mne/io/ctf/res4.py` (MNE-Python, BSD-3-Clause). The format is a
// fixed-shape big-endian header followed by a variable-length channel
// table; only the fields that flow into the BIDS-MEG sidecars are
// extracted. Signal data (`.meg4`) is NOT touched here -- per the
// BIDS-MEG spec the raw vendor file passes through unchanged.
//
// Productionised from `scripts/spike-meg-ctf-res4.ts` after M10-A
// proved every parseable field matched the golden fixture
// (`tests/fixtures/meg-golden/ctf-spm-face/`). See
// `decisions/M10-meg-importer.md` for the per-field mapping and the
// known `RecordingDuration` discrepancy with MNE-BIDS.

// ---------------------------------------------------------------------------
// Big-endian byte reader. The CTF format is wholly big-endian regardless
// of the recording host's native byte order.
// ---------------------------------------------------------------------------

/**
 * Stateful cursor over a `DataView`. Mirrors the file-pointer behaviour
 * of the Python reader so the parser body reads top-to-bottom in the
 * same order as `mne/io/ctf/res4.py::_read_res4`. Out-of-range reads
 * raise rather than silently returning undefined -- a truncated header
 * is a real-world failure mode (DataLad pointer files, partial copies)
 * and must surface as an error rather than producing garbage fields.
 */
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

  /** Move to the next byte boundary (e.g. 8 for f64 alignment). */
  alignTo(boundary: number): void {
    const rem = this.off % boundary
    if (rem !== 0) this.off += boundary - rem
  }

  private ensure(n: number): void {
    if (this.off + n > this.view.byteLength) {
      throw new RangeError(
        `BeReader: read of ${n} bytes at offset ${this.off} would overrun the ${this.view.byteLength}-byte buffer`,
      )
    }
  }

  readUint8(): number {
    this.ensure(1)
    return this.view.getUint8(this.off++)
  }

  readInt16(): number {
    this.ensure(2)
    const v = this.view.getInt16(this.off, false)
    this.off += 2
    return v
  }

  readInt32(): number {
    this.ensure(4)
    const v = this.view.getInt32(this.off, false)
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
// CTF on-disk constants. Mirror `mne/io/ctf/constants.py`; only the
// values our parser depends on are mirrored here.
// ---------------------------------------------------------------------------

/** Hard-coded offset of the variable-length region (run-description text
 *  followed by filters then channel names). MNE calls this `FUNNY_POS`;
 *  it's a fixed format constant, not derivable from earlier fields. */
const FUNNY_POS = 1844

/** Max coils per channel record (`CTFV_MAX_COILS`). */
const CTFV_MAX_COILS = 8

/** Per-coil sub-structure: `pos[3] d0 norm[3] d1 turns d2 d3 area` in big-endian.
 *  Sizes: 3*f64 + f64 + 3*f64 + f64 + i16 + i32 + i16 + f64 = 80 bytes. */
const COIL_DT_SIZE = 3 * 8 + 8 + 3 * 8 + 8 + 2 + 4 + 2 + 8

/** Fixed-size header of each per-channel record (mirrors `_ch_dt` in
 *  `res4.py`): `sensor_type_index original_run_no coil_type proper_gain
 *  qgain io_gain io_offset num_coils grad_order_no d0`.
 *  Sizes: i16 + i16 + i32 + f64*4 + i16 + i16 + i32 = 48 bytes. */
const CH_DT_FIXED = 2 + 2 + 4 + 8 * 4 + 2 + 2 + 4

/** Full per-channel record stride: 48-byte fixed header + 2 coil arrays of
 *  CTFV_MAX_COILS entries each = 48 + 2 * (8 * 80) = 1328 bytes. */
const CH_DT_SIZE = CH_DT_FIXED + 2 * (COIL_DT_SIZE * CTFV_MAX_COILS)

// ---------------------------------------------------------------------------
// Parsed header shape. One value per `_meg.json` / `_channels.tsv` field
// the M10-B sidecar writers consume.
// ---------------------------------------------------------------------------

/**
 * Per-channel info extracted from the variable-length channel table.
 * Aligned 1:1 with the `name` array.
 */
export interface Res4Channel {
  /** Channel name, NUL-terminated within a 32-byte field. */
  name: string
  /**
   * CTF sensor type code. Documented values used by the channel
   * classifier in `formats/ctf/channels.ts`:
   *  - 0  CTFV_REF_MAG       (reference magnetometer)
   *  - 1  CTFV_REF_GRAD      (reference gradiometer)
   *  - 5  CTFV_MEG_CH        (MEG axial gradiometer / magnetometer)
   *  - 9  CTFV_EEG_CH        (EEG)
   *  - 11 CTFV_STIM_CH       (trigger / stimulus)
   *  - 13 CTFV_SCLK_CH       (system clock; reported as misc)
   *  - 17 CTFV_OTHER         (catch-all; reported as misc)
   * Any value not in the list above defaults to "misc" in the classifier.
   */
  sensorTypeIndex: number
  /**
   * Coil type code from `coil_type`. Forwarded to `_channels.tsv` so the
   * `description` column can distinguish axial vs. planar vs. magnetometer
   * coils. Values match MNE's `CTF.CTFV_COIL_*` set.
   */
  coilType: number
  /**
   * Software-gradient order applied to this channel. The modal value
   * across all MEG channels becomes
   * `_meg.json.SoftwareFilters.SpatialCompensation.GradientOrder`.
   */
  gradOrder: number
}

/** Parsed `.res4` header. Only the fields the BIDS-MEG writers need. */
export interface Res4Header {
  /** Magic string (e.g. `"MEG41RS"`, `"MEG42RS"`). */
  head: string
  /** Sampling frequency in Hz (CTF `sfreq`, big-endian f64). */
  sfreq: number
  /** Samples per trial. */
  nsamp: number
  /** Number of trials in the recording (1 = continuous). */
  noTrials: number
  /** Channel count (length of `channels` below). */
  nchan: number
  /** Recording date as written in the CTF header (e.g. `"24-Nov-2008"`).
   *  Free-form text -- normalisation to ISO 8601 happens in
   *  `formats/ctf/coordinates.ts`/`runMegImport.ts`. */
  dataDate: string
  /** Recording time as written (e.g. `"09:54"`). */
  dataTime: string
  /** Channels in source order. */
  channels: Res4Channel[]
}

/**
 * Read the magical `.res4` header. Pure: takes the raw bytes, returns a
 * structured header. Throws on truncation, magic-string mismatch, or
 * channel-count overflow.
 *
 * The caller is responsible for reading the file off disk; this keeps
 * the function trivially testable in `bun:test` with synthetic
 * `Uint8Array`s.
 */
export function parseRes4(buf: Uint8Array): Res4Header {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const r = new BeReader(view)

  const head = r.readCString(8)
  if (!head.startsWith('MEG')) {
    throw new Error(
      `parseRes4: not a CTF .res4 file (expected magic to start with "MEG", got ${JSON.stringify(head)})`,
    )
  }
  r.skip(256) // appname
  r.skip(256) // origin
  r.skip(256) // desc
  r.readInt16() // nave
  let dataTime = r.readCString(255)
  let dataDate = r.readCString(255)
  // CTF sometimes swaps these -- mirror MNE's heuristic (mne/io/ctf/res4.py:119).
  if (dataTime.includes('/') && dataDate.includes(':')) {
    const tmp = dataTime
    dataTime = dataDate
    dataDate = tmp
  }
  const nsamp = r.readInt32()
  const nchan = r.readInt16()
  if (nchan < 0 || nchan > 65535) {
    // 16-bit signed already constrains, but be explicit so future
    // refactors don't silently accept a -1 sentinel.
    throw new Error(`parseRes4: implausible nchan ${nchan}`)
  }
  r.alignTo(8)
  const sfreq = r.readFloat64()
  if (!(sfreq > 0)) {
    throw new Error(`parseRes4: non-positive sfreq ${sfreq}`)
  }
  r.readFloat64() // epoch_time -- unused for BIDS sidecars
  const noTrials = r.readInt16()
  r.alignTo(4)
  r.readInt32() // pre_trig_pts
  r.readInt16() // no_trials_done
  r.readInt16() // no_trials_bst_message_windowlay
  r.alignTo(4)
  r.readInt32() // save_trials
  r.readUint8() // primary_trigger
  r.skip(8) // secondary_trigger[CTFV_MAX_AVERAGE_BINS]
  r.readUint8() // trigger_polarity_mask
  r.readInt16() // trigger_mode
  r.alignTo(4)
  r.readInt32() // accept_reject
  r.readInt16() // run_time_bst_message_windowlay
  r.alignTo(4)
  r.readInt32() // zero_head
  r.alignTo(4)
  r.readInt32() // artifact_mode
  r.readInt32() // padding
  r.skip(32) // nf_run_name
  r.skip(256) // nf_run_title
  r.skip(32) // nf_instruments
  r.skip(32) // nf_collect_descriptor
  r.skip(32) // nf_subject_id
  r.skip(32) // nf_operator
  r.skip(60) // nf_sensor_file_name
  r.alignTo(4)
  const rdlen = r.readInt32()
  // The earlier struct is laid out for in-place editing by CTF tooling,
  // so the variable-length region always starts at the same offset
  // regardless of what fields above it actually contained.
  r.seek(FUNNY_POS)
  if (rdlen > 0) r.skip(rdlen) // run_desc

  // Filter table: `_read_filter` reads f64 freq + i32 class + i32 type
  // + i16 npar + npar * f64 pars. We don't store the filter values yet
  // -- `_channels.tsv.low_cutoff` / `.high_cutoff` derivation lands in
  // M10-B-2 once we have a real fixture exercising non-trivial filters.
  const nfilt = r.readInt16()
  for (let k = 0; k < nfilt; k++) {
    r.skip(8 + 4 + 4) // freq + class + type
    const npar = r.readInt16()
    r.skip(npar * 8)
  }

  // Channel names: nchan * 32 bytes.
  const names: string[] = new Array(nchan)
  for (let k = 0; k < nchan; k++) names[k] = r.readCString(32)

  // Per-channel info table. We only pull the three values the BIDS
  // writers care about; everything else (gains, coil geometry, head_coil)
  // is skipped via a fixed stride.
  const channels: Res4Channel[] = new Array(nchan)
  for (let k = 0; k < nchan; k++) {
    const start = r.tell()
    const sensorTypeIndex = r.readInt16()
    r.readInt16() // original_run_no
    const coilType = r.readInt32()
    r.skip(8 * 4) // proper_gain, qgain, io_gain, io_offset
    r.readInt16() // num_coils
    const gradOrder = r.readInt16()
    // Skip the remaining bytes of this channel record (padding + coil
    // arrays + head_coil arrays).
    r.seek(start + CH_DT_SIZE)
    channels[k] = { name: names[k], sensorTypeIndex, coilType, gradOrder }
  }

  return {
    head,
    sfreq,
    nsamp,
    noTrials,
    nchan,
    dataDate,
    dataTime,
    channels,
  }
}

/**
 * Compute the BIDS `RecordingDuration` (seconds) from header fields.
 * Naive formula `nsamp * noTrials / sfreq`. MNE-BIDS appears to use a
 * different convention (off by ~1 sample period in the spm_face_ctf
 * fixture); the discrepancy is tracked as risk #1 in the M10 decision
 * doc and either matched byte-exact in M10-B-2 once we pin down the
 * MNE-BIDS formula or covered by float tolerance in the diff.
 */
export function recordingDurationSeconds(h: Res4Header): number {
  return (h.nsamp * h.noTrials) / h.sfreq
}

/**
 * The same `'continuous' | 'epoched'` value BIDS emits in
 * `_meg.json.RecordingType`. CTF stores epoched (e.g. averaged) data
 * with `noTrials > 1` and a non-zero `pre_trig_pts`; we approximate
 * with the simpler rule used by MNE-BIDS.
 */
export function recordingType(h: Res4Header): 'continuous' | 'epoched' {
  return h.noTrials === 1 ? 'continuous' : 'epoched'
}
