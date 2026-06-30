// Build a vendor-agnostic `MegRecording` from a parsed BTi
// (config + PDF + optional hs_file) source. The orchestrator
// (`runMegImport.ts`) hands the result to the shared sidecar
// writers in `writers/sidecars.ts`; only the per-vendor parsing
// step is BTi-specific.

import type {
  MegChannel,
  MegCoordinates,
  MegRecording,
  Point3,
} from '../../recording'
import { btiChannelType, btiChannelUnits } from './channels'
import type { BtiConfigHeader, BtiHeadShape, BtiPdfHeader } from './header'

export interface BtiRecordingOptions {
  /** From the wizard; becomes `_meg.json.TaskName`. */
  taskName: string
  /** Override; falls back to the config's `supplyFreq` when undefined. */
  powerLineFrequency?: number | null
  /** From the wizard; becomes `_meg.json.DewarPosition`. */
  dewarPosition?: string | null
  /** From the wizard; if true and hs_file landmarks are present, emit
   *  the `_coordsystem.json` siblng + `DigitizedLandmarks: true`. */
  digitizedLandmarks?: boolean
  /** From the wizard; toggles `_meg.json.DigitizedHeadPoints`. */
  digitizedHeadPoints?: boolean
  /** Parsed hs_file landmarks (in meters, BTi/4D head frame). */
  headShape: BtiHeadShape | null
}

/**
 * Combine a BTi config header + PDF header + optional head-shape
 * into a `MegRecording`. The PDF gives us per-recording values
 * (sfreq, nchan, channel names, timestamp); the config gives us
 * stable system metadata (PowerLineFrequency, site name).
 */
export function btiRecordingFromHeaders(
  cfg: BtiConfigHeader,
  pdf: BtiPdfHeader,
  opts: BtiRecordingOptions,
): MegRecording {
  const channels: MegChannel[] = pdf.channelNames.map((name) => {
    const type = btiChannelType(name)
    return {
      name,
      type,
      units: btiChannelUnits(type),
      samplingFrequency: pdf.samplingFrequency,
      lowCutoff: 0.0,
      highCutoff: pdf.samplingFrequency / 2,
      description: describeBtiChannel(type),
      status: 'good',
      statusDescription: 'n/a',
    }
  })

  // Tallies for the channel-count fields on `MegRecordingMeta`.
  let megChannelCount = 0
  let megrefChannelCount = 0
  let eegChannelCount = 0
  let eogChannelCount = 0
  let ecgChannelCount = 0
  let emgChannelCount = 0
  let triggerChannelCount = 0
  let miscChannelCount = 0
  for (const ch of channels) {
    switch (ch.type) {
      case 'MEGMAG':
      case 'MEGGRADAXIAL':
      case 'MEGGRADPLANAR':
        megChannelCount++
        break
      case 'MEGREFMAG':
      case 'MEGREFGRADAXIAL':
      case 'MEGREFGRADPLANAR':
        megrefChannelCount++
        break
      case 'EEG':
        eegChannelCount++
        break
      case 'EOG':
        eogChannelCount++
        break
      case 'ECG':
        ecgChannelCount++
        break
      case 'EMG':
        emgChannelCount++
        break
      case 'TRIG':
        triggerChannelCount++
        break
      default:
        miscChannelCount++
        break
    }
  }

  // RecordingDuration: total samples / sfreq. PDF gives total_slices
  // already (sum of pts_in_epoch across epochs); divide by sfreq.
  const recordingDuration =
    pdf.samplingFrequency > 0 ? pdf.totalSlices / pdf.samplingFrequency : 0

  // Acquisition timestamp: PDF stores i32 UNIX seconds. Convert to
  // ISO 8601. `null` if the source didn't record one.
  const acquisitionDateTime =
    pdf.acqTimestampSec !== null
      ? new Date(pdf.acqTimestampSec * 1000).toISOString()
      : null

  // PowerLineFrequency precedence: wizard override > config
  // `supplyFreq` (when set and plausible) > null. The wizard's
  // `0` value (the "leave at n/a" default) is treated as undefined.
  let powerLineFrequency: number | null = null
  if (
    opts.powerLineFrequency !== undefined &&
    opts.powerLineFrequency !== null &&
    opts.powerLineFrequency > 0
  ) {
    powerLineFrequency = opts.powerLineFrequency
  } else if (cfg.supplyFreq === 50 || cfg.supplyFreq === 60) {
    powerLineFrequency = cfg.supplyFreq
  }

  // Derive RecordingType from the PDF's epoch count. MNE's BTi
  // reader does the same: a single-epoch recording is `continuous`,
  // multi-epoch is `epoched` (round-10 audit M4). Real BTi files
  // come both ways depending on acquisition mode.
  const recordingType: 'continuous' | 'epoched' =
    pdf.totalEpochs > 1 ? 'epoched' : 'continuous'

  // Vendor-specific extras for `_meg.json`. Insertion order matters
  // -- the writer preserves it. We mirror the field set the CTF /
  // FIF / KIT recordings emit so the sidecar layout stays
  // consistent across vendors.
  const vendorMeta: Record<string, unknown> = {}
  vendorMeta.RecordingType = recordingType
  vendorMeta.DewarPosition = opts.dewarPosition ?? 'n/a'
  if (cfg.siteName.length > 0) {
    vendorMeta.InstitutionName = cfg.siteName
  }
  vendorMeta.SoftwareFilters = 'n/a'
  vendorMeta.DigitizedLandmarks = computeDigitizedLandmarks(opts)
  vendorMeta.DigitizedHeadPoints =
    opts.digitizedHeadPoints !== undefined ? opts.digitizedHeadPoints : false

  const coordinates = buildCoordinates(opts)

  return {
    meta: {
      taskName: opts.taskName,
      manufacturer: '4D/BTi',
      powerLineFrequency,
      samplingFrequency: pdf.samplingFrequency,
      recordingDuration,
      recordingType,
      vendorMeta,
      megChannelCount,
      megrefChannelCount,
      eegChannelCount,
      eogChannelCount,
      ecgChannelCount,
      emgChannelCount,
      miscChannelCount,
      triggerChannelCount,
    },
    channels,
    coordinates,
    acquisitionDateTime,
  }
}

function describeBtiChannel(type: string): string {
  switch (type) {
    case 'MEGMAG':
      return 'Magnetometer'
    case 'MEGREFMAG':
      return 'Reference magnetometer'
    case 'MEGREFGRADAXIAL':
      return 'Reference axial gradiometer'
    case 'EEG':
      return 'EEG'
    case 'EOG':
      return 'EOG'
    case 'ECG':
      return 'ECG'
    case 'EMG':
      return 'EMG'
    case 'TRIG':
      return 'Trigger'
    default:
      return 'Misc'
  }
}

function computeDigitizedLandmarks(opts: BtiRecordingOptions): boolean {
  if (opts.digitizedLandmarks !== undefined) return opts.digitizedLandmarks
  return opts.headShape !== null
}

function buildCoordinates(opts: BtiRecordingOptions): MegCoordinates | null {
  if (opts.headShape === null) return null
  // Only emit `_coordsystem.json` when the user has explicitly
  // confirmed landmarks were digitised, OR when the hs_file itself
  // carries non-degenerate values (the parseBtiHeadShape `null`
  // bound already guards against the latter, so the `false`
  // wizard override is the active gate here).
  if (opts.digitizedLandmarks === false) return null
  const landmarks: Record<string, Point3> = {
    NAS: opts.headShape.nas,
    LPA: opts.headShape.lpa,
    RPA: opts.headShape.rpa,
  }
  return {
    system: 'Other',
    systemDescription:
      '4D / BTi head coordinate frame -- x toward Nasion, y toward LPA, z superior; units in meters',
    units: 'm',
    headCoils: landmarks,
    anatomicalLandmarks: landmarks,
  }
}
