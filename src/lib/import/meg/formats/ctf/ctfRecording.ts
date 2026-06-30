// Build a vendor-agnostic `MegRecording` from a parsed CTF `.res4`
// header plus a few wizard-supplied bits (TaskName, head-localization
// info). Pure function so the sidecar writers can be tested in
// isolation from any filesystem.
//
// Vendor-specific `_meg.json` fields (SoftwareFilters, DewarPosition,
// ContinuousHeadLocalization, ...) ride through `meta.vendorMeta` --
// the writer copies them verbatim without per-vendor branches.

import type {
  MegCoordinates,
  MegRecording,
  MegRecordingMeta,
} from '../../recording'
import { floatVal } from '../../writers/sidecars'
import { ctfChannelCounts, ctfChannelsToMegChannels } from './channels'
import {
  type Res4Header,
  recordingDurationSeconds,
  recordingType,
} from './header'

export interface CtfRecordingOpts {
  /** `_meg.json.TaskName`. From the wizard. */
  taskName: string
  /**
   * Whether continuous head-localization (CHL) was on during the
   * recording. Lives in the .acq / .infods sidecars; not yet parsed.
   * Wizard exposes a checkbox (default true for CTF -- the standard
   * default). When .acq parsing lands this becomes an override
   * rather than a primary source.
   */
  continuousHeadLocalization?: boolean
  /**
   * Whether the head-coil positions in .hc match anatomical landmarks
   * (LPA / RPA / NAS). True on every CTF system we've seen --
   * head-coils ARE the landmarks. Wizard exposes a checkbox; default
   * true.
   */
  digitizedLandmarks?: boolean
  /**
   * Whether a separate head-shape file (.hsp / .hsf) was recorded.
   * False unless the wizard knows otherwise.
   */
  digitizedHeadPoints?: boolean
  /** `_meg.json.PowerLineFrequency`. From the wizard. `null` -> "n/a". */
  powerLineFrequency?: number | null
  /**
   * `_meg.json.DewarPosition`. From the wizard (`"upright"`,
   * `"supine"`, etc.). `null` -> "n/a".
   */
  dewarPosition?: string | null
  /**
   * Parsed `.hc` head-coil coordinates (NAS / LPA / RPA in CTF head
   * frame, cm). The orchestrator parses the file and threads the
   * result through; passing `null` skips `_coordsystem.json`
   * emission. See `parseCtfHc` in `coordinates.ts`.
   */
  coordinates?: MegCoordinates | null
}

/**
 * Modal value across a numeric array, ignoring zero. Used to pull a
 * single representative gradient-order out of the per-channel
 * `gradOrder` field -- MNE-BIDS reports `GradientOrder` as a scalar
 * even though the underlying data is per-channel. Returns 0 if every
 * channel has gradient order 0 or the input is empty.
 */
function modalNonZero(values: readonly number[]): number {
  const counts = new Map<number, number>()
  for (const v of values) {
    if (v === 0) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  let best = 0
  let bestCount = 0
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v
      bestCount = c
    }
  }
  return best
}

/**
 * Build a `MegRecording` from a parsed `.res4` header plus the wizard
 * options. Pure.
 */
export function ctfRecordingFromRes4(
  header: Res4Header,
  opts: CtfRecordingOpts,
): MegRecording {
  const channels = ctfChannelsToMegChannels(header.channels, header.sfreq)
  const counts = ctfChannelCounts(channels)

  // SoftwareFilters.SpatialCompensation.GradientOrder from the modal
  // per-channel grad_order_no among MEG (not REF) channels.
  const megGradOrders: number[] = []
  for (let i = 0; i < header.channels.length; i++) {
    if (channels[i].type.startsWith('MEGGRAD')) {
      megGradOrders.push(header.channels[i].gradOrder)
    }
  }
  const gradientOrder = modalNonZero(megGradOrders)

  // vendorMeta carries every `_meg.json` field after SamplingFrequency
  // in the EXACT order MNE-BIDS emits them for the spm_face_ctf
  // golden:
  //   SoftwareFilters
  //   RecordingDuration              (typed; injected here for ordering)
  //   RecordingType                  (typed; injected here for ordering)
  //   DewarPosition
  //   DigitizedLandmarks
  //   DigitizedHeadPoints
  //   MEGChannelCount                (typed; injected here for ordering)
  //   MEGREFChannelCount             (typed; injected here for ordering)
  //   ContinuousHeadLocalization
  //   HeadCoilFrequency
  //   EEGChannelCount  ..  TriggerChannelCount  (typed; injected here)
  //
  // The writer in `writers/sidecars.ts` iterates vendorMeta in
  // insertion order; any typed field not present in vendorMeta gets
  // appended at the tail, so simpler vendors (FIF / KIT / BTi) can
  // ship without manually composing the full map.
  const vendorMeta: Record<string, unknown> = {
    SoftwareFilters: {
      SpatialCompensation: { GradientOrder: gradientOrder },
    },
    RecordingDuration: floatVal(recordingDurationSeconds(header)),
    RecordingType: recordingType(header),
    DewarPosition: opts.dewarPosition ?? 'n/a',
    DigitizedLandmarks: opts.digitizedLandmarks ?? true,
    DigitizedHeadPoints: opts.digitizedHeadPoints ?? false,
    MEGChannelCount: counts.meg,
    MEGREFChannelCount: counts.megref,
    ContinuousHeadLocalization: opts.continuousHeadLocalization ?? true,
    // Per the BIDS spec HeadCoilFrequency is an array of HPI coil
    // frequencies in Hz. CTF .res4 doesn't store these explicitly so
    // we emit an empty array (matches MNE-BIDS's spm_face_ctf output).
    HeadCoilFrequency: [],
    EEGChannelCount: counts.eeg,
    EOGChannelCount: counts.eog,
    ECGChannelCount: counts.ecg,
    EMGChannelCount: counts.emg,
    MiscChannelCount: counts.misc,
    TriggerChannelCount: counts.trigger,
  }

  const meta: MegRecordingMeta = {
    taskName: opts.taskName,
    manufacturer: 'CTF',
    powerLineFrequency: opts.powerLineFrequency ?? null,
    samplingFrequency: header.sfreq,
    recordingDuration: recordingDurationSeconds(header),
    recordingType: recordingType(header),
    vendorMeta,
    megChannelCount: counts.meg,
    megrefChannelCount: counts.megref,
    eegChannelCount: counts.eeg,
    eogChannelCount: counts.eog,
    ecgChannelCount: counts.ecg,
    emgChannelCount: counts.emg,
    miscChannelCount: counts.misc,
    triggerChannelCount: counts.trigger,
  }

  return {
    meta,
    channels,
    coordinates: opts.coordinates ?? null,
    // dataDate ("24-Nov-2008") + dataTime ("09:54") -> ISO 8601 left
    // for the orchestrator (date-format normalization belongs at the
    // _scans.tsv aggregation point alongside the M8 reproin
    // post-pass logic).
    acquisitionDateTime: null,
  }
}
