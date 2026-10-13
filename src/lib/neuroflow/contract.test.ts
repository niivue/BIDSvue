import { describe, expect, test } from 'bun:test'
import {
  BIDSVUE_AGENT,
  handoffJson,
  parseNeuroflowContext,
  provenanceLine,
} from './contract'

const NOW = new Date('2026-10-13T12:00:00.000Z')

describe('parseNeuroflowContext', () => {
  test('returns the object, keeping keys BIDSvue does not read', () => {
    const ctx = parseNeuroflowContext(
      JSON.stringify({
        step: 'ingest',
        inputs: { dicom_dir: '/data/dicom', importer: 'pet2bids' },
        outputDir: '/runs/r1/outputs/ingest',
      }),
    )
    expect(ctx.step).toBe('ingest')
    expect(ctx.inputs?.dicom_dir).toBe('/data/dicom')
    expect(ctx.inputs?.importer).toBe('pet2bids')
    expect(ctx.outputDir).toBe('/runs/r1/outputs/ingest')
  })

  test('rejects invalid JSON and non-objects', () => {
    expect(() => parseNeuroflowContext('{')).toThrow(/not valid JSON/)
    expect(() => parseNeuroflowContext('[]')).toThrow(/JSON object/)
    expect(() => parseNeuroflowContext('null')).toThrow(/JSON object/)
  })
})

describe('handoffJson', () => {
  test('writes the contract shape with a trailing newline', () => {
    const text = handoffJson(
      {
        tool: 'dcm2niix-reproin',
        step: 'ingest',
        bids_dir: '/out/bids',
        producedNiftiCount: 12,
      },
      BIDSVUE_AGENT,
      NOW,
    )
    expect(text.endsWith('}\n')).toBe(true)
    expect(JSON.parse(text)).toEqual({
      neuroflow: '0.1.0',
      kind: 'neuroflow/handoff',
      step: 'ingest',
      tool: 'dcm2niix-reproin',
      ts: '2026-10-13T12:00:00.000Z',
      outputs: { bids_dir: '/out/bids' },
      stats: { producedNiftiCount: 12 },
      agent: BIDSVUE_AGENT,
    })
  })

  test('step defaults to null; warnings appear only when there are some', () => {
    const base = { tool: 't', bids_dir: '/b', producedNiftiCount: 0 }
    const bare = JSON.parse(handoffJson({ ...base, warnings: [] }, 'a', NOW))
    expect(bare.step).toBeNull()
    expect('warnings' in bare).toBe(false)
    const warned = JSON.parse(
      handoffJson({ ...base, warnings: ['partial'] }, 'a', NOW),
    )
    expect(warned.warnings).toEqual(['partial'])
  })
})

describe('provenanceLine', () => {
  test('is one JSON line with ts, step, tool, action, outputs, agent', () => {
    const line = provenanceLine(
      {
        step: 'ingest',
        tool: 'neuroflow.gallery.tools/bidsvue',
        action: 'import',
        outputs: { bids_dir: '/out/bids' },
      },
      'agent@x',
      NOW,
    )
    expect(line.includes('\n')).toBe(false)
    expect(JSON.parse(line)).toEqual({
      ts: '2026-10-13T12:00:00.000Z',
      step: 'ingest',
      tool: 'neuroflow.gallery.tools/bidsvue',
      action: 'import',
      outputs: { bids_dir: '/out/bids' },
      agent: 'agent@x',
    })
  })

  test('missing step and outputs become null and {}', () => {
    const rec = JSON.parse(
      provenanceLine({ tool: 't', action: 'import' }, 'a', NOW),
    )
    expect(rec.step).toBeNull()
    expect(rec.outputs).toEqual({})
  })
})
