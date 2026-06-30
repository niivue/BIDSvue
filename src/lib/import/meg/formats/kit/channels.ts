// Map KIT channel types to BIDS-MEG channel-type vocabulary.
//
// Source-of-truth: `KIT.CH_TO_FIFF_KIND` + `KIT.CH_TO_FIFF_COIL` in
// `mne/io/kit/constants.py`. KIT distinguishes:
//
//   1     MAGNETOMETER                          -> MEGMAG
//   2     AXIAL_GRADIOMETER                     -> MEGGRADAXIAL
//   3     PLANAR_GRADIOMETER                    -> MEGGRADPLANAR
//   4     2ND_ORDER_AXIAL_GRADIOMETER           -> MEGGRADAXIAL (no 2nd-order BIDS bucket)
//   0x101 MAGNETOMETER_REFERENCE                -> MEGREFMAG
//   0x102 AXIAL_GRADIOMETER_REFERENCE           -> MEGREFGRADAXIAL
//   0x103 PLANAR_GRADIOMETER_REFERENCE          -> MEGREFGRADPLANAR
//   0x104 2ND_ORDER_AXIAL_GRADIOMETER_REFERENCE -> MEGREFGRADAXIAL
//   -1    TRIGGER                               -> TRIG
//   -2    EEG                                   -> EEG
//   -3    ECG                                   -> ECG
//   -4    ETC                                   -> MISC
//   0     NULL                                  -> MISC (placeholder slot)

import type { MegChannel, MegChannelType } from '../../recording'
import { KIT_CH, type KitChannel } from './header'

export function kitChannelType(type: number): MegChannelType {
  switch (type) {
    case KIT_CH.MAGNETOMETER:
      return 'MEGMAG'
    case KIT_CH.AXIAL_GRADIOMETER:
    case KIT_CH.AXIAL_GRADIOMETER_2ND:
      return 'MEGGRADAXIAL'
    case KIT_CH.PLANAR_GRADIOMETER:
      return 'MEGGRADPLANAR'
    case KIT_CH.MAGNETOMETER_REFERENCE:
      return 'MEGREFMAG'
    case KIT_CH.AXIAL_GRADIOMETER_REFERENCE:
    case KIT_CH.AXIAL_GRADIOMETER_2ND_REFERENCE:
      return 'MEGREFGRADAXIAL'
    case KIT_CH.PLANAR_GRADIOMETER_REFERENCE:
      return 'MEGREFGRADPLANAR'
    case KIT_CH.TRIGGER:
      return 'TRIG'
    case KIT_CH.EEG:
      return 'EEG'
    case KIT_CH.ECG:
      return 'ECG'
    default:
      // ETC, NULL, and anything KIT might add later land here.
      return 'MISC'
  }
}

export function kitChannelUnits(type: MegChannelType): string {
  switch (type) {
    case 'MEGMAG':
    case 'MEGGRADAXIAL':
    case 'MEGGRADPLANAR':
    case 'MEGREFMAG':
    case 'MEGREFGRADAXIAL':
    case 'MEGREFGRADPLANAR':
      return 'T'
    default:
      return 'V'
  }
}

export function kitChannelDescription(type: MegChannelType): string {
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
    case 'ECG':
      return 'ECG'
    case 'TRIG':
      return 'Trigger'
    default:
      return 'Miscellaneous'
  }
}

/**
 * Convert `KitChannel[]` to the vendor-agnostic `MegChannel[]` the
 * writer consumes. Per-channel cutoffs default to 0 / nyquist; KIT's
 * `.con` does store filter info elsewhere (FLL settings in the
 * AMP_FILTER block), but pulling them out + mapping to standard
 * Hz values needs the FLL lookup table from MNE -- deferred.
 */
export function kitChannelsToMegChannels(
  kitChannels: readonly KitChannel[],
  samplingFrequency: number,
): MegChannel[] {
  const nyquist = samplingFrequency / 2
  return kitChannels.map((ch, i) => {
    const type = kitChannelType(ch.type)
    const fallback = type.startsWith('MEG') ? `MEG${i + 1}` : `KIT${i + 1}`
    return {
      name: ch.name !== '' ? ch.name : fallback,
      type,
      units: kitChannelUnits(type),
      samplingFrequency,
      lowCutoff: 0,
      highCutoff: nyquist,
      description: kitChannelDescription(type),
      status: 'good',
      statusDescription: 'n/a',
    }
  })
}

export function kitChannelCounts(channels: readonly MegChannel[]): {
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
