import { describe, expect, test } from 'bun:test'
import {
  EVENTS_TSV_HEADER,
  buildEventsJsonScaffold,
  eventsJsonScaffoldNeeded,
} from './eventsTemplate'

describe('EVENTS_TSV_HEADER', () => {
  test('is the header-only onset/duration/trial_type body, LF', () => {
    expect(EVENTS_TSV_HEADER).toBe('onset\tduration\ttrial_type\n')
  })
})

describe('buildEventsJsonScaffold', () => {
  const out = buildEventsJsonScaffold()

  test('is valid JSON describing trial_type', () => {
    const parsed = JSON.parse(out)
    expect(parsed.trial_type).toBeDefined()
    expect(parsed.trial_type.Description).toBeString()
  })

  test('LF only, trailing newline', () => {
    expect(out.includes('\r')).toBe(false)
    expect(out.endsWith('\n')).toBe(true)
  })
})

describe('eventsJsonScaffoldNeeded', () => {
  test('needed when nothing inheritable exists', () => {
    expect(eventsJsonScaffoldNeeded('memory', [])).toBe(true)
  })
  test('needed when only a different-task sidecar exists', () => {
    expect(eventsJsonScaffoldNeeded('memory', ['task-rest_events.json'])).toBe(
      true,
    )
  })
  test('not needed when a covering sidecar exists', () => {
    expect(
      eventsJsonScaffoldNeeded('memory', ['task-memory_events.json']),
    ).toBe(false)
    expect(eventsJsonScaffoldNeeded('memory', ['events.json'])).toBe(false)
  })
})
