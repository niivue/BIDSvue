import { describe, expect, test } from 'bun:test'
import {
  fifChannelCounts,
  fifChannelDescription,
  fifChannelType,
  fifChannelUnits,
  fifChannelsToMegChannels,
} from './channels'
import { FIFF_KIND, type FifChannel } from './header'

function fakeFifCh(
  kind: number,
  coilType: number,
  unit = 0,
  name = 'CHX',
): FifChannel {
  return {
    scanno: 1,
    logno: 1,
    kind,
    range: 1,
    cal: 1,
    coilType,
    loc: new Array(12).fill(0),
    unit,
    unitMul: 0,
    name,
  }
}

describe('fifChannelType', () => {
  test('VV planar gradiometer coil types -> MEGGRADPLANAR', () => {
    for (const coil of [3011, 3012, 3013, 3014, 3015]) {
      expect(fifChannelType(FIFF_KIND.MEG, coil)).toBe('MEGGRADPLANAR')
    }
  })

  test('VV magnetometer coil types -> MEGMAG', () => {
    for (const coil of [3021, 3022, 3023, 3024, 3025]) {
      expect(fifChannelType(FIFF_KIND.MEG, coil)).toBe('MEGMAG')
    }
  })

  test('unknown coil type with MEG kind defaults to MEGMAG', () => {
    // Point magnetometer (2000), BabyMEG (7002), CTF-shaped FIF imports.
    expect(fifChannelType(FIFF_KIND.MEG, 2000)).toBe('MEGMAG')
    expect(fifChannelType(FIFF_KIND.MEG, 7002)).toBe('MEGMAG')
    expect(fifChannelType(FIFF_KIND.MEG, 5004)).toBe('MEGMAG')
  })

  test('REF_MEG -> MEGREFMAG (off-diag detection deferred)', () => {
    expect(fifChannelType(FIFF_KIND.REF_MEG, 0)).toBe('MEGREFMAG')
  })

  test('EEG / STIM / EOG / EMG / ECG / MISC map to their BIDS counterparts', () => {
    expect(fifChannelType(FIFF_KIND.EEG, 0)).toBe('EEG')
    expect(fifChannelType(FIFF_KIND.STIM, 0)).toBe('TRIG')
    expect(fifChannelType(FIFF_KIND.EOG, 0)).toBe('EOG')
    expect(fifChannelType(FIFF_KIND.EMG, 0)).toBe('EMG')
    expect(fifChannelType(FIFF_KIND.ECG, 0)).toBe('ECG')
    expect(fifChannelType(FIFF_KIND.MISC, 0)).toBe('MISC')
  })

  test('MCG and unknown kinds fall through to MISC', () => {
    expect(fifChannelType(FIFF_KIND.MCG, 0)).toBe('MISC')
    expect(fifChannelType(9999, 0)).toBe('MISC')
  })
})

describe('fifChannelUnits', () => {
  test('FIFF_UNIT_T -> "T"', () => {
    expect(fifChannelUnits(fakeFifCh(1, 3022, 107), 'MEGMAG')).toBe('T')
  })
  test('FIFF_UNIT_V -> "V"', () => {
    expect(fifChannelUnits(fakeFifCh(3, 0, 112), 'TRIG')).toBe('V')
  })
  test('falls back to per-type default when FIFF unit is 0', () => {
    // STIM channels sometimes have unit=0; the BIDS canonical unit
    // for trigger channels is volts.
    expect(fifChannelUnits(fakeFifCh(3, 0, 0), 'TRIG')).toBe('V')
    expect(fifChannelUnits(fakeFifCh(1, 3022, 0), 'MEGMAG')).toBe('T')
  })
})

describe('fifChannelsToMegChannels', () => {
  test('produces nyquist high_cutoff and zero low_cutoff per channel', () => {
    const out = fifChannelsToMegChannels(
      [fakeFifCh(FIFF_KIND.MEG, 3022, 107, 'MEG001')],
      1000,
    )
    expect(out[0].samplingFrequency).toBe(1000)
    expect(out[0].lowCutoff).toBe(0)
    expect(out[0].highCutoff).toBe(500)
    expect(out[0].status).toBe('good')
  })

  test('threads channel name + classification straight through', () => {
    const out = fifChannelsToMegChannels(
      [
        fakeFifCh(FIFF_KIND.MEG, 3012, 107, 'MEG0112'),
        fakeFifCh(FIFF_KIND.MEG, 3022, 107, 'MEG0111'),
        fakeFifCh(FIFF_KIND.STIM, 0, 112, 'STI 001'),
      ],
      1000,
    )
    expect(out.map((c) => c.name)).toEqual(['MEG0112', 'MEG0111', 'STI 001'])
    expect(out.map((c) => c.type)).toEqual(['MEGGRADPLANAR', 'MEGMAG', 'TRIG'])
    expect(out.map((c) => c.description)).toEqual([
      'Planar Gradiometer',
      'Magnetometer',
      'Trigger',
    ])
  })
})

describe('fifChannelCounts', () => {
  test('Neuromag-shaped breakdown (102 mag + 204 planar grad + 1 stim)', () => {
    const channels = fifChannelsToMegChannels(
      [
        ...Array.from({ length: 102 }, (_, i) =>
          fakeFifCh(FIFF_KIND.MEG, 3022, 107, `MAG${i}`),
        ),
        ...Array.from({ length: 204 }, (_, i) =>
          fakeFifCh(FIFF_KIND.MEG, 3012, 107, `GRD${i}`),
        ),
        fakeFifCh(FIFF_KIND.STIM, 0, 112, 'STI 001'),
      ],
      1000,
    )
    const counts = fifChannelCounts(channels)
    expect(counts.meg).toBe(102 + 204)
    expect(counts.trigger).toBe(1)
    expect(counts.megref + counts.eeg + counts.eog + counts.misc).toBe(0)
  })
})

describe('fifChannelDescription', () => {
  test('returns BIDS-style descriptions for every type we emit', () => {
    expect(fifChannelDescription('MEGMAG')).toBe('Magnetometer')
    expect(fifChannelDescription('MEGGRADPLANAR')).toBe('Planar Gradiometer')
    expect(fifChannelDescription('MEGREFMAG')).toBe('Magnetometer Reference')
    expect(fifChannelDescription('TRIG')).toBe('Trigger')
    expect(fifChannelDescription('MISC')).toBe('Miscellaneous')
  })
})
