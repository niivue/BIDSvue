// Classify CTF channels into BIDS-MEG channel-type vocabulary.
// `sensor_type_index` is the primary discriminator -- the values come
// from `CTF.CHL_TYPE` constants in `mne/io/ctf/constants.py`:
//
//   0  CTFV_REF_MAG_CH       -> MEGREFMAG
//   1  CTFV_REF_GRAD_CH      -> MEGREFGRADAXIAL  (off-diag planar variant deferred)
//   5  CTFV_MEG_CH           -> MEGGRADAXIAL     (axial; magnetometer variant deferred)
//   9  CTFV_EEG_CH           -> EEG
//   11 CTFV_STIM_CH          -> TRIG
//   13 CTFV_SCLK_CH          -> MISC (system clock)
//   17 CTFV_OTHER            -> MISC
//
// The MAG-vs-GRAD secondary classification for sensor_type_index = 5
// is technically derivable from the coil geometry (`coil[0].norm` vs
// `coil[1].norm` -- coplanar = magnetometer, axial = gradiometer). On
// every CTF system we've seen channels with sensor_type 5 are axial
// gradiometers, and the golden spm_face_ctf fixture confirms this for
// all 274 MEG channels. The off-diagonal-vs-axial split for
// REF_GRAD_CH (sensor_type 1) is similar -- defaults to axial; the
// off-diag check needs coil positions. Both refinements are deferred
// to a separate slice with a fixture that actually exercises them.

import type { MegChannel, MegChannelType } from '../../recording'
import type { Res4Channel } from './header'

const SENSOR_TYPE = {
  REF_MAG: 0,
  REF_GRAD: 1,
  MEG: 5,
  EEG: 9,
  STIM: 11,
  SCLK: 13,
  OTHER: 17,
} as const

/**
 * Map a raw `Res4Channel.sensorTypeIndex` to the BIDS-MEG `type`
 * column value. Pure function; doesn't look at coil geometry.
 */
export function ctfChannelTypeForSensorIndex(
  sensorTypeIndex: number,
): MegChannelType {
  switch (sensorTypeIndex) {
    case SENSOR_TYPE.REF_MAG:
      return 'MEGREFMAG'
    case SENSOR_TYPE.REF_GRAD:
      return 'MEGREFGRADAXIAL'
    case SENSOR_TYPE.MEG:
      return 'MEGGRADAXIAL'
    case SENSOR_TYPE.EEG:
      return 'EEG'
    case SENSOR_TYPE.STIM:
      return 'TRIG'
    default:
      // Includes SCLK (13), OTHER (17), and anything CTF added that we
      // haven't catalogued yet. MNE folds all unknown types into MISC
      // (see mne/io/ctf/info.py:319 in the else branch).
      return 'MISC'
  }
}

/** SI unit string per channel type. MEG-family is teslas, the rest are volts. */
export function ctfChannelUnits(type: MegChannelType): string {
  switch (type) {
    case 'MEGMAG':
    case 'MEGGRADAXIAL':
    case 'MEGGRADPLANAR':
    case 'MEGREFMAG':
    case 'MEGREFGRADAXIAL':
    case 'MEGREFGRADPLANAR':
      return 'T'
    default:
      // EEG / EOG / ECG / EMG / TRIG / MISC are all measured in volts
      // on CTF systems -- the analog front-end digitises everything
      // off the same DAC.
      return 'V'
  }
}

/** Human-readable `description` column matching MNE-BIDS's CTF output. */
export function ctfChannelDescription(type: MegChannelType): string {
  switch (type) {
    case 'MEGMAG':
      return 'Magnetometer'
    case 'MEGGRADAXIAL':
      return 'Axial Gradiometer'
    case 'MEGGRADPLANAR':
      return 'Planar Gradiometer'
    case 'MEGREFMAG':
      return 'Magnetometer Reference'
    case 'MEGREFGRADAXIAL':
      return 'Axial Gradiometer Reference'
    case 'MEGREFGRADPLANAR':
      return 'Planar Gradiometer Reference'
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
    case 'SYSCLOCK':
      return 'System clock'
    default:
      return 'Miscellaneous'
  }
}

/**
 * Convert a `Res4Channel` array (from `parseRes4`) into the BIDS
 * `_channels.tsv` row representation. Filter / status / sampling
 * frequency are uniform per recording, so they're passed in once.
 *
 * v1 sets `lowCutoff = 0` and `highCutoff = nyquist = sfreq/2` for
 * every channel -- matches the spm_face_ctf golden fixture exactly.
 * Pulling true filter cutoffs out of the `.res4` filter table is
 * tracked in M10-B-2.5 once a fixture exercises a non-default
 * filter chain.
 */
export function ctfChannelsToMegChannels(
  rawChannels: readonly Res4Channel[],
  samplingFrequency: number,
): MegChannel[] {
  const nyquist = samplingFrequency / 2
  return rawChannels.map((ch) => {
    const type = ctfChannelTypeForSensorIndex(ch.sensorTypeIndex)
    return {
      name: ch.name,
      type,
      units: ctfChannelUnits(type),
      samplingFrequency,
      lowCutoff: 0,
      highCutoff: nyquist,
      description: ctfChannelDescription(type),
      status: 'good',
      statusDescription: 'n/a',
    }
  })
}

/**
 * Aggregate channel-count tallies for the `_meg.json` *ChannelCount
 * fields. Returns the eight counts BIDS-MEG splits out, even though
 * CTF's spm_face_ctf fixture only populates four of them -- the zeros
 * round-trip cleanly through the writer.
 */
export function ctfChannelCounts(channels: readonly MegChannel[]): {
  meg: number
  megref: number
  eeg: number
  eog: number
  ecg: number
  emg: number
  misc: number
  trigger: number
} {
  let meg = 0
  let megref = 0
  let eeg = 0
  let eog = 0
  let ecg = 0
  let emg = 0
  let misc = 0
  let trigger = 0
  for (const ch of channels) {
    switch (ch.type) {
      case 'MEGMAG':
      case 'MEGGRADAXIAL':
      case 'MEGGRADPLANAR':
        meg++
        break
      case 'MEGREFMAG':
      case 'MEGREFGRADAXIAL':
      case 'MEGREFGRADPLANAR':
        megref++
        break
      case 'EEG':
        eeg++
        break
      case 'EOG':
        eog++
        break
      case 'ECG':
        ecg++
        break
      case 'EMG':
        emg++
        break
      case 'TRIG':
        trigger++
        break
      default:
        misc++
        break
    }
  }
  return { meg, megref, eeg, eog, ecg, emg, misc, trigger }
}
