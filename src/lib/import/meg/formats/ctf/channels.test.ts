import { describe, expect, test } from 'bun:test'
import {
  ctfChannelCounts,
  ctfChannelDescription,
  ctfChannelTypeForSensorIndex,
  ctfChannelUnits,
  ctfChannelsToMegChannels,
} from './channels'

describe('ctfChannelTypeForSensorIndex', () => {
  test('maps every CTF sensor type code to a BIDS-MEG channel type', () => {
    // Values from CTF.CHL_TYPE in mne/io/ctf/constants.py.
    expect(ctfChannelTypeForSensorIndex(0)).toBe('MEGREFMAG')
    expect(ctfChannelTypeForSensorIndex(1)).toBe('MEGREFGRADAXIAL')
    expect(ctfChannelTypeForSensorIndex(5)).toBe('MEGGRADAXIAL')
    expect(ctfChannelTypeForSensorIndex(9)).toBe('EEG')
    expect(ctfChannelTypeForSensorIndex(11)).toBe('TRIG')
  })

  test('unknown sensor types (incl. SCLK and OTHER) fall through to MISC', () => {
    expect(ctfChannelTypeForSensorIndex(13)).toBe('MISC') // SCLK
    expect(ctfChannelTypeForSensorIndex(17)).toBe('MISC') // OTHER
    expect(ctfChannelTypeForSensorIndex(42)).toBe('MISC') // hypothetical future
    expect(ctfChannelTypeForSensorIndex(-1)).toBe('MISC')
  })
})

describe('ctfChannelUnits', () => {
  test('MEG family channels use teslas, everything else uses volts', () => {
    expect(ctfChannelUnits('MEGMAG')).toBe('T')
    expect(ctfChannelUnits('MEGGRADAXIAL')).toBe('T')
    expect(ctfChannelUnits('MEGGRADPLANAR')).toBe('T')
    expect(ctfChannelUnits('MEGREFMAG')).toBe('T')
    expect(ctfChannelUnits('MEGREFGRADAXIAL')).toBe('T')
    expect(ctfChannelUnits('MEGREFGRADPLANAR')).toBe('T')
    expect(ctfChannelUnits('EEG')).toBe('V')
    expect(ctfChannelUnits('TRIG')).toBe('V')
    expect(ctfChannelUnits('MISC')).toBe('V')
  })
})

describe('ctfChannelDescription', () => {
  test('emits the human-readable description strings MNE-BIDS uses', () => {
    expect(ctfChannelDescription('MEGGRADAXIAL')).toBe('Axial Gradiometer')
    expect(ctfChannelDescription('MEGREFGRADAXIAL')).toBe(
      'Axial Gradiometer Reference',
    )
    expect(ctfChannelDescription('MEGREFMAG')).toBe('Magnetometer Reference')
    expect(ctfChannelDescription('TRIG')).toBe('Trigger')
    expect(ctfChannelDescription('MISC')).toBe('Miscellaneous')
  })
})

describe('ctfChannelsToMegChannels', () => {
  test('defaults lowCutoff=0 and highCutoff=nyquist for every channel', () => {
    const out = ctfChannelsToMegChannels(
      [
        { name: 'A', sensorTypeIndex: 5, coilType: 0, gradOrder: 0 },
        { name: 'B', sensorTypeIndex: 11, coilType: 0, gradOrder: 0 },
      ],
      1200,
    )
    expect(out).toHaveLength(2)
    for (const ch of out) {
      expect(ch.samplingFrequency).toBe(1200)
      expect(ch.lowCutoff).toBe(0)
      expect(ch.highCutoff).toBe(600) // nyquist
      expect(ch.status).toBe('good')
      expect(ch.statusDescription).toBe('n/a')
    }
  })

  test('preserves channel name + type ordering', () => {
    const out = ctfChannelsToMegChannels(
      [
        { name: 'MLC11', sensorTypeIndex: 5, coilType: 0, gradOrder: 3 },
        { name: 'BG1', sensorTypeIndex: 0, coilType: 0, gradOrder: 0 },
      ],
      480,
    )
    expect(out[0].name).toBe('MLC11')
    expect(out[0].type).toBe('MEGGRADAXIAL')
    expect(out[1].name).toBe('BG1')
    expect(out[1].type).toBe('MEGREFMAG')
  })
})

describe('ctfChannelCounts', () => {
  test('reproduces the spm_face_ctf breakdown (274 + 29 + 35 + 2 + 0)', () => {
    // Build a synthetic channel list with the same type distribution
    // as the spm_face_ctf golden.
    const meg = Array.from({ length: 274 }, () =>
      ctfChannelsToMegChannels(
        [{ name: 'M', sensorTypeIndex: 5, coilType: 0, gradOrder: 3 }],
        480,
      ),
    ).flat()
    const refMag = Array.from({ length: 9 }, () =>
      ctfChannelsToMegChannels(
        [{ name: 'R', sensorTypeIndex: 0, coilType: 0, gradOrder: 0 }],
        480,
      ),
    ).flat()
    const refGrad = Array.from({ length: 20 }, () =>
      ctfChannelsToMegChannels(
        [{ name: 'G', sensorTypeIndex: 1, coilType: 0, gradOrder: 0 }],
        480,
      ),
    ).flat()
    const misc = Array.from({ length: 35 }, () =>
      ctfChannelsToMegChannels(
        [{ name: 'X', sensorTypeIndex: 13, coilType: 0, gradOrder: 0 }],
        480,
      ),
    ).flat()
    const trig = Array.from({ length: 2 }, () =>
      ctfChannelsToMegChannels(
        [{ name: 'T', sensorTypeIndex: 11, coilType: 0, gradOrder: 0 }],
        480,
      ),
    ).flat()
    const all = [...meg, ...refMag, ...refGrad, ...misc, ...trig]
    const counts = ctfChannelCounts(all)
    expect(counts.meg).toBe(274)
    expect(counts.megref).toBe(29) // 9 mag + 20 grad
    expect(counts.misc).toBe(35)
    expect(counts.trigger).toBe(2)
    expect(counts.eeg + counts.eog + counts.ecg + counts.emg).toBe(0)
  })
})
