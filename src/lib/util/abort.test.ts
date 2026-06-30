import { describe, expect, test } from 'bun:test'

import { raceWithAbort } from './abort'

describe('raceWithAbort', () => {
  test('returns the wrapped promise unchanged when no signal is supplied', async () => {
    const v = await raceWithAbort(Promise.resolve(42))
    expect(v).toBe(42)
  })

  test('resolves with the wrapped value when the signal stays unaborted', async () => {
    const ac = new AbortController()
    const v = await raceWithAbort(Promise.resolve('ok'), ac.signal)
    expect(v).toBe('ok')
  })

  test('rejects synchronously when the signal is already aborted on entry', async () => {
    const ac = new AbortController()
    ac.abort()
    let neverFlipped = true
    const slow = new Promise<number>((resolve) => {
      setTimeout(() => {
        neverFlipped = false
        resolve(1)
      }, 5)
    })
    await expect(raceWithAbort(slow, ac.signal)).rejects.toThrow(/Aborted/)
    // The wrapped promise was NOT cancelled — it's still in flight.
    // Wait for it to settle and confirm the resolve callback fires.
    await slow
    expect(neverFlipped).toBe(false)
  })

  test('rejects with AbortError when the signal fires mid-flight', async () => {
    const ac = new AbortController()
    const never = new Promise<number>(() => {})
    const racer = raceWithAbort(never, ac.signal)
    queueMicrotask(() => ac.abort())
    await expect(racer).rejects.toThrow(/Aborted/)
  })

  test('propagates the wrapped promise rejection when the signal stays unaborted', async () => {
    const ac = new AbortController()
    await expect(
      raceWithAbort(Promise.reject(new Error('boom')), ac.signal),
    ).rejects.toThrow(/boom/)
  })

  test('removes the abort listener once the race resolves', async () => {
    const ac = new AbortController()
    let listenerCount = 0
    const origAdd = ac.signal.addEventListener.bind(ac.signal)
    const origRemove = ac.signal.removeEventListener.bind(ac.signal)
    ac.signal.addEventListener = ((
      ...args: Parameters<typeof origAdd>
    ): void => {
      listenerCount++
      origAdd(...args)
    }) as typeof origAdd
    ac.signal.removeEventListener = ((
      ...args: Parameters<typeof origRemove>
    ): void => {
      listenerCount--
      origRemove(...args)
    }) as typeof origRemove

    await raceWithAbort(Promise.resolve('done'), ac.signal)
    expect(listenerCount).toBe(0)
  })
})
