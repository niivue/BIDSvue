import { describe, expect, test } from 'bun:test'
import {
  kitChannelCounts,
  kitChannelDescription,
  kitChannelType,
  kitChannelUnits,
  kitChannelsToMegChannels,
} from './channels'
import { KIT_CH } from './header'

describe('kitChannelType', () => {
  test('maps KIT channel-type codes to BIDS channel types', () => {
    expect(kitChannelType(KIT_CH.MAGNETOMETER)).toBe('MEGMAG')
    expect(kitChannelType(KIT_CH.AXIAL_GRADIOMETER)).toBe('MEGGRADAXIAL')
    expect(kitChannelType(KIT_CH.PLANAR_GRADIOMETER)).toBe('MEGGRADPLANAR')
    expect(kitChannelType(KIT_CH.AXIAL_GRADIOMETER_2ND)).toBe('MEGGRADAXIAL')
    expect(kitChannelType(KIT_CH.MAGNETOMETER_REFERENCE)).toBe('MEGREFMAG')
    expect(kitChannelType(KIT_CH.AXIAL_GRADIOMETER_REFERENCE)).toBe(
      'MEGREFGRADAXIAL',
    )
    expect(kitChannelType(KIT_CH.PLANAR_GRADIOMETER_REFERENCE)).toBe(
      'MEGREFGRADPLANAR',
    )
    expect(kitChannelType(KIT_CH.TRIGGER)).toBe('TRIG')
    expect(kitChannelType(KIT_CH.EEG)).toBe('EEG')
    expect(kitChannelType(KIT_CH.ECG)).toBe('ECG')
  })

  test('ETC / NULL / unknown types fall through to MISC', () => {
    expect(kitChannelType(KIT_CH.ETC)).toBe('MISC')
    expect(kitChannelType(KIT_CH.NULL)).toBe('MISC')
    expect(kitChannelType(99)).toBe('MISC')
  })
})

describe('kitChannelUnits', () => {
  test('MEG family -> T; everything else -> V', () => {
    expect(kitChannelUnits('MEGMAG')).toBe('T')
    expect(kitChannelUnits('MEGGRADAXIAL')).toBe('T')
    expect(kitChannelUnits('MEGREFMAG')).toBe('T')
    expect(kitChannelUnits('TRIG')).toBe('V')
    expect(kitChannelUnits('MISC')).toBe('V')
  })
})

describe('kitChannelsToMegChannels', () => {
  test("synthesises a fallback name when KIT didn't record one", () => {
    const out = kitChannelsToMegChannels(
      [
        { type: KIT_CH.AXIAL_GRADIOMETER, name: '' },
        { type: KIT_CH.AXIAL_GRADIOMETER, name: 'AG002' },
        { type: KIT_CH.TRIGGER, name: '' },
      ],
      1000,
    )
    expect(out.map((c) => c.name)).toEqual(['MEG1', 'AG002', 'KIT3'])
    expect(out[0].type).toBe('MEGGRADAXIAL')
    expect(out[0].lowCutoff).toBe(0)
    expect(out[0].highCutoff).toBe(500)
  })
})

describe('kitChannelCounts', () => {
  test('tallies MEG / MEGREF / EEG / TRIG / MISC separately', () => {
    const channels = kitChannelsToMegChannels(
      [
        { type: KIT_CH.AXIAL_GRADIOMETER, name: 'AG1' },
        { type: KIT_CH.AXIAL_GRADIOMETER, name: 'AG2' },
        { type: KIT_CH.MAGNETOMETER_REFERENCE, name: '' },
        { type: KIT_CH.AXIAL_GRADIOMETER_REFERENCE, name: '' },
        { type: KIT_CH.TRIGGER, name: 'TRIG' },
        { type: KIT_CH.EEG, name: 'EEG1' },
        { type: KIT_CH.ETC, name: 'ETC1' },
      ],
      1000,
    )
    const counts = kitChannelCounts(channels)
    expect(counts.meg).toBe(2)
    expect(counts.megref).toBe(2)
    expect(counts.trigger).toBe(1)
    expect(counts.eeg).toBe(1)
    expect(counts.misc).toBe(1)
  })
})

describe('kitChannelDescription', () => {
  test('returns BIDS-style descriptions for KIT-family types', () => {
    expect(kitChannelDescription('MEGMAG')).toBe('Magnetometer')
    expect(kitChannelDescription('MEGGRADAXIAL')).toBe('Axial Gradiometer')
    expect(kitChannelDescription('MEGGRADPLANAR')).toBe('Planar Gradiometer')
    expect(kitChannelDescription('MEGREFGRADAXIAL')).toBe(
      'Axial Gradiometer Reference',
    )
    expect(kitChannelDescription('TRIG')).toBe('Trigger')
    expect(kitChannelDescription('MISC')).toBe('Miscellaneous')
  })
})
