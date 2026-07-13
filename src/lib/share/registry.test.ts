/**
 * Bun unit tests for the share-backend registry. `import.meta.env.DEV`
 * is undefined under `bun test`, but the fallback `NODE_ENV === 'test'`
 * branch keeps the stub visible.
 */

import { describe, expect, test } from 'bun:test'

import {
  findShareBackend,
  pickableShareBackends,
  shareBackends,
} from './registry'

describe('shareBackends', () => {
  test('registers brainlife, OpenNeuro, and EBRAINS (resolution list) in production', () => {
    const prevNode = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const ids = shareBackends().map((b) => b.id)
      expect(ids).toContain('brainlife')
      expect(ids).toContain('openneuro')
      // EBRAINS stays REGISTERED (resolvable for an existing link) even
      // though its picker tile is hidden — see pickableShareBackends below.
      expect(ids).toContain('ebrains')
      // Stub stays hidden in production.
      expect(ids).not.toContain('stub')
    } finally {
      if (prevNode !== undefined) process.env.NODE_ENV = prevNode
      // process.env coerces assignments to strings, so
      // `process.env.NODE_ENV = undefined` would leak the literal
      // string "undefined" to subsequent tests. `delete` is the only
      // way to truly unset the env var.
      // biome-ignore lint/performance/noDelete: see above
      else delete process.env.NODE_ENV
    }
  })

  test('exposes the dev-only stub backend under bun test / vite dev', () => {
    expect(shareBackends().some((b) => b.id === 'stub')).toBe(true)
  })

  test('brainlife stays visible under bun test (dev/test mode)', () => {
    expect(shareBackends().some((b) => b.id === 'brainlife')).toBe(true)
  })
})

describe('pickableShareBackends', () => {
  test('hides the EBRAINS tile (GDPR) but keeps brainlife + OpenNeuro', () => {
    const ids = pickableShareBackends().map((b) => b.id)
    expect(ids).toContain('brainlife')
    expect(ids).toContain('openneuro')
    // EBRAINS is hidden from the picker...
    expect(ids).not.toContain('ebrains')
  })

  test('EBRAINS stays resolvable even though it is not pickable (wiring kept)', () => {
    // The hidden tile must not break resolution of an existing EBRAINS link.
    expect(pickableShareBackends().some((b) => b.id === 'ebrains')).toBe(false)
    expect(findShareBackend('ebrains')?.id).toBe('ebrains')
  })
})

describe('findShareBackend', () => {
  test('returns each production backend by id', () => {
    expect(findShareBackend('brainlife')?.id).toBe('brainlife')
    expect(findShareBackend('openneuro')?.id).toBe('openneuro')
    expect(findShareBackend('ebrains')?.id).toBe('ebrains')
  })

  test('returns the dev-only stub by id', () => {
    expect(findShareBackend('stub')?.id).toBe('stub')
  })
})
