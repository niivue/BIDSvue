// Selection model tests for Phase F's multi-select work.
//
// SelectionStore uses Svelte 5 $state at module level, which bun:test can't
// evaluate directly. The model methods are pure data transforms over
// Set<string>; mirror them here as plain functions and assert the algebra.
// The runtime store delegates to the same logic, so a failure here is a
// real bug in how selection mutates -- not just a test-shim divergence.

import { describe, expect, test } from 'bun:test'
import type { FileNode, TreeNode } from '$lib/bids/types'
import type { FlatRow } from '$lib/components/treeFlatten'
import { rowIdentity } from '$lib/components/treeHelpers'

interface SelectionState {
  selectedPaths: Set<string>
  primaryPath: string | null
  activeIdentity: string | null
  rangeAnchor: string | null
}

function empty(): SelectionState {
  return {
    selectedPaths: new Set(),
    primaryPath: null,
    activeIdentity: null,
    rangeAnchor: null,
  }
}

// setSelection ignores prior state by design -- it's a *replace* operation,
// and the test shim mirrors that. The unused parameter is intentional so
// the test signatures line up with the live store's methods.
function setSelection(_prev: SelectionState, path: string): SelectionState {
  return {
    selectedPaths: new Set([path]),
    primaryPath: path,
    activeIdentity: path,
    rangeAnchor: path,
  }
}

function toggleInSelection(s: SelectionState, path: string): SelectionState {
  const next = new Set(s.selectedPaths)
  let primaryPath = s.primaryPath
  if (next.has(path)) {
    next.delete(path)
    if (primaryPath === path) {
      const arr = [...next]
      primaryPath = arr.length > 0 ? (arr[arr.length - 1] ?? null) : null
    }
  } else {
    next.add(path)
    primaryPath = path
  }
  return {
    selectedPaths: next,
    primaryPath,
    activeIdentity: path,
    rangeAnchor: path,
  }
}

function extendRangeTo(
  s: SelectionState,
  path: string,
  flatRows: FlatRow[],
): SelectionState {
  if (s.rangeAnchor === null) return setSelection(s, path)
  const anchorIdx = flatRows.findIndex(
    (r) => rowIdentity(r.node) === s.rangeAnchor,
  )
  const targetIdx = flatRows.findIndex((r) => rowIdentity(r.node) === path)
  if (anchorIdx === -1 || targetIdx === -1) return setSelection(s, path)
  const [lo, hi] =
    anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx]
  const next = new Set<string>()
  for (let i = lo; i <= hi; i++) next.add(rowIdentity(flatRows[i].node))
  return {
    selectedPaths: next,
    primaryPath: path,
    activeIdentity: path,
    rangeAnchor: s.rangeAnchor,
  }
}

function selectAll(s: SelectionState, paths: string[]): SelectionState {
  if (paths.length === 0) {
    return {
      selectedPaths: new Set(),
      primaryPath: null,
      activeIdentity: s.activeIdentity,
      rangeAnchor: null,
    }
  }
  const last = paths[paths.length - 1] ?? null
  const first = paths[0] ?? null
  return {
    selectedPaths: new Set(paths),
    primaryPath: last,
    activeIdentity: last,
    rangeAnchor: first,
  }
}

function clearSelection(s: SelectionState): SelectionState {
  return {
    selectedPaths: new Set(),
    primaryPath: null,
    activeIdentity: s.activeIdentity,
    rangeAnchor: null,
  }
}

// Fixture helpers ---------------------------------------------------------

function file(name: string, parent: string): FileNode {
  return {
    kind: 'file',
    path: `${parent}/${name}`,
    name,
    entities: {},
    suffix: '',
    extension: '',
    flags: {},
  }
}

function rows(nodes: TreeNode[]): FlatRow[] {
  // Keys must be unique per node; FileNode is the only kind we use here.
  return nodes.map((node, i) => ({
    node,
    depth: 0,
    key: `key-${i}-${(node as FileNode).path}`,
  }))
}

// ------------------------------------------------------------------------

describe('setSelection', () => {
  test('replaces any prior selection with a single row', () => {
    const s1 = setSelection(empty(), '/a')
    expect([...s1.selectedPaths]).toEqual(['/a'])
    expect(s1.primaryPath).toBe('/a')
    expect(s1.activeIdentity).toBe('/a')
    expect(s1.rangeAnchor).toBe('/a')
  })

  test('replaces multi-selection with the new single row', () => {
    let s = setSelection(empty(), '/a')
    s = toggleInSelection(s, '/b')
    s = toggleInSelection(s, '/c')
    s = setSelection(s, '/d')
    expect([...s.selectedPaths]).toEqual(['/d'])
    expect(s.primaryPath).toBe('/d')
  })
})

describe('toggleInSelection', () => {
  test('adds a previously unselected row and makes it primary', () => {
    let s = setSelection(empty(), '/a')
    s = toggleInSelection(s, '/b')
    expect([...s.selectedPaths]).toEqual(['/a', '/b'])
    expect(s.primaryPath).toBe('/b')
    expect(s.rangeAnchor).toBe('/b')
  })

  test('removes a selected row that is not primary; primary unchanged', () => {
    let s = setSelection(empty(), '/a')
    s = toggleInSelection(s, '/b')
    s = toggleInSelection(s, '/c') // now primary = /c
    s = toggleInSelection(s, '/a') // /a removed, primary stays /c
    expect([...s.selectedPaths]).toEqual(['/b', '/c'])
    expect(s.primaryPath).toBe('/c')
  })

  test('removing the primary promotes the most recent remaining row', () => {
    let s = setSelection(empty(), '/a')
    s = toggleInSelection(s, '/b')
    s = toggleInSelection(s, '/c') // primary /c
    s = toggleInSelection(s, '/c') // /c removed, primary -> /b (last in set)
    expect([...s.selectedPaths]).toEqual(['/a', '/b'])
    expect(s.primaryPath).toBe('/b')
  })

  test('removing the only selected row clears primary', () => {
    let s = setSelection(empty(), '/a')
    s = toggleInSelection(s, '/a')
    expect([...s.selectedPaths]).toEqual([])
    expect(s.primaryPath).toBeNull()
  })
})

describe('extendRangeTo', () => {
  const f = (p: string) => file(p.slice(1), '')
  const flat = rows([f('/a'), f('/b'), f('/c'), f('/d'), f('/e')])

  test('extends from anchor forward, replacing prior selection', () => {
    const s0 = setSelection(empty(), '/b') // anchor /b
    const s1 = extendRangeTo(s0, '/d', flat)
    expect([...s1.selectedPaths]).toEqual(['/b', '/c', '/d'])
    expect(s1.primaryPath).toBe('/d')
    expect(s1.rangeAnchor).toBe('/b') // anchor stays put
  })

  test('extends backward when target is before anchor', () => {
    const s0 = setSelection(empty(), '/d')
    const s1 = extendRangeTo(s0, '/b', flat)
    expect([...s1.selectedPaths]).toEqual(['/b', '/c', '/d'])
    expect(s1.primaryPath).toBe('/b')
    expect(s1.rangeAnchor).toBe('/d')
  })

  test('repeated extends pivot off the same anchor', () => {
    let s = setSelection(empty(), '/c')
    s = extendRangeTo(s, '/e', flat) // anchor /c, range /c..../e
    s = extendRangeTo(s, '/a', flat) // anchor still /c, range /a..../c
    expect([...s.selectedPaths]).toEqual(['/a', '/b', '/c'])
  })

  test('falls back to setSelection when anchor is unknown', () => {
    const s = extendRangeTo(empty(), '/c', flat)
    expect([...s.selectedPaths]).toEqual(['/c'])
    expect(s.primaryPath).toBe('/c')
    expect(s.rangeAnchor).toBe('/c')
  })

  test('falls back to setSelection when anchor row is no longer in flatRows', () => {
    // Anchor exists in state but is missing from flatRows (e.g. its folder
    // was collapsed). extendRangeTo should treat this as a fresh selection
    // rather than producing an empty / spurious range.
    const s0 = setSelection(empty(), '/missing')
    const s1 = extendRangeTo(s0, '/c', flat)
    expect([...s1.selectedPaths]).toEqual(['/c'])
    expect(s1.primaryPath).toBe('/c')
  })
})

describe('selectAll', () => {
  test('replaces selection with every path; primary is the last entry', () => {
    const s = selectAll(empty(), ['/a', '/b', '/c'])
    expect([...s.selectedPaths]).toEqual(['/a', '/b', '/c'])
    expect(s.primaryPath).toBe('/c')
    expect(s.rangeAnchor).toBe('/a')
  })

  test('empty input clears the selection (and primary)', () => {
    const s0 = setSelection(empty(), '/a')
    const s1 = selectAll(s0, [])
    expect([...s1.selectedPaths]).toEqual([])
    expect(s1.primaryPath).toBeNull()
  })
})

describe('setPreviewTarget', () => {
  // setPreviewTarget is the one mutation that's allowed to make primaryPath
  // diverge from selectedPaths (the Preview tab-strip use case). The next
  // selection mutation MUST re-establish the invariant so downstream code
  // can trust that primaryPath, when non-null, is always in selectedPaths.

  function setPreviewTarget(s: SelectionState, path: string): SelectionState {
    return { ...s, primaryPath: path }
  }

  test('lets primaryPath diverge from selectedPaths', () => {
    let s = setSelection(empty(), '/json')
    s = setPreviewTarget(s, '/nifti')
    expect(s.primaryPath).toBe('/nifti')
    expect(s.selectedPaths.has('/nifti')).toBe(false)
    expect(s.selectedPaths.has('/json')).toBe(true)
  })

  test('a subsequent setSelection restores the invariant', () => {
    let s = setSelection(empty(), '/json')
    s = setPreviewTarget(s, '/nifti')
    s = setSelection(s, '/other')
    expect(s.primaryPath).toBe('/other')
    expect([...s.selectedPaths]).toEqual(['/other'])
    // The diverged /nifti is gone; the new selection is internally
    // consistent again.
    expect(s.selectedPaths.has('/nifti')).toBe(false)
  })

  test('a subsequent toggleInSelection also restores the invariant', () => {
    let s = setSelection(empty(), '/json')
    s = setPreviewTarget(s, '/nifti')
    // Toggle a fresh path; primary moves there, /json stays as it was.
    s = toggleInSelection(s, '/extra')
    expect(s.primaryPath).toBe('/extra')
    expect(s.selectedPaths.has('/extra')).toBe(true)
    expect(s.selectedPaths.has('/json')).toBe(true)
  })
})

describe('clearSelection', () => {
  test('drops selection but leaves activeIdentity alone', () => {
    let s = setSelection(empty(), '/a')
    s = toggleInSelection(s, '/b')
    s = { ...s, activeIdentity: '/cursor' }
    const cleared = clearSelection(s)
    expect([...cleared.selectedPaths]).toEqual([])
    expect(cleared.primaryPath).toBeNull()
    expect(cleared.rangeAnchor).toBeNull()
    expect(cleared.activeIdentity).toBe('/cursor')
  })
})
