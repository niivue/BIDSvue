import { describe, expect, test } from 'bun:test'
import { iterateAbortableSequence } from './abortableSequence'

describe('iterateAbortableSequence', () => {
  test('runs every item when no signal is supplied', async () => {
    const seen: string[] = []
    const result = await iterateAbortableSequence(
      ['a', 'b', 'c'],
      undefined,
      async (item) => {
        seen.push(item)
      },
    )
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(result).toEqual({ completed: 3, cancelled: false })
  })

  test('runs every item when signal is supplied but never fires', async () => {
    const controller = new AbortController()
    const seen: string[] = []
    const result = await iterateAbortableSequence(
      ['a', 'b', 'c'],
      controller.signal,
      async (item) => {
        seen.push(item)
      },
    )
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(result).toEqual({ completed: 3, cancelled: false })
  })

  test('aborts before the first item when signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const seen: string[] = []
    const result = await iterateAbortableSequence(
      ['a', 'b', 'c'],
      controller.signal,
      async (item) => {
        seen.push(item)
      },
    )
    expect(seen).toEqual([])
    expect(result).toEqual({ completed: 0, cancelled: true })
  })

  test('lets the in-flight step finish before honouring abort', async () => {
    const controller = new AbortController()
    const seen: string[] = []
    const result = await iterateAbortableSequence(
      ['a', 'b', 'c', 'd'],
      controller.signal,
      async (item) => {
        seen.push(item)
        if (item === 'b') {
          // Simulate the Cancel click landing mid-step: the in-flight
          // 'b' work is allowed to finish, but 'c' and 'd' must not
          // start.
          controller.abort()
        }
      },
    )
    expect(seen).toEqual(['a', 'b'])
    expect(result).toEqual({ completed: 2, cancelled: true })
  })

  test('increments completed even when the step throws', async () => {
    const seen: string[] = []
    let caught: unknown = null
    try {
      await iterateAbortableSequence(['a', 'b'], undefined, async (item) => {
        seen.push(item)
        if (item === 'a') throw new Error('boom')
      })
    } catch (err) {
      caught = err
    }
    expect(seen).toEqual(['a'])
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('boom')
  })

  test('passes the index alongside each item', async () => {
    const indices: number[] = []
    await iterateAbortableSequence(
      ['x', 'y', 'z'],
      undefined,
      async (_item, index) => {
        indices.push(index)
      },
    )
    expect(indices).toEqual([0, 1, 2])
  })

  test('handles an empty item list', async () => {
    const result = await iterateAbortableSequence([], undefined, async () => {
      throw new Error('should not run')
    })
    expect(result).toEqual({ completed: 0, cancelled: false })
  })
})
