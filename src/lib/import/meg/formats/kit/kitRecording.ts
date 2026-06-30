// Build a vendor-agnostic `MegRecording` from a parsed KIT header.
// Mirrors the role of `formats/ctf/ctfRecording.ts` and `formats/fif/fifRecording.ts`.
//
// `Manufacturer` is set to `"KIT/Yokogawa"` -- the BIDS-MEG
// canonical vocabulary value (matches the spec's allowed list).
// KIT-built systems by Ricoh / Yokogawa / KIT itself all use this
// same file format and the same Manufacturer string.

import type {
  MegCoordinates,
  MegRecording,
  MegRecordingMeta,
  Point3,
} from '../../recording'
import { floatVal } from '../../writers/sidecars'
import { kitChannelCounts, kitChannelsToMegChannels } from './channels'
import {
  type KitDigPoint,
  type KitHeader,
  recordingDurationSeconds,
} from './header'

export interface KitRecordingOpts {
  /** `_meg.json.TaskName`. From the wizard. */
  taskName: string
  /** `_meg.json.PowerLineFrequency`. KIT doesn't store this; wizard supplies. */
  powerLineFrequency?: number | null
  /** Wizard hint for `_meg.json.DewarPosition`. `null` -> "n/a". */
  dewarPosition?: string | null
  /** Wizard hint for `_meg.json.DigitizedHeadPoints`. */
  digitizedHeadPoints?: boolean
}

/**
 * Build a `MegRecording` from a parsed KIT header.
 *
 * `_coordsystem.json` data comes from the in-file DIG_POINTS block.
 * The KIT format stores cardinal landmarks under fixed lowercase
 * names:
 *   - `fidnz`  -> Nasion
 *   - `fidt9`  -> LPA (left preauricular)
 *   - `fidt10` -> RPA (right preauricular)
 * If all three are present we emit `MegCoordinates` with
 * `system: "KIT/Yokogawa"`, units METERS. Some KIT recordings store
 * landmarks ONLY in a sibling `.elp` text file (not in the .con);
 * those flow through a future enhancement.
 */
export function kitRecordingFromHeader(
  header: KitHeader,
  opts: KitRecordingOpts,
): MegRecording {
  const channels = kitChannelsToMegChannels(header.channels, header.sfreq)
  const counts = kitChannelCounts(channels)

  const coordinates = buildCoordinates(header.digPoints)

  // Continuous head-localization: KIT records HPI coil positions at
  // acquisition start, not continuously. So this is always false in
  // v1; a future revision could read sibling .mrk files for
  // multi-measurement runs.
  const continuousHeadLocalization = false

  const digitizedLandmarks = coordinates !== null

  const digitizedHeadPoints =
    opts.digitizedHeadPoints ??
    header.digPoints.some((d) => d.name === '' || d.name.startsWith('hsp'))

  const vendorMeta: Record<string, unknown> = {
    RecordingDuration: floatVal(recordingDurationSeconds(header)),
    RecordingType: header.acqType,
    DewarPosition: opts.dewarPosition ?? 'n/a',
    DigitizedLandmarks: digitizedLandmarks,
    DigitizedHeadPoints: digitizedHeadPoints,
    MEGChannelCount: counts.meg,
    MEGREFChannelCount: counts.megref,
    ContinuousHeadLocalization: continuousHeadLocalization,
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
    manufacturer: 'KIT/Yokogawa',
    powerLineFrequency: opts.powerLineFrequency ?? null,
    samplingFrequency: header.sfreq,
    recordingDuration: recordingDurationSeconds(header),
    recordingType: header.acqType,
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
    coordinates,
    acquisitionDateTime: null,
  }
}

/**
 * Extract NAS / LPA / RPA from KIT dig points. Returns null when any
 * required landmark is missing -- the orchestrator falls through to
 * "no _coordsystem.json emitted" rather than a partial file.
 */
function buildCoordinates(
  digPoints: readonly KitDigPoint[],
): MegCoordinates | null {
  const byName = new Map<string, Point3>()
  for (const d of digPoints) byName.set(d.name, d.r)
  const nas = byName.get('fidnz')
  const lpa = byName.get('fidt9')
  const rpa = byName.get('fidt10')
  if (nas === undefined || lpa === undefined || rpa === undefined) return null
  const landmarks: Record<string, Point3> = { NAS: nas, LPA: lpa, RPA: rpa }
  return {
    system: 'KIT/Yokogawa',
    systemDescription:
      'KIT head coordinate frame -- x toward RPA, y toward Nasion, z superior',
    units: 'm',
    headCoils: landmarks,
    anatomicalLandmarks: landmarks,
  }
}
