import { describe, expect, it } from 'bun:test'
import { BIDS_PRIMER } from './bidsPrimer'

describe('BIDS_PRIMER', () => {
  it('is concise (rides every dataset session — keep under ~3 KB)', () => {
    expect(BIDS_PRIMER.length).toBeGreaterThan(200)
    expect(BIDS_PRIMER.length).toBeLessThan(3000)
  })

  it('states the load-bearing rules', () => {
    // Off-limits trees + VCS internals.
    expect(BIDS_PRIMER).toContain('derivatives/')
    expect(BIDS_PRIMER).toContain('sourcedata/')
    expect(BIDS_PRIMER).toContain('.git')
    // Identity goes through rename_entity, not raw participant_id edits.
    expect(BIDS_PRIMER).toContain('rename_entity')
    expect(BIDS_PRIMER).toContain('participant_id')
    // Writes need human approval.
    expect(BIDS_PRIMER.toLowerCase()).toContain('approve')
  })

  it('cites the reference URLs (for the human, not fetched)', () => {
    expect(BIDS_PRIMER).toContain('bids-specification.readthedocs.io')
    expect(BIDS_PRIMER).toContain('reproin-namer')
  })
})
