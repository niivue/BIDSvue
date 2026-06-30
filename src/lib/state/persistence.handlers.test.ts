// Tests for the persistence error/success handler flow registered via
// setPersistenceHandlers. These exercise the debouncer-to-handler plumbing
// directly, so we can run them without any real FS by passing a write
// function that resolves or rejects synchronously.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  type PersistenceErrorKind,
  SAVE_DEBOUNCE_MS,
  _resetPersistenceForTests,
  scheduleDebouncedSave,
  setPersistenceHandlers,
} from './persistence'

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  // Reset to a known state so each test starts with no handlers and no
  // pending timers. _resetPersistenceForTests both cancels timers without
  // firing them AND unfreezes the scheduler in case a prior test
  // simulated resetApplicationData.
  setPersistenceHandlers({})
  _resetPersistenceForTests()
})

afterEach(() => {
  _resetPersistenceForTests()
  setPersistenceHandlers({})
})

describe('setPersistenceHandlers', () => {
  test('onSuccess fires once after a successful debounced write', async () => {
    let successCount = 0
    setPersistenceHandlers({
      onSuccess: () => {
        successCount++
      },
    })
    scheduleDebouncedSave('k1', 'app', () => Promise.resolve())
    await sleep(SAVE_DEBOUNCE_MS + 50)
    expect(successCount).toBe(1)
  })

  test('onError fires with the failure message and the right kind', async () => {
    const errors: Array<[PersistenceErrorKind, string]> = []
    setPersistenceHandlers({
      onError: (kind, message) => {
        errors.push([kind, message])
      },
    })
    scheduleDebouncedSave('k2', 'dataset', () =>
      Promise.reject(new Error('disk full')),
    )
    await sleep(SAVE_DEBOUNCE_MS + 50)
    expect(errors).toEqual([['dataset', 'disk full']])
  })

  test('rapid scheduling on the same key debounces to one final write', async () => {
    let writeCount = 0
    let successCount = 0
    setPersistenceHandlers({
      onSuccess: () => {
        successCount++
      },
    })
    for (let i = 0; i < 5; i++) {
      scheduleDebouncedSave('k3', 'app', () => {
        writeCount++
        return Promise.resolve()
      })
    }
    await sleep(SAVE_DEBOUNCE_MS + 50)
    expect(writeCount).toBe(1)
    expect(successCount).toBe(1)
  })

  test('different keys keep independent timers and both fire', async () => {
    const writes: string[] = []
    setPersistenceHandlers({
      onSuccess: () => {
        writes.push('ok')
      },
    })
    scheduleDebouncedSave('app', 'app', () => {
      writes.push('app-write')
      return Promise.resolve()
    })
    scheduleDebouncedSave('ds:/foo', 'dataset', () => {
      writes.push('ds-write')
      return Promise.resolve()
    })
    await sleep(SAVE_DEBOUNCE_MS + 50)
    // Both writes ran exactly once each.
    expect(writes.filter((w) => w === 'app-write')).toHaveLength(1)
    expect(writes.filter((w) => w === 'ds-write')).toHaveLength(1)
    expect(writes.filter((w) => w === 'ok')).toHaveLength(2)
  })

  test('stringifies non-Error rejections through String(...)', async () => {
    const errors: string[] = []
    setPersistenceHandlers({
      onError: (_kind, message) => {
        errors.push(message)
      },
    })
    scheduleDebouncedSave('k4', 'app', () => Promise.reject('oops'))
    await sleep(SAVE_DEBOUNCE_MS + 50)
    expect(errors).toEqual(['oops'])
  })

  test('handlers default to no-ops when never registered', async () => {
    // setPersistenceHandlers({}) clears both. A failing write should not crash
    // the test even though no error handler is wired.
    scheduleDebouncedSave('k5', 'app', () => Promise.reject(new Error('x')))
    await sleep(SAVE_DEBOUNCE_MS + 50)
    // If we got here without an unhandled rejection, the test passes.
    expect(true).toBe(true)
  })
})
