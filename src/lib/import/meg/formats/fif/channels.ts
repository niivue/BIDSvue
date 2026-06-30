// Classify FIF channels into the BIDS-MEG channel-type vocabulary.
// Discriminants:
//
//   1. `FifChannel.kind` (FIFFV_*_CH):
//      - MEG     (1)   -> further split by coil type (mag vs grad)
//      - EEG     (2)   -> EEG
//      - STIM    (3)   -> TRIG
//      - EOG     (202) -> EOG
//      - REF_MEG (301) -> MEGREFMAG (off-diag REF_GRAD detection deferred)
//      - EMG     (302) -> EMG
//      - ECG     (402) -> ECG
//      - MISC    (502) and everything else -> MISC
//
//   2. For kind=MEG, `coil_type`:
//      - 3011-3015 (FIFFV_COIL_VV_PLANAR_*)  -> MEGGRADPLANAR
//      - 3021-3025 (FIFFV_COIL_VV_MAG_*)     -> MEGMAG
//      - 2000      (point magnetometer)      -> MEGMAG
//      - 7002      (babymag)                 -> MEGMAG
//      - anything else                       -> MEGMAG (default)
//
// Output units come from `FifChannel.unit` (FIFF_UNIT_T = 107 ->
// "T"; FIFF_UNIT_V = 112 -> "V"). For our purposes the MEG family
// always reports teslas, EEG/MISC/etc. report volts; the explicit
// unit field is a tiebreak when a channel has been re-tagged.

import type { MegChannel, MegChannelType } from '../../recording'
import { FIFF_KIND, type FifChannel } from './header'

/** FIFF_UNIT_T = 107, FIFF_UNIT_V = 112. */
const FIFF_UNIT_T = 107
const FIFF_UNIT_V = 112

/** Coil-type bands for the Vectorview / Triux planar gradiometers. */
function isVvPlanar(coilType: number): boolean {
  return coilType >= 3011 && coilType <= 3019
}

/** Coil-type bands for the Vectorview / Triux magnetometers. */
function isVvMag(coilType: number): boolean {
  return coilType >= 3020 && coilType <= 3029
}

/** Map an FIF channel kind + coil type to a BIDS-MEG channel type. */
export function fifChannelType(kind: number, coilType: number): MegChannelType {
  switch (kind) {
    case FIFF_KIND.MEG:
      if (isVvPlanar(coilType)) return 'MEGGRADPLANAR'
      // Magnetometers and unknown coils (e.g. simulated point
      // magnetometers, BabyMEG) fall back to MEGMAG. The fully-
      // generic CTF-style axial gradiometer (FIFFV_COIL_CTF_GRAD =
      // 5004) is intentionally caught here too -- if a CTF dataset
      // arrives via FIF we tag it MEGMAG until a future revision
      // adds vendor-aware coil mapping.
      if (isVvMag(coilType)) return 'MEGMAG'
      return 'MEGMAG'
    case FIFF_KIND.REF_MEG:
      // REF_MEG covers CTF / BTi reference channels stored in FIF.
      // Discriminating between MEGREFMAG / MEGREFGRADAXIAL /
      // MEGREFGRADPLANAR needs coil geometry; default to MEGREFMAG.
      return 'MEGREFMAG'
    case FIFF_KIND.EEG:
      return 'EEG'
    case FIFF_KIND.STIM:
      return 'TRIG'
    case FIFF_KIND.EOG:
      return 'EOG'
    case FIFF_KIND.EMG:
      return 'EMG'
    case FIFF_KIND.ECG:
      return 'ECG'
    default:
      // MCG and MISC and any future kinds fall through to BIDS MISC.
      return 'MISC'
  }
}

/** Units from the FIF `unit` field. Falls back to a per-type default. */
export function fifChannelUnits(ch: FifChannel, type: MegChannelType): string {
  if (ch.unit === FIFF_UNIT_T) return 'T'
  if (ch.unit === FIFF_UNIT_V) return 'V'
  // Some files leave `unit` zero for STIM / MISC channels; pick the
  // BIDS-canonical unit for the type instead of writing "n/a".
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

/** Human-readable channel-description column (matches the CTF table for
 *  the types they share). */
export function fifChannelDescription(type: MegChannelType): string {
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
 * Convert the FIF channel list to the vendor-agnostic `MegChannel`
 * representation the writer consumes. Filter cutoffs default to
 * `low_cutoff = 0` and `high_cutoff = nyquist`; FIF does store
 * filter info elsewhere (in `proc_history`), but pulling it out
 * needs a richer parser than what M10-C ships -- deferred.
 */
export function fifChannelsToMegChannels(
  fifChannels: readonly FifChannel[],
  samplingFrequency: number,
): MegChannel[] {
  const nyquist = samplingFrequency / 2
  return fifChannels.map((ch) => {
    const type = fifChannelType(ch.kind, ch.coilType)
    return {
      name: ch.name,
      type,
      units: fifChannelUnits(ch, type),
      samplingFrequency,
      lowCutoff: 0,
      highCutoff: nyquist,
      description: fifChannelDescription(type),
      status: 'good',
      statusDescription: 'n/a',
    }
  })
}

/** Channel-count tallies for the `_meg.json` *ChannelCount fields. */
export function fifChannelCounts(channels: readonly MegChannel[]): {
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
