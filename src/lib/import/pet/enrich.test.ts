import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { enrichPetSidecar } from './enrich'

const FIXTURE_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'pet-golden',
  'GeneralElectricAdvanceNIMH',
)

async function loadJson<T = unknown>(name: string): Promise<T> {
  const raw = await readFile(join(FIXTURE_DIR, name), 'utf-8')
  return JSON.parse(raw) as T
}

describe('enrichPetSidecar — GE Advance NIMH golden fixture', () => {
  test('reproduces the expected BIDS-PET sidecar', async () => {
    const dcm2niixJson = await loadJson<Record<string, unknown>>(
      'dcm2niix-output.json',
    )
    const metadata = await loadJson<Record<string, unknown>>('metadata.json')
    const expected = await loadJson<Record<string, unknown>>(
      'expected-sidecar.json',
    )

    const got = enrichPetSidecar(dcm2niixJson, { metadata })

    expect(got).toEqual(expected)
  })
})

describe('enrichPetSidecar — small unit cases', () => {
  test('wraps scalar FrameDuration / ReconFilterSize / ScatterFraction into arrays', () => {
    const out = enrichPetSidecar({
      FrameDuration: 14400,
      ReconFilterSize: 4,
      ScatterFraction: 1.9e-8,
    })
    expect(out.FrameDuration).toEqual([14400])
    expect(out.ReconFilterSize).toEqual([4])
    expect(out.ScatterFraction).toEqual([1.9e-8])
  })

  test('normalises BQML to Bq/mL', () => {
    expect(enrichPetSidecar({ Units: 'BQML' }).Units).toBe('Bq/mL')
  })

  test('leaves a present Units value alone', () => {
    expect(enrichPetSidecar({ Units: 'Bq/mL' }).Units).toBe('Bq/mL')
  })

  test('defaults ScanStart to 0 when missing', () => {
    expect(enrichPetSidecar({}).ScanStart).toBe(0)
  })

  test('does not default ScanStart when already set', () => {
    expect(enrichPetSidecar({ ScanStart: 5 }).ScanStart).toBe(5)
  })

  test('falls back TimeZero to SeriesTime when missing in dcm2niix and metadata', () => {
    expect(enrichPetSidecar({ SeriesTime: '093015' }).TimeZero).toBe('09:30:15')
  })

  test('strips ScanDate', () => {
    const out = enrichPetSidecar({ ScanDate: '20260514' })
    expect(out.ScanDate).toBeUndefined()
  })

  test('lowercases ModeOfAdministration', () => {
    const out = enrichPetSidecar(
      {},
      { metadata: { ModeOfAdministration: 'BOLUS' } },
    )
    expect(out.ModeOfAdministration).toBe('bolus')
  })

  test('parses ConvolutionKernel into ReconFilterType + size when both are missing', () => {
    const out = enrichPetSidecar({
      ConvolutionKernel: 'rectangle \\  4.000000 mm  \\ order 0',
    })
    expect(out.ConvolutionKernel).toBeUndefined()
    expect(out.ReconFilterSize).toEqual([4])
    expect(out.ReconFilterType).toBe('rectangle mm order 0')
  })

  test('preserves an existing ReconFilterType when ConvolutionKernel is present', () => {
    const out = enrichPetSidecar(
      { ConvolutionKernel: 'rectangle \\  4.000000 mm' },
      { metadata: { ReconFilterType: 'rectangle', ReconFilterSize: [4] } },
    )
    expect(out.ConvolutionKernel).toBeUndefined()
    expect(out.ReconFilterType).toBe('rectangle')
    expect(out.ReconFilterSize).toEqual([4])
  })

  test('parses ReconstructionMethod into structured fields when ReconMethodName is missing', () => {
    const out = enrichPetSidecar({ ReconstructionMethod: 'OSEM3i21s' })
    expect(out.ReconstructionMethod).toBeUndefined()
    expect(out.ReconMethodName).toContain('Ordered Subset')
    expect(out.ReconMethodParameterLabels).toEqual(['subsets', 'iterations'])
    expect(out.ReconMethodParameterValues).toEqual([21, 3])
  })

  test('preserves ReconstructionMethod when ReconMethodName is already set', () => {
    const out = enrichPetSidecar({
      ReconstructionMethod: '2D Filtered Backprojection',
      ReconMethodName: 'Filtered Back Projection',
    })
    expect(out.ReconstructionMethod).toBe('2D Filtered Backprojection')
    expect(out.ReconMethodName).toBe('Filtered Back Projection')
  })
})
