import { describe, expect, test } from 'bun:test'
import {
  boldPathToEventsPath,
  eventsJsonCoversTask,
  extractTaskLabel,
  isBoldJson,
  isBoldNifti,
  isEventsTsv,
  rootEventsJsonPath,
} from './eventsPaths'

describe('boldPathToEventsPath', () => {
  test('basic task run, .nii.gz', () => {
    expect(
      boldPathToEventsPath('/d/sub-01/func/sub-01_task-rest_bold.nii.gz'),
    ).toBe('/d/sub-01/func/sub-01_task-rest_events.tsv')
  })

  test('ses + acq + run entities preserved in canonical order', () => {
    expect(
      boldPathToEventsPath(
        '/d/sub-01/ses-2/func/sub-01_ses-2_task-memory_acq-hi_run-03_bold.nii',
      ),
    ).toBe(
      '/d/sub-01/ses-2/func/sub-01_ses-2_task-memory_acq-hi_run-03_events.tsv',
    )
  })

  test('.nii and .nii.gz derive the same events name', () => {
    const a = boldPathToEventsPath('/f/sub-01_task-x_bold.nii')
    const b = boldPathToEventsPath('/f/sub-01_task-x_bold.nii.gz')
    expect(a).toBe('/f/sub-01_task-x_events.tsv')
    expect(b).toBe(a)
  })

  test('multi-echo collapses to one events path (echo stripped)', () => {
    const e1 = boldPathToEventsPath('/f/sub-01_task-x_echo-1_bold.nii.gz')
    const e2 = boldPathToEventsPath('/f/sub-01_task-x_echo-2_bold.nii.gz')
    expect(e1).toBe('/f/sub-01_task-x_events.tsv')
    expect(e2).toBe(e1)
  })

  test('run-1 vs run-10 stay distinct', () => {
    expect(boldPathToEventsPath('/f/sub-01_task-x_run-1_bold.nii.gz')).toBe(
      '/f/sub-01_task-x_run-1_events.tsv',
    )
    expect(boldPathToEventsPath('/f/sub-01_task-x_run-10_bold.nii.gz')).toBe(
      '/f/sub-01_task-x_run-10_events.tsv',
    )
  })

  test('throws on non-BOLD input', () => {
    expect(() => boldPathToEventsPath('/f/sub-01_T1w.nii.gz')).toThrow()
    expect(() => boldPathToEventsPath('/f/sub-01_task-x_events.tsv')).toThrow()
  })
})

describe('isBoldNifti / isEventsTsv', () => {
  test('isBoldNifti', () => {
    expect(isBoldNifti('sub-01_task-x_bold.nii.gz')).toBe(true)
    expect(isBoldNifti('sub-01_task-x_bold.nii')).toBe(true)
    expect(isBoldNifti('/p/sub-01_task-x_echo-2_bold.nii.gz')).toBe(true)
    expect(isBoldNifti('sub-01_task-x_events.tsv')).toBe(false)
    expect(isBoldNifti('sub-01_T1w.nii.gz')).toBe(false)
    expect(isBoldNifti('sub-01_task-x_bold.json')).toBe(false)
  })

  test('isEventsTsv', () => {
    expect(isEventsTsv('sub-01_task-x_events.tsv')).toBe(true)
    expect(isEventsTsv('/p/sub-01_task-x_run-2_events.tsv')).toBe(true)
    expect(isEventsTsv('sub-01_task-x_events.json')).toBe(false)
    expect(isEventsTsv('sub-01_task-x_bold.nii.gz')).toBe(false)
  })

  test('isBoldJson', () => {
    expect(isBoldJson('sub-01_task-x_bold.json')).toBe(true)
    expect(isBoldJson('/p/task-x_bold.json')).toBe(true)
    expect(isBoldJson('sub-01_task-x_events.json')).toBe(false)
    expect(isBoldJson('sub-01_task-x_bold.nii.gz')).toBe(false)
    expect(isBoldJson('sub-01_task-x_sbref.json')).toBe(false)
  })
})

describe('extractTaskLabel', () => {
  test('returns label / null', () => {
    expect(extractTaskLabel('/p/sub-01_task-memory_bold.nii.gz')).toBe('memory')
    expect(extractTaskLabel('sub-01_T1w.nii.gz')).toBeNull()
  })
})

describe('rootEventsJsonPath', () => {
  test('joins under root, strips trailing slash', () => {
    expect(rootEventsJsonPath('/data/ds', 'memory')).toBe(
      '/data/ds/task-memory_events.json',
    )
    expect(rootEventsJsonPath('/data/ds/', 'rest')).toBe(
      '/data/ds/task-rest_events.json',
    )
  })
})

describe('eventsJsonCoversTask', () => {
  test('no-task sidecar covers every task', () => {
    expect(eventsJsonCoversTask('events.json', 'memory')).toBe(true)
  })
  test('matching task covers; different task does not', () => {
    expect(eventsJsonCoversTask('task-memory_events.json', 'memory')).toBe(true)
    expect(eventsJsonCoversTask('task-rest_events.json', 'memory')).toBe(false)
  })
  test('non-events / non-json never covers', () => {
    expect(eventsJsonCoversTask('task-memory_bold.json', 'memory')).toBe(false)
    expect(eventsJsonCoversTask('task-memory_events.tsv', 'memory')).toBe(false)
  })
  test('an ENTITY-NARROWED matching-task sidecar does NOT cover every run', () => {
    // Same task, but restricted to a run/acq/sub subset — must not suppress
    // the global root scaffold (audit follow-up 2026-06-28).
    expect(
      eventsJsonCoversTask('task-memory_run-1_events.json', 'memory'),
    ).toBe(false)
    expect(
      eventsJsonCoversTask('task-memory_acq-hi_events.json', 'memory'),
    ).toBe(false)
    expect(
      eventsJsonCoversTask('sub-01_task-memory_events.json', 'memory'),
    ).toBe(false)
  })
})
