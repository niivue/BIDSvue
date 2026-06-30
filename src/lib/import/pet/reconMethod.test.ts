import { describe, expect, test } from 'bun:test'
import { parseConvolutionKernel, parseReconMethod } from './reconMethod'

describe('parseReconMethod', () => {
  test('matches the acronym table FilteredBackProjection (no lowercase p)', () => {
    // The acronym table value is "FilteredBackProjection". dcm2niix
    // generally emits the lowercase-p form "Filtered Backprojection",
    // which does NOT match the table; the FBP-special-case branch is
    // only reached when the acronym match fires.
    expect(parseReconMethod('FilteredBackProjection')).toMatchObject({
      ReconMethodName: 'Filtered Back Projection',
      ReconMethodParameterLabels: [],
      ReconMethodParameterUnits: [],
      ReconMethodParameterValues: [],
    })
  })

  test('returns the unmatched name verbatim (case-sensitive miss)', () => {
    // Reproduces pypet2bids' behaviour where "FilteredBackprojection"
    // (lowercase p) does not match the acronym table and falls through
    // to the "no params known" fallback.
    const result = parseReconMethod('2D Filtered Backprojection')
    expect(result.ReconMethodName).toBe('2DFilteredBackprojection')
    expect(result.ReconMethodParameterLabels).toEqual(['none', 'none'])
    expect(result.ReconMethodParameterUnits).toEqual(['none', 'none'])
    expect(result.ReconMethodParameterValues).toBeUndefined()
  })

  test('parses iter-first OSEM with subsets + iterations', () => {
    const result = parseReconMethod('OSEM3i21s')
    expect(result.ReconMethodName).toContain('Ordered Subset')
    expect(result.ReconMethodParameterLabels).toEqual(['subsets', 'iterations'])
    expect(result.ReconMethodParameterUnits).toEqual([null, null])
    expect(result.ReconMethodParameterValues).toEqual([21, 3])
  })

  test('parses sub-first OSEM with subsets + iterations', () => {
    const result = parseReconMethod('OSEM21s3i')
    expect(result.ReconMethodParameterValues).toEqual([21, 3])
  })

  test('expands PSF + TOF acronyms', () => {
    const result = parseReconMethod('PSF+TOF3i21s')
    expect(result.ReconMethodName).toContain('Point-Spread Function')
    expect(result.ReconMethodName).toContain('Time Of Flight')
    expect(result.ReconMethodParameterValues).toEqual([21, 3])
  })

  test('passes unknown method names through unchanged', () => {
    const result = parseReconMethod('CustomMethod')
    expect(result.ReconMethodName).toBe('CustomMethod')
    expect(result.ReconMethodParameterLabels).toEqual(['none', 'none'])
    expect(result.ReconMethodParameterUnits).toEqual(['none', 'none'])
    expect(result.ReconMethodParameterValues).toBeUndefined()
  })

  test('strips leading/trailing non-alphanumeric junk', () => {
    const result = parseReconMethod(' --3D-RAMLA-- ')
    expect(result.ReconMethodName).toContain('Row Action Maximum Likelihood')
  })
})

describe('parseConvolutionKernel', () => {
  test('splits "rectangle \\\\  4.000000 mm  \\\\ order 0" into type + size', () => {
    const out = parseConvolutionKernel('rectangle \\  4.000000 mm  \\ order 0')
    expect(out.ReconFilterSize).toBe(4.0)
    expect(out.ReconFilterType).toBe('rectangle mm order 0')
  })

  test('returns just the type when no float is present', () => {
    const out = parseConvolutionKernel('Gaussian')
    expect(out.ReconFilterSize).toBeUndefined()
    expect(out.ReconFilterType).toBe('Gaussian')
  })

  test('returns an empty object for empty input', () => {
    expect(parseConvolutionKernel('')).toEqual({})
  })
})
