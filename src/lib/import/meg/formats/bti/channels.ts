// Map BTi channel names to BIDS-MEG channel types.
//
// Reference: mne/io/bti/bti.py line ~1245 (`_get_bti_info`). MNE
// classifies BTi channels by NAME PREFIX, not by the `ch_type` field
// in the config file's per-channel record -- the prefix is reliable
// (BTi names follow a strict convention) and lets us skip walking
// the variable-length per-channel payloads in the config file.
//
// Prefixes:
//   `A`        -> MEGMAG (primary magnetometer, e.g. A1..A248)
//   `M`        -> MEGREFMAG (reference magnetometer: MxA, MyA, MzA)
//   `G`        -> MEGREFGRADAXIAL (reference gradiometer; off-diagonal
//                  components GyxA / GzxA / GzyA also land here in v1
//                  since BIDS has no MEGREFGRADOFFDIAG bucket)
//   `EEG...`   -> EEG
//   `EOG...` / `HEOG` / `VEOG` -> EOG
//   `EMG...`   -> EMG
//   `ECG...`   -> ECG
//   `TRIGGER`  -> TRIG
//   `RESPONSE` -> TRIG (BIDS lumps stim/response under TRIG)
//   Anything else (`X`, `UACurrent`, `extPCh`, …) -> MISC

import type { MegChannelType } from '../../recording'

export function btiChannelType(name: string): MegChannelType {
  if (name === 'TRIGGER' || name === 'RESPONSE') return 'TRIG'
  // EOG family (must check before the generic `E...` EEG branch).
  if (name === 'HEOG' || name === 'VEOG' || name.startsWith('EOG')) return 'EOG'
  if (name.startsWith('ECG')) return 'ECG'
  if (name.startsWith('EMG')) return 'EMG'
  // EEG variant: prefix `EEG`, OR a single-letter 10-20-style label.
  if (name.startsWith('EEG') || isEegLike(name)) return 'EEG'
  // MEG family. Order matters: check `M` after `M`-prefixed non-MEG
  // tokens have been ruled out above.
  if (name.length > 0) {
    const c = name[0] ?? ''
    if (c === 'A') return 'MEGMAG'
    if (c === 'M') return 'MEGREFMAG'
    if (c === 'G') return 'MEGREFGRADAXIAL'
  }
  return 'MISC'
}

/** SI unit string for a given channel type. Matches the per-vendor
 *  defaults already emitted by `formats/ctf/channels.ts` and
 *  `formats/kit/channels.ts` -- the BIDS-MEG spec doesn't mandate a
 *  specific units string for trigger/misc channels so we mirror the
 *  CTF / KIT choice (`'V'` for non-magnetic, `'T'` for MEG mag,
 *  `'T/m'` for axial gradiometers). */
export function btiChannelUnits(type: MegChannelType): string {
  switch (type) {
    case 'MEGMAG':
    case 'MEGREFMAG':
      return 'T'
    case 'MEGGRADAXIAL':
    case 'MEGREFGRADAXIAL':
      return 'T/m'
    case 'MEGGRADPLANAR':
    case 'MEGREFGRADPLANAR':
      return 'T/m'
    case 'EEG':
    case 'EOG':
    case 'ECG':
    case 'EMG':
      return 'V'
    default:
      return 'V'
  }
}

/** Mirror of MNE's `_eeg_like()` (mne/io/bti/bti.py:1063). Some BTi
 *  recordings label EEG-like channels as `<ref>-<ref>` pairs (e.g.
 *  `"F4-POz"`); recognise EXACTLY that shape (one `-`, both halves
 *  10-20-like) so we don't accidentally classify MEG channel names
 *  (`A1`, `A148`) as EEG. */
function isEegLike(name: string): boolean {
  const parts = name.split('-')
  if (parts.length !== 2) return false
  return is1020Name(parts[0] ?? '') && is1020Name(parts[1] ?? '')
}

/** Subset of the 10-20 / 10-05 EEG channel naming convention. Real
 *  MNE consults its `standard_1005` montage; we hard-code the common
 *  positions that appear in BTi systems (Fp1/2, F3/4/7/8/z, …). The
 *  set is conservative; unknown names land in MISC, which is the
 *  safe fallback for sidecar emission. */
function is1020Name(s: string): boolean {
  return STANDARD_1020.has(s.toLowerCase())
}

const STANDARD_1020 = new Set<string>([
  'fp1',
  'fp2',
  'fpz',
  'f3',
  'f4',
  'f7',
  'f8',
  'fz',
  'c3',
  'c4',
  'cz',
  't3',
  't4',
  't5',
  't6',
  't7',
  't8',
  'p3',
  'p4',
  'pz',
  'p7',
  'p8',
  'p9',
  'p10',
  'o1',
  'o2',
  'oz',
  'iz',
  'nz',
  'po3',
  'po4',
  'poz',
  'po7',
  'po8',
  'po9',
  'po10',
  'fc1',
  'fc2',
  'fc3',
  'fc4',
  'fc5',
  'fc6',
  'fcz',
  'cp1',
  'cp2',
  'cp3',
  'cp4',
  'cp5',
  'cp6',
  'cpz',
  'tp7',
  'tp8',
  'ft7',
  'ft8',
  'af3',
  'af4',
  'afz',
  'af7',
  'af8',
  'm1',
  'm2',
])
