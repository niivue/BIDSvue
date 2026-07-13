import { describe, expect, test } from 'bun:test'
import { applyDeidState, detectDefaceState } from './defaceStatus'
import { DEFACE_TOOLS } from './tools'

describe('detectDefaceState', () => {
  test('returns "original" for null / non-object / missing-field sidecars', () => {
    expect(detectDefaceState(null)).toBe('original')
    expect(detectDefaceState({})).toBe('original')
    expect(detectDefaceState({ RepetitionTime: 2 })).toBe('original')
    expect(detectDefaceState('not an object')).toBe('original')
  })

  test('returns "original" when the sequence has no BIDSvue entries', () => {
    const sidecar = {
      DeidentificationMethodCodeSequence: [
        {
          CodingSchemeDesignator: 'DCM',
          CodeValue: '113101',
          CodeMeaning: 'Clean Pixel Data Option',
        },
      ],
    }
    expect(detectDefaceState(sidecar)).toBe('original')
  })

  test('returns the tool id matching a BIDSvue entry', () => {
    const sidecar = {
      DeidentificationMethodCodeSequence: [
        {
          CodingSchemeDesignator: 'BIDSvue',
          CodeValue: 'BIDSVUE-DEFACE-ALLINEATE-V1',
          CodeMeaning: 'BIDSvue allineate skull-strip deface',
        },
      ],
    }
    expect(detectDefaceState(sidecar)).toBe('allineate')
  })

  test('picks the topmost (last-appended) BIDSvue entry when multiple are present', () => {
    // Shouldn't happen in practice (applyDeidState dedupes), but the
    // reader is defensive.
    const sidecar = {
      DeidentificationMethodCodeSequence: [
        {
          CodingSchemeDesignator: 'BIDSvue',
          CodeValue: 'UNKNOWN-TOOL',
        },
        {
          CodingSchemeDesignator: 'BIDSvue',
          CodeValue: 'BIDSVUE-DEFACE-ALLINEATE-V1',
        },
      ],
    }
    expect(detectDefaceState(sidecar)).toBe('allineate')
  })
})

describe('applyDeidState', () => {
  test('appends a BIDSvue entry for an unmarked sidecar', () => {
    const next = applyDeidState({}, 'allineate')
    expect(next.DeidentificationMethodCodeSequence).toEqual([
      {
        CodingSchemeDesignator: 'BIDSvue',
        CodeValue: 'BIDSVUE-DEFACE-ALLINEATE-V1',
        CodeMeaning: 'BIDSvue allineate deface',
      },
    ])
  })

  test('preserves non-BIDSvue entries and adds the BIDSvue one alongside', () => {
    const sidecar = {
      DeidentificationMethodCodeSequence: [
        { CodingSchemeDesignator: 'DCM', CodeValue: '113101' },
      ],
    }
    const next = applyDeidState(sidecar, 'allineate')
    const seq = next.DeidentificationMethodCodeSequence as Array<
      Record<string, string>
    >
    expect(seq).toHaveLength(2)
    expect(seq[0]).toEqual({
      CodingSchemeDesignator: 'DCM',
      CodeValue: '113101',
    })
    expect(seq[1].CodingSchemeDesignator).toBe('BIDSvue')
  })

  test('replaces an existing BIDSvue entry rather than accumulating', () => {
    const sidecar = {
      DeidentificationMethodCodeSequence: [
        {
          CodingSchemeDesignator: 'BIDSvue',
          CodeValue: 'BIDSVUE-DEFACE-ALLINEATE-V1',
        },
      ],
    }
    const next = applyDeidState(sidecar, 'allineate')
    const seq = next.DeidentificationMethodCodeSequence as unknown[]
    // Still exactly one BIDSvue entry — old was dropped, new appended.
    expect(seq).toHaveLength(1)
  })

  test('reverting to "original" drops BIDSvue entries but keeps others', () => {
    const sidecar = {
      RepetitionTime: 2,
      DeidentificationMethodCodeSequence: [
        { CodingSchemeDesignator: 'DCM', CodeValue: '113101' },
        {
          CodingSchemeDesignator: 'BIDSvue',
          CodeValue: 'BIDSVUE-DEFACE-ALLINEATE-V1',
        },
      ],
    }
    const next = applyDeidState(sidecar, 'original')
    expect(next.RepetitionTime).toBe(2)
    const seq = next.DeidentificationMethodCodeSequence as Array<
      Record<string, string>
    >
    expect(seq).toHaveLength(1)
    expect(seq[0]).toEqual({
      CodingSchemeDesignator: 'DCM',
      CodeValue: '113101',
    })
  })

  test('reverting to "original" removes the key entirely when no entries remain', () => {
    const sidecar = {
      DeidentificationMethodCodeSequence: [
        {
          CodingSchemeDesignator: 'BIDSvue',
          CodeValue: 'BIDSVUE-DEFACE-ALLINEATE-V1',
        },
      ],
    }
    const next = applyDeidState(sidecar, 'original')
    expect('DeidentificationMethodCodeSequence' in next).toBe(false)
  })

  test('round-trip: apply allineate then revert produces the original sidecar (modulo key omission)', () => {
    const original = { RepetitionTime: 2 }
    const defaced = applyDeidState(original, 'allineate')
    const reverted = applyDeidState(defaced, 'original')
    expect(reverted).toEqual(original)
  })
})

// The status logic is data-driven off DEFACE_TOOLS, so each tool routes
// correctly by construction — but only if every descriptor stays in the
// registry with a unique CodeValue. This pins that invariant so a future
// descriptor edit can't silently misroute one tool's state to another.
describe('deid state registry', () => {
  test('every DEFACE_TOOLS CodeValue is unique', () => {
    const codes = DEFACE_TOOLS.map((t) => t.deidEntry.CodeValue)
    expect(new Set(codes).size).toBe(codes.length)
  })
})
