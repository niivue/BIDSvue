// Build a vendor-agnostic `MegRecording` from a parsed FIFF header.
// Mirrors the role of `formats/ctf/ctfRecording.ts`; the BIDS sidecar
// writers stay format-agnostic.
//
// `_meg.json.Manufacturer` is hardcoded to `"Elekta"` for the M10-C
// slice (the most common FIF source). FIF files produced by KIT /
// BTi conversion tools also exist; the orchestrator routes those
// through dedicated paths at M10-D / M10-E based on file detection,
// not by the manufacturer string we emit here. If a downstream user
// converts CTF data to FIF and imports it, they get `"Elekta"` here
// -- the right fix in that case is to use the CTF importer on the
// original .ds.

import type {
  MegCoordinates,
  MegRecording,
  MegRecordingMeta,
  Point3,
} from '../../recording'
import { floatVal } from '../../writers/sidecars'
import { fifChannelCounts, fifChannelsToMegChannels } from './channels'
import {
  FIFF_DIG,
  type FifDigPoint,
  type FifHeader,
  recordingDurationSeconds,
} from './header'

export interface FifRecordingOpts {
  /** `_meg.json.TaskName`. From the wizard. */
  taskName: string
  /** `_meg.json.PowerLineFrequency` override. `null` -> use the parsed FIFF_LINE_FREQ. */
  powerLineFrequency?: number | null
  /** Wizard hint for `_meg.json.DewarPosition`. `null` -> "n/a". */
  dewarPosition?: string | null
  /** Wizard hint for `_meg.json.DigitizedHeadPoints`. */
  digitizedHeadPoints?: boolean
}

/**
 * Build a `MegRecording` from a parsed FIFF header.
 *
 * Field order in `vendorMeta` mirrors the layout MNE-BIDS emits for
 * a Neuromag fixture. Once we have a Neuromag golden reference under
 * `tests/fixtures/meg-golden/fif-*` (M10-C close-out) we can pin this
 * down byte-for-byte; for now the order matches CTF's so the test
 * scaffolding stays shared.
 */
export function fifRecordingFromHeader(
  header: FifHeader,
  opts: FifRecordingOpts,
): MegRecording {
  const channels = fifChannelsToMegChannels(header.channels, header.sfreq)
  const counts = fifChannelCounts(channels)

  // `PowerLineFrequency`: wizard override wins; otherwise use FIFF_LINE_FREQ;
  // otherwise null (the writer emits "n/a").
  const powerLineFrequency =
    opts.powerLineFrequency !== undefined && opts.powerLineFrequency !== null
      ? opts.powerLineFrequency
      : (header.lineFreq ?? null)

  // Continuous-head-localization presence: we don't currently inspect
  // proc_history / dev_head_t for a HPI-tracking flag. Wizard could
  // override later; default false because most FIF research recordings
  // localise once at acquisition start, not continuously.
  const continuousHeadLocalization = false

  // Digitized landmarks: present iff the file has cardinal dig points
  // for NAS / LPA / RPA. ISOTRAK blocks are usual for Neuromag
  // recordings.
  const cardinalIdents = new Set(
    header.digPoints
      .filter((d) => d.kind === FIFF_DIG.CARDINAL)
      .map((d) => d.ident),
  )
  const digitizedLandmarks =
    cardinalIdents.has(FIFF_DIG.LPA) &&
    cardinalIdents.has(FIFF_DIG.NASION) &&
    cardinalIdents.has(FIFF_DIG.RPA)

  const digitizedHeadPoints =
    opts.digitizedHeadPoints ??
    header.digPoints.some((d) => d.kind === FIFF_DIG.EXTRA)

  const vendorMeta: Record<string, unknown> = {
    RecordingDuration: floatVal(recordingDurationSeconds(header)),
    RecordingType: 'continuous',
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
    manufacturer: 'Elekta',
    powerLineFrequency,
    samplingFrequency: header.sfreq,
    recordingDuration: recordingDurationSeconds(header),
    recordingType: 'continuous',
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
    coordinates: digitizedLandmarks ? buildCoordinates(header.digPoints) : null,
    acquisitionDateTime: header.measDate,
  }
}

/**
 * Build `MegCoordinates` from FIF cardinal landmarks. Values are in
 * the Neuromag head coordinate frame, units METERS. BIDS' `Neuromag`
 * coordinate-system token is x=right (toward RPA), y=anterior (toward
 * Nasion), z=superior. Head-coils are NOT the same as anatomical
 * landmarks in FIF (HPI coils have their own kind=HPI / ident=1..N),
 * but for v1 we mirror the cardinal-landmark coords into both
 * `HeadCoilCoordinates` and `AnatomicalLandmarkCoordinates` so the
 * writer's two-family layout has values for both.
 *
 * The HPI block could be wired in separately once a real fixture
 * exercises the distinction; for now the dual write keeps BIDS-MEG
 * validators happy without inventing values.
 */
function buildCoordinates(digPoints: readonly FifDigPoint[]): MegCoordinates {
  const byIdent = new Map<number, Point3>()
  for (const d of digPoints) {
    if (d.kind !== FIFF_DIG.CARDINAL) continue
    byIdent.set(d.ident, d.r)
  }
  const nas = byIdent.get(FIFF_DIG.NASION)
  const lpa = byIdent.get(FIFF_DIG.LPA)
  const rpa = byIdent.get(FIFF_DIG.RPA)
  if (nas === undefined || lpa === undefined || rpa === undefined) {
    throw new Error(
      'fifRecordingFromHeader: cardinal landmarks missing despite digitizedLandmarks=true',
    )
  }
  const landmarks: Record<string, Point3> = { NAS: nas, LPA: lpa, RPA: rpa }
  return {
    system: 'ElektaNeuromag',
    systemDescription:
      'Elekta / Neuromag head coordinate frame -- x toward RPA, y toward Nasion, z superior',
    units: 'm',
    headCoils: landmarks,
    anatomicalLandmarks: landmarks,
  }
}
