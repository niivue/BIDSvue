import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ctfRecordingFromRes4 } from '../formats/ctf/ctfRecording'
import type { Res4Channel, Res4Header } from '../formats/ctf/header'
import type { MegChannel, MegCoordinates } from '../recording'
import {
  floatVal,
  writeChannelsTsv,
  writeCoordsystemJson,
  writeMegJson,
} from './sidecars'

const GOLDEN_ROOT = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'meg-golden',
  'ctf-spm-face',
  'sub-01',
  'meg',
)

// ---------------------------------------------------------------------------
// Fixture helpers.
// ---------------------------------------------------------------------------

/**
 * Build a synthetic `Res4Channel[]` that matches the spm_face_ctf
 * fixture's channel-count breakdown (274 MEG + 20 REF_GRAD + 9
 * REF_MAG + 2 STIM + 35 MISC = 340). The first 5 entries match the
 * fixture's first 5 names + types so the writer's first 6 TSV rows
 * (header + 5) can be byte-compared against the golden.
 */
function fixtureChannels(): Res4Channel[] {
  const channels: Res4Channel[] = []
  // The first 5 channels in the spm_face_ctf .res4 -- verified by
  // running parseRes4 against the dev-local fixture during M10-B-1.
  channels.push({
    name: 'UPPT002',
    sensorTypeIndex: 11,
    coilType: 0,
    gradOrder: 0,
  })
  channels.push({
    name: 'UPPT001',
    sensorTypeIndex: 11,
    coilType: 0,
    gradOrder: 0,
  })
  channels.push({
    name: 'SCLK01-177',
    sensorTypeIndex: 13,
    coilType: 0,
    gradOrder: 0,
  })
  channels.push({
    name: 'BG1-2908',
    sensorTypeIndex: 0,
    coilType: 5004,
    gradOrder: 0,
  })
  channels.push({
    name: 'BG2-2908',
    sensorTypeIndex: 0,
    coilType: 5004,
    gradOrder: 0,
  })
  // Filler entries to hit the spm_face_ctf totals. Names don't matter
  // here because the test only compares the first 5 rows row-by-row;
  // total channel COUNT is what feeds _meg.json's *ChannelCount fields.
  const fill = (
    n: number,
    sensorTypeIndex: number,
    gradOrder: number,
    prefix: string,
  ): void => {
    for (let i = 0; i < n; i++) {
      channels.push({
        name: `${prefix}${i.toString().padStart(3, '0')}`,
        sensorTypeIndex,
        coilType: 0,
        gradOrder,
      })
    }
  }
  // 9 MEGREFMAG (sensor 0) -- already have 2 (BG1/BG2); need 7 more.
  fill(7, 0, 0, 'REFMAG')
  // 20 MEGREFGRADAXIAL (sensor 1).
  fill(20, 1, 0, 'REFGRAD')
  // 274 MEGGRADAXIAL (sensor 5) with grad_order_no = 3 (golden's
  // SpatialCompensation.GradientOrder).
  fill(274, 5, 3, 'MEG')
  // 34 more MISC channels (sensor 13) -- 1 already (SCLK01-177).
  fill(34, 13, 0, 'MISC')
  return channels
}

function fixtureHeader(): Res4Header {
  return {
    head: 'MEG42RS',
    sfreq: 480,
    nsamp: 324481,
    noTrials: 1,
    nchan: 340,
    dataDate: '24-Nov-2008',
    dataTime: '09:54',
    channels: fixtureChannels(),
  }
}

// ---------------------------------------------------------------------------
// Golden-file helpers.
// ---------------------------------------------------------------------------

async function readGolden(name: string): Promise<string> {
  const buf = await readFile(join(GOLDEN_ROOT, name))
  // `ignoreBOM: true` preserves the UTF-8 BOM so byte-equal diffs
  // against `writeChannelsTsv`'s output (which emits a BOM) succeed.
  // The default behaviour silently strips a leading U+FEFF.
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf)
  // Normalize CRLF -> LF: the writers emit LF (and `.gitattributes` marks
  // these fixtures `eol=lf`), but a Windows working tree can still carry
  // CRLF-checked-out goldens. The line-ending is not what these tests
  // assert; the field/row content is.
  return text.replace(/\r\n/g, '\n')
}

/**
 * MNE-BIDS's `_meg.json.RecordingDuration` differs from our naive
 * `nsamp * noTrials / sfreq` by ~8 samples (one MNE end-sample
 * convention). For tests that need a byte-equal JSON diff, we
 * normalise both the typed `meta.recordingDuration` and the
 * vendorMeta-resident `RecordingDuration` (the writer reads the
 * latter because the CTF builder places it inline) to the golden's
 * value.
 */
function withGoldenRecordingDuration(
  rec: ReturnType<typeof ctfRecordingFromRes4>,
  goldenDuration: number,
): ReturnType<typeof ctfRecordingFromRes4> {
  return {
    ...rec,
    meta: {
      ...rec.meta,
      recordingDuration: goldenDuration,
      vendorMeta: {
        ...rec.meta.vendorMeta,
        RecordingDuration: floatVal(goldenDuration),
      },
    },
  }
}

// ---------------------------------------------------------------------------

describe('writeMegJson', () => {
  test('matches the spm_face_ctf golden byte-for-byte (with RecordingDuration normalisation)', async () => {
    // For the byte-equal check, normalise RecordingDuration to MNE-
    // BIDS's value. The M10 decision doc tracks the formula
    // difference as risk #1.
    const rec = withGoldenRecordingDuration(
      ctfRecordingFromRes4(fixtureHeader(), { taskName: 'faces' }),
      675.9854166666667,
    )
    const got = writeMegJson(rec)
    const want = await readGolden('sub-01_task-faces_run-01_meg.json')
    expect(got).toBe(want)
  })

  test('parses back to the same field values when fed our own output', () => {
    const rec = ctfRecordingFromRes4(fixtureHeader(), { taskName: 'faces' })
    const json = writeMegJson(rec)
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed.TaskName).toBe('faces')
    expect(parsed.Manufacturer).toBe('CTF')
    expect(parsed.SamplingFrequency).toBe(480)
    expect(parsed.RecordingType).toBe('continuous')
    expect(parsed.MEGChannelCount).toBe(274)
    expect(parsed.MEGREFChannelCount).toBe(29)
    expect(parsed.TriggerChannelCount).toBe(2)
    expect(parsed.MiscChannelCount).toBe(35)
  })

  test('emits SamplingFrequency as a float (480.0) not an integer', () => {
    const rec = ctfRecordingFromRes4(fixtureHeader(), { taskName: 'faces' })
    expect(writeMegJson(rec)).toContain('"SamplingFrequency": 480.0')
  })

  test('emits PowerLineFrequency: "n/a" when null', () => {
    const rec = ctfRecordingFromRes4(fixtureHeader(), { taskName: 'faces' })
    expect(writeMegJson(rec)).toContain('"PowerLineFrequency": "n/a"')
  })

  test('emits the wizard-provided PowerLineFrequency as a numeric float', () => {
    const rec = ctfRecordingFromRes4(fixtureHeader(), {
      taskName: 'faces',
      powerLineFrequency: 60,
    })
    expect(writeMegJson(rec)).toContain('"PowerLineFrequency": 60')
  })

  test('respects vendor-supplied DewarPosition override', () => {
    const rec = ctfRecordingFromRes4(fixtureHeader(), {
      taskName: 'faces',
      dewarPosition: 'upright',
    })
    expect(writeMegJson(rec)).toContain('"DewarPosition": "upright"')
  })
})

describe('writeChannelsTsv', () => {
  test('first 6 rows match the spm_face_ctf golden byte-for-byte', async () => {
    const rec = ctfRecordingFromRes4(fixtureHeader(), { taskName: 'faces' })
    const got = writeChannelsTsv(rec)
    const want = await readGolden('sub-01_task-faces_run-01_channels.tsv')
    const gotLines = got.split('\n').slice(0, 6).join('\n')
    const wantLines = want.split('\n').slice(0, 6).join('\n')
    expect(gotLines).toBe(wantLines)
  })

  test('begins with a UTF-8 BOM', () => {
    const rec = ctfRecordingFromRes4(fixtureHeader(), { taskName: 'faces' })
    const tsv = writeChannelsTsv(rec)
    // BOM is encoded as the three bytes 0xEF 0xBB 0xBF; in a JS string
    // this is the single character U+FEFF.
    expect(tsv.charCodeAt(0)).toBe(0xfeff)
  })

  test('ends with a trailing newline', () => {
    const rec = ctfRecordingFromRes4(fixtureHeader(), { taskName: 'faces' })
    expect(writeChannelsTsv(rec).endsWith('\n')).toBe(true)
  })

  test('emits sampling_frequency as a float (480.0) not an integer', () => {
    const rec = ctfRecordingFromRes4(fixtureHeader(), { taskName: 'faces' })
    const tsv = writeChannelsTsv(rec)
    const firstDataRow = tsv.split('\n')[1]
    // Row format: name type units low_cutoff high_cutoff description sampling_frequency status status_description
    const cells = firstDataRow.split('\t')
    expect(cells[6]).toBe('480.0')
  })

  test('emits null low_cutoff as the BIDS sentinel "n/a"', () => {
    const base = ctfRecordingFromRes4(fixtureHeader(), { taskName: 'faces' })
    const rec = {
      ...base,
      channels: base.channels.map(
        (c): MegChannel => ({ ...c, lowCutoff: null, highCutoff: null }),
      ),
    }
    const tsv = writeChannelsTsv(rec)
    const firstDataRow = tsv.split('\n')[1]
    const cells = firstDataRow.split('\t')
    // low_cutoff col 3, high_cutoff col 4.
    expect(cells[3]).toBe('n/a')
    expect(cells[4]).toBe('n/a')
  })

  test('row count matches channel count + 1 header + 1 trailing newline', () => {
    const rec = ctfRecordingFromRes4(fixtureHeader(), { taskName: 'faces' })
    const tsv = writeChannelsTsv(rec)
    const lines = tsv.split('\n')
    // 340 channels + 1 header + 1 trailing-newline empty string.
    expect(lines.length).toBe(340 + 1 + 1)
    expect(lines[lines.length - 1]).toBe('') // trailing newline -> empty last split
  })
})

describe('writeCoordsystemJson', () => {
  const SAMPLE_COORDS: MegCoordinates = {
    system: 'CTF',
    systemDescription: 'ALS orientation and the origin between the ears',
    units: 'cm',
    headCoils: {
      NAS: [9.83045, 0, 0],
      LPA: [-0.0899511, 7.20121, 0],
      RPA: [0.0899511, -7.20121, 0],
    },
    anatomicalLandmarks: {
      NAS: [9.83045, 0, 0],
      LPA: [-0.0899511, 7.20121, 0],
      RPA: [0.0899511, -7.20121, 0],
    },
  }

  test('emits the BIDS-MEG canonical key set', () => {
    const parsed = JSON.parse(writeCoordsystemJson(SAMPLE_COORDS)) as Record<
      string,
      unknown
    >
    expect(Object.keys(parsed)).toEqual([
      'MEGCoordinateSystem',
      'MEGCoordinateUnits',
      'MEGCoordinateSystemDescription',
      'HeadCoilCoordinates',
      'HeadCoilCoordinateSystem',
      'HeadCoilCoordinateUnits',
      'AnatomicalLandmarkCoordinates',
      'AnatomicalLandmarkCoordinateSystem',
      'AnatomicalLandmarkCoordinateUnits',
    ])
  })

  test('preserves CTF-frame values in cm (the documented deviation from MNE-BIDS)', () => {
    const json = writeCoordsystemJson(SAMPLE_COORDS)
    const parsed = JSON.parse(json) as Record<
      string,
      { NAS: number[]; LPA: number[]; RPA: number[] }
    >
    expect(parsed.HeadCoilCoordinates.NAS).toEqual([9.83045, 0, 0])
    expect(parsed.HeadCoilCoordinates.LPA).toEqual([-0.0899511, 7.20121, 0])
    expect(parsed.HeadCoilCoordinates.RPA).toEqual([0.0899511, -7.20121, 0])
  })

  test('declared units match the values (consistency invariant)', () => {
    const json = writeCoordsystemJson(SAMPLE_COORDS)
    // NAS at x=9.83 is ~10 cm forward -- plausible for cm-declared
    // units. Plausibility test guards against a future regression
    // that scaled values without updating the units string.
    expect(json).toContain('"MEGCoordinateUnits": "cm"')
    expect(json).toContain('"HeadCoilCoordinateUnits": "cm"')
    expect(json).toContain('"AnatomicalLandmarkCoordinateUnits": "cm"')
    expect(json).toContain('9.83045')
  })

  test('zero coords render as 0.0 (float convention)', () => {
    const json = writeCoordsystemJson(SAMPLE_COORDS)
    // NAS z is exactly 0 -- check it renders as 0.0 not 0.
    expect(json).toMatch(/"NAS":\s*\[\s*9\.83045,\s*0\.0,\s*0\.0\s*\]/)
  })

  test('emits a trailing newline', () => {
    expect(writeCoordsystemJson(SAMPLE_COORDS).endsWith('\n')).toBe(true)
  })

  test('omits MEGCoordinateSystemDescription when null', () => {
    const minimal: MegCoordinates = {
      ...SAMPLE_COORDS,
      systemDescription: null,
    }
    const json = writeCoordsystemJson(minimal)
    expect(json).not.toContain('MEGCoordinateSystemDescription')
  })

  test('reuses the same system string for HeadCoil + AnatomicalLandmark families', () => {
    const json = writeCoordsystemJson(SAMPLE_COORDS)
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed.HeadCoilCoordinateSystem).toBe('CTF')
    expect(parsed.AnatomicalLandmarkCoordinateSystem).toBe('CTF')
  })
})
