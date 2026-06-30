/**
 * Bun unit tests for the TS token-store wrapper. The Rust-side
 * envelope (size, charset, backend allowlist) is covered by
 * `src-tauri/src/share.rs` unit tests; here we only check the
 * TS-side guard layer + that the wrapper round-trips its IO.
 */

import { describe, expect, test } from 'bun:test'

import { type TokenIo, makeTokenStore } from './tokenStore'
import type { ShareBackendId } from './types'

function memoryIo(): TokenIo & { snapshot(): Record<string, string | null> } {
  const store = new Map<ShareBackendId, string>()
  return {
    put: async (backend, value) => {
      store.set(backend, value)
    },
    get: async (backend) => store.get(backend) ?? null,
    delete: async (backend) => {
      store.delete(backend)
    },
    snapshot: () => {
      const out: Record<string, string | null> = {}
      for (const id of ['brainlife', 'ebrains', 'openneuro', 'stub'] as const) {
        out[id] = store.get(id) ?? null
      }
      return out
    },
  }
}

describe('tokenStore (in-memory)', () => {
  test('put then get round-trips', async () => {
    const io = memoryIo()
    const store = makeTokenStore(io)
    await store.put('brainlife', 'abc.def.ghi')
    expect(await store.get('brainlife')).toBe('abc.def.ghi')
  })

  test('get returns null when never put', async () => {
    const store = makeTokenStore(memoryIo())
    expect(await store.get('brainlife')).toBeNull()
  })

  test('delete is idempotent', async () => {
    const store = makeTokenStore(memoryIo())
    await store.delete('brainlife')
    await store.delete('brainlife')
    expect(await store.get('brainlife')).toBeNull()
  })

  test('backends are isolated', async () => {
    const io = memoryIo()
    const store = makeTokenStore(io)
    await store.put('brainlife', 'bl')
    await store.put('ebrains', 'eb')
    await store.delete('brainlife')
    expect(await store.get('brainlife')).toBeNull()
    expect(await store.get('ebrains')).toBe('eb')
  })

  test('rejects empty value before IPC', async () => {
    const io = memoryIo()
    const store = makeTokenStore(io)
    await expect(store.put('brainlife', '')).rejects.toThrow(/empty/)
  })

  test('rejects newline / CR / NUL in value before IPC', async () => {
    const store = makeTokenStore(memoryIo())
    await expect(store.put('brainlife', 'abc\ndef')).rejects.toThrow(
      /newline|NUL/,
    )
    await expect(store.put('brainlife', 'abc\rdef')).rejects.toThrow(
      /newline|NUL/,
    )
    await expect(store.put('brainlife', 'abc\0def')).rejects.toThrow(
      /newline|NUL/,
    )
  })
})
