import { describe, expect, it } from 'bun:test'

import { type MneBidsFormValues, buildMneBidsOptions } from './mneBidsRunner'

const good: MneBidsFormValues = {
  rawFile: '/data/sample_audvis_raw.fif',
  subject: '01',
  task: 'audiovisual',
  session: '01',
  run: '1',
  powerLineFrequency: 60,
}

describe('buildMneBidsOptions', () => {
  it('maps fields to runner options (omitting empty/zero)', () => {
    const opts = buildMneBidsOptions(good)
    expect(opts).toEqual({
      raw: '/data/sample_audvis_raw.fif',
      subject: '01',
      task: 'audiovisual',
      session: '01',
      run: '1',
      line_freq: 60,
    })
  })

  it('includes events + event_id when supplied', () => {
    const opts = buildMneBidsOptions(good, {
      eventsFile: '/data/sample_audvis_raw-eve.fif',
      eventId: { 'Auditory/Left': 1, Button: 32 },
    })
    expect(opts.events).toBe('/data/sample_audvis_raw-eve.fif')
    expect(opts.event_id).toEqual({ 'Auditory/Left': 1, Button: 32 })
  })

  it('includes convert_mne_sample.py extras when supplied', () => {
    const opts = buildMneBidsOptions(good, {
      emptyRoom: '/data/ernoise_raw.fif',
      calibration: '/data/sss_cal.dat',
      crosstalk: '/data/ct_sparse.fif',
      authors: ['Alice', 'Bob'],
      dataLicense: 'PDDL',
      datasetName: 'My MEG',
    })
    expect(opts.empty_room).toBe('/data/ernoise_raw.fif')
    expect(opts.calibration).toBe('/data/sss_cal.dat')
    expect(opts.crosstalk).toBe('/data/ct_sparse.fif')
    expect(opts.authors).toEqual(['Alice', 'Bob'])
    expect(opts.data_license).toBe('PDDL')
    expect(opts.dataset_name).toBe('My MEG')
  })

  it("drops data_license when 'none' + omits empty extras", () => {
    const opts = buildMneBidsOptions(good, {
      dataLicense: 'none',
      authors: [],
      emptyRoom: null,
    })
    expect(opts.data_license).toBeUndefined()
    expect(opts.authors).toBeUndefined()
    expect(opts.empty_room).toBeUndefined()
  })

  it('rejects a non-absolute empty-room path', () => {
    expect(() => buildMneBidsOptions(good, { emptyRoom: 'rel.fif' })).toThrow(
      /absolute/,
    )
  })

  it('drops line_freq when 0 (n/a)', () => {
    const opts = buildMneBidsOptions({ ...good, powerLineFrequency: 0 })
    expect(opts.line_freq).toBeUndefined()
  })

  it('rejects missing subject / task / rawFile', () => {
    expect(() => buildMneBidsOptions({ ...good, subject: '' })).toThrow(
      /Subject/,
    )
    expect(() => buildMneBidsOptions({ ...good, task: '' })).toThrow(/Task/)
    expect(() => buildMneBidsOptions({ ...good, rawFile: '' })).toThrow(
      /Raw file/,
    )
  })

  it('rejects a non-absolute raw path', () => {
    expect(() => buildMneBidsOptions({ ...good, rawFile: 'rel.fif' })).toThrow(
      /absolute/,
    )
  })
})
