import { describe, expect, test } from 'bun:test'
import { parseFilename } from '$lib/bids/entities'
import type { Dataset, FileNode, TreeNode } from '$lib/bids/types'
import { basename } from '$lib/util/paths'
import { resolveCloneTargets } from './cloneTargets'
import { computeClonePlan, computeCreatePlan } from './computeEventsPlan'

type FileSpec = string | { path: string; pointer?: boolean }

function makeDataset(root: string, files: FileSpec[]): Dataset {
  const byPath = new Map<string, TreeNode>()
  const bySuffix = new Map<string, FileNode[]>()
  for (const f of files) {
    const path = typeof f === 'string' ? f : f.path
    const pointer = typeof f === 'object' && f.pointer === true
    const parsed = parseFilename(basename(path))
    const node: FileNode = {
      kind: 'file',
      path,
      name: basename(path),
      entities: parsed.entities,
      suffix: parsed.suffix,
      extension: parsed.extension,
      flags: pointer
        ? {
            pointer: {
              backend: 'git-annex',
              hash: 'x',
              size: 1,
              extension: parsed.extension,
              contentPresent: false,
            },
          }
        : {},
    }
    byPath.set(path, node)
    const arr = bySuffix.get(parsed.suffix) ?? []
    arr.push(node)
    bySuffix.set(parsed.suffix, arr)
  }
  return {
    root,
    description: null,
    participants: null,
    tree: {
      kind: 'folder',
      path: root,
      name: basename(root),
      level: 'root',
      children: [],
      flags: {},
    },
    index: {
      byPath,
      bySuffix,
      bySubject: new Map(),
      bySubjectSession: new Map(),
    },
    bidsIgnorePatterns: [],
  }
}

const R = '/ds'

describe('resolveCloneTargets', () => {
  test('task only present in sub-01 matches just that subject', () => {
    const ds = makeDataset(R, [
      `${R}/sub-01/func/sub-01_task-memory_bold.nii.gz`,
      `${R}/sub-02/func/sub-02_task-rest_bold.nii.gz`,
    ])
    const m = resolveCloneTargets({ dataset: ds, taskLabel: 'memory' })
    expect(m.create.map((c) => c.eventsPath)).toEqual([
      `${R}/sub-01/func/sub-01_task-memory_events.tsv`,
    ])
  })

  test('matches across sessions; skips runs that already have events', () => {
    const ds = makeDataset(R, [
      `${R}/sub-01/ses-1/func/sub-01_ses-1_task-x_bold.nii.gz`,
      `${R}/sub-01/ses-2/func/sub-01_ses-2_task-x_bold.nii.gz`,
      `${R}/sub-01/ses-2/func/sub-01_ses-2_task-x_events.tsv`, // already present
    ])
    const m = resolveCloneTargets({ dataset: ds, taskLabel: 'x' })
    expect(m.create.map((c) => c.eventsPath)).toEqual([
      `${R}/sub-01/ses-1/func/sub-01_ses-1_task-x_events.tsv`,
    ])
    expect(m.skipped.map((s) => s.eventsPath)).toEqual([
      `${R}/sub-01/ses-2/func/sub-01_ses-2_task-x_events.tsv`,
    ])
  })

  test('run-1 vs run-10 never cross-contaminate', () => {
    const ds = makeDataset(R, [
      `${R}/sub-01/func/sub-01_task-x_run-1_bold.nii.gz`,
      `${R}/sub-01/func/sub-01_task-x_run-10_bold.nii.gz`,
    ])
    const m = resolveCloneTargets({ dataset: ds, taskLabel: 'x' })
    expect(m.create.map((c) => c.eventsPath)).toEqual([
      `${R}/sub-01/func/sub-01_task-x_run-1_events.tsv`,
      `${R}/sub-01/func/sub-01_task-x_run-10_events.tsv`,
    ])
  })

  test('multi-echo collapses to one shared events target', () => {
    const ds = makeDataset(R, [
      `${R}/sub-01/func/sub-01_task-x_echo-1_bold.nii.gz`,
      `${R}/sub-01/func/sub-01_task-x_echo-2_bold.nii.gz`,
    ])
    const m = resolveCloneTargets({ dataset: ds, taskLabel: 'x' })
    expect(m.create).toHaveLength(1)
    expect(m.create[0]?.eventsPath).toBe(
      `${R}/sub-01/func/sub-01_task-x_events.tsv`,
    )
  })

  test('excludes derivatives / sourcedata / code trees and _bold.json sidecars', () => {
    const ds = makeDataset(R, [
      `${R}/derivatives/fp/sub-01/func/sub-01_task-x_desc-pp_bold.nii.gz`,
      `${R}/sourcedata/sub-01_task-x_bold.nii.gz`,
      `${R}/sub-01/func/sub-01_task-x_bold.json`, // sidecar, not a run
      `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`, // the real run
    ])
    const m = resolveCloneTargets({ dataset: ds, taskLabel: 'x' })
    expect(m.create.map((c) => c.boldPath)).toEqual([
      `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`,
    ])
  })

  test('ignores malformed index entries outside the dataset root', () => {
    const ds = makeDataset(R, [
      `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`,
      '/other/sub-02/func/sub-02_task-x_bold.nii.gz',
    ])
    const m = resolveCloneTargets({ dataset: ds, taskLabel: 'x' })
    expect(m.create.map((c) => c.boldPath)).toEqual([
      `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`,
    ])
  })

  test('un-fetched pointer run is set aside, not created', () => {
    const ds = makeDataset(R, [
      { path: `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`, pointer: true },
    ])
    const m = resolveCloneTargets({ dataset: ds, taskLabel: 'x' })
    expect(m.create).toHaveLength(0)
    expect(m.unfetched).toEqual([`${R}/sub-01/func/sub-01_task-x_bold.nii.gz`])
  })

  test('a fetched echo wins over an un-fetched sibling', () => {
    const ds = makeDataset(R, [
      {
        path: `${R}/sub-01/func/sub-01_task-x_echo-1_bold.nii.gz`,
        pointer: true,
      },
      `${R}/sub-01/func/sub-01_task-x_echo-2_bold.nii.gz`,
    ])
    const m = resolveCloneTargets({ dataset: ds, taskLabel: 'x' })
    expect(m.create).toHaveLength(1)
    expect(m.unfetched).toHaveLength(0)
  })
})

describe('computeClonePlan', () => {
  test('happy path: clones source bytes, scaffolds events.json when none', () => {
    const ds = makeDataset(R, [
      `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`,
      `${R}/sub-01/func/sub-01_task-x_events.tsv`, // source
      `${R}/sub-02/func/sub-02_task-x_bold.nii.gz`,
    ])
    const plan = computeClonePlan({
      dataset: ds,
      sourceEventsPath: `${R}/sub-01/func/sub-01_task-x_events.tsv`,
      sourceContents: 'onset\tduration\ttrial_type\n0\t1\tgo\n',
    })
    expect(plan.blocked).toBe(false)
    expect(plan.create.map((c) => c.eventsPath)).toEqual([
      `${R}/sub-02/func/sub-02_task-x_events.tsv`,
    ])
    expect(plan.skipped.map((s) => s.eventsPath)).toEqual([
      `${R}/sub-01/func/sub-01_task-x_events.tsv`,
    ])
    expect(plan.contents).toBe('onset\tduration\ttrial_type\n0\t1\tgo\n')
    expect(plan.scaffoldEventsJson?.path).toBe(`${R}/task-x_events.json`)
  })

  test('no scaffold when an inheritable events.json already covers the task', () => {
    const ds = makeDataset(R, [
      `${R}/task-x_events.json`,
      `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`,
      `${R}/sub-01/func/sub-01_task-x_events.tsv`,
      `${R}/sub-02/func/sub-02_task-x_bold.nii.gz`,
    ])
    const plan = computeClonePlan({
      dataset: ds,
      sourceEventsPath: `${R}/sub-01/func/sub-01_task-x_events.tsv`,
      sourceContents: 'x',
    })
    expect(plan.scaffoldEventsJson).toBeUndefined()
  })

  test('a ROOT-LEVEL but run-narrowed events.json does NOT suppress the root scaffold', () => {
    // task-x_run-1_events.json at root covers only run-1, not run-2 — the
    // global task-x scaffold is still needed (audit follow-up 2026-06-28).
    const ds = makeDataset(R, [
      `${R}/task-x_run-1_events.json`,
      `${R}/sub-01/func/sub-01_task-x_run-1_bold.nii.gz`,
      `${R}/sub-01/func/sub-01_task-x_run-1_events.tsv`,
      `${R}/sub-02/func/sub-02_task-x_run-2_bold.nii.gz`,
    ])
    const plan = computeClonePlan({
      dataset: ds,
      sourceEventsPath: `${R}/sub-01/func/sub-01_task-x_run-1_events.tsv`,
      sourceContents: 'x',
    })
    expect(plan.scaffoldEventsJson?.path).toBe(`${R}/task-x_events.json`)
  })

  test('a SUBJECT-LOCAL events.json does NOT suppress the root scaffold', () => {
    // sub-01 has its own task-x events.json; cloning to sub-02 must still
    // scaffold the root one (sub-01's sidecar is not inherited by sub-02).
    const ds = makeDataset(R, [
      `${R}/sub-01/func/sub-01_task-x_events.json`,
      `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`,
      `${R}/sub-01/func/sub-01_task-x_events.tsv`,
      `${R}/sub-02/func/sub-02_task-x_bold.nii.gz`,
    ])
    const plan = computeClonePlan({
      dataset: ds,
      sourceEventsPath: `${R}/sub-01/func/sub-01_task-x_events.tsv`,
      sourceContents: 'x',
    })
    expect(plan.scaffoldEventsJson?.path).toBe(`${R}/task-x_events.json`)
  })

  test('blocked when every matching run already has events', () => {
    const ds = makeDataset(R, [
      `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`,
      `${R}/sub-01/func/sub-01_task-x_events.tsv`,
    ])
    const plan = computeClonePlan({
      dataset: ds,
      sourceEventsPath: `${R}/sub-01/func/sub-01_task-x_events.tsv`,
      sourceContents: 'x',
    })
    expect(plan.blocked).toBe(true)
    expect(plan.warnings.join(' ')).toContain('already has')
  })

  test('refuses a source in derivatives', () => {
    const ds = makeDataset(R, [`${R}/derivatives/sub-01_task-x_events.tsv`])
    const plan = computeClonePlan({
      dataset: ds,
      sourceEventsPath: `${R}/derivatives/sub-01_task-x_events.tsv`,
      sourceContents: 'x',
    })
    expect(plan.blocked).toBe(true)
    expect(plan.warnings.join(' ')).toContain('out-of-scope')
  })

  test('refuses a source outside the dataset root', () => {
    const ds = makeDataset(R, [`${R}/sub-01/func/sub-01_task-x_bold.nii.gz`])
    const plan = computeClonePlan({
      dataset: ds,
      sourceEventsPath: '/other/sub-01/func/sub-01_task-x_events.tsv',
      sourceContents: 'x',
    })
    expect(plan.blocked).toBe(true)
    expect(plan.warnings.join(' ')).toContain('outside')
  })

  test('refuses a source with `..` segments before any read', () => {
    const ds = makeDataset(R, [`${R}/sub-01/func/sub-01_task-x_bold.nii.gz`])
    // Lexically starts with the root, but `..` escapes the subtree.
    const plan = computeClonePlan({
      dataset: ds,
      sourceEventsPath: `${R}/sub-01/../../x_task-x_events.tsv`,
      sourceContents: 'x',
    })
    expect(plan.blocked).toBe(true)
    expect(plan.warnings.join(' ')).toContain('unsafe')
  })

  test('refuses a source with no task entity', () => {
    const ds = makeDataset(R, [`${R}/sub-01/func/sub-01_events.tsv`])
    const plan = computeClonePlan({
      dataset: ds,
      sourceEventsPath: `${R}/sub-01/func/sub-01_events.tsv`,
      sourceContents: 'x',
    })
    expect(plan.blocked).toBe(true)
    expect(plan.warnings.join(' ')).toContain('task entity')
  })
})

describe('computeCreatePlan', () => {
  test('creates one header-only events file + scaffold', () => {
    const ds = makeDataset(R, [`${R}/sub-01/func/sub-01_task-x_bold.nii.gz`])
    const plan = computeCreatePlan({
      dataset: ds,
      boldPath: `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`,
    })
    expect(plan.blocked).toBe(false)
    expect(plan.create.map((c) => c.eventsPath)).toEqual([
      `${R}/sub-01/func/sub-01_task-x_events.tsv`,
    ])
    expect(plan.contents).toBe('onset\tduration\ttrial_type\n')
    expect(plan.scaffoldEventsJson?.path).toBe(`${R}/task-x_events.json`)
  })

  test('multi-echo create derives the echo-stripped events path', () => {
    const ds = makeDataset(R, [
      `${R}/sub-01/func/sub-01_task-x_echo-1_bold.nii.gz`,
    ])
    const plan = computeCreatePlan({
      dataset: ds,
      boldPath: `${R}/sub-01/func/sub-01_task-x_echo-1_bold.nii.gz`,
    })
    expect(plan.create[0]?.eventsPath).toBe(
      `${R}/sub-01/func/sub-01_task-x_events.tsv`,
    )
  })

  test('blocked when the run already has an events file', () => {
    const ds = makeDataset(R, [
      `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`,
      `${R}/sub-01/func/sub-01_task-x_events.tsv`,
    ])
    const plan = computeCreatePlan({
      dataset: ds,
      boldPath: `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`,
    })
    expect(plan.blocked).toBe(true)
  })

  test('blocked for a BOLD run inside an out-of-scope tree (derivatives)', () => {
    const bold = `${R}/derivatives/fp/sub-01/func/sub-01_task-x_desc-pp_bold.nii.gz`
    const ds = makeDataset(R, [bold])
    const plan = computeCreatePlan({ dataset: ds, boldPath: bold })
    expect(plan.blocked).toBe(true)
    expect(plan.warnings.join(' ')).toContain('out-of-scope')
  })

  test('blocked for a BOLD run outside the dataset root', () => {
    const bold = '/other/sub-01/func/sub-01_task-x_bold.nii.gz'
    const ds = makeDataset(R, [bold])
    const plan = computeCreatePlan({ dataset: ds, boldPath: bold })
    expect(plan.blocked).toBe(true)
    expect(plan.warnings.join(' ')).toContain('outside')
  })

  test('blocked for an un-fetched pointer run', () => {
    const ds = makeDataset(R, [
      { path: `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`, pointer: true },
    ])
    const plan = computeCreatePlan({
      dataset: ds,
      boldPath: `${R}/sub-01/func/sub-01_task-x_bold.nii.gz`,
    })
    expect(plan.blocked).toBe(true)
    expect(plan.warnings.join(' ')).toContain('pointer')
  })
})
