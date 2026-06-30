import { describe, expect, test } from 'bun:test'
import {
  applyBindToDataset,
  applyClear,
  applyEnsureSessionId,
  emptyChatState,
} from './chatLifecycle'

const stubUuid = () => '550e8400-e29b-41d4-a716-446655440000'

describe('chat lifecycle', () => {
  test('bindToDataset clears conversation when root changes', () => {
    const s = emptyChatState()
    applyBindToDataset(s, '/abs/dataset-A')
    s.conversation = [{ user: 'hi', aiText: 'hi back' }]
    s.userMessage = 'in-progress draft'
    applyEnsureSessionId(s, stubUuid)
    expect(s.conversation).toHaveLength(1)

    const changed = applyBindToDataset(s, '/abs/dataset-B')
    expect(changed).toBe(true)
    expect(s.conversation).toHaveLength(0)
    expect(s.userMessage).toBe('')
    expect(s.activeAiSessionId).toBe('')
    expect(s.boundRoot).toBe('/abs/dataset-B')
  })

  test('bindToDataset on null (dataset close) clears', () => {
    const s = emptyChatState()
    applyBindToDataset(s, '/abs/dataset-C')
    s.conversation = [{ user: 'q1', aiText: 'a1' }]
    const changed = applyBindToDataset(s, null)
    expect(changed).toBe(true)
    expect(s.conversation).toHaveLength(0)
    expect(s.boundRoot).toBeNull()
  })

  test('bindToDataset is idempotent on same root', () => {
    const s = emptyChatState()
    applyBindToDataset(s, '/abs/dataset-D')
    s.conversation = [{ user: 'q', aiText: 'a' }]
    s.userMessage = 'draft'
    const changed = applyBindToDataset(s, '/abs/dataset-D')
    expect(changed).toBe(false)
    expect(s.conversation).toHaveLength(1)
    expect(s.userMessage).toBe('draft')
  })

  test('applyClear drops state + rotates session id (next mint = new)', () => {
    const s = emptyChatState()
    applyBindToDataset(s, '/abs/dataset-E')
    s.conversation = [
      { user: 'q1', aiText: 'a1' },
      { user: 'q2', aiText: 'a2' },
    ]
    s.userMessage = 'half-typed'
    applyEnsureSessionId(s, stubUuid)
    applyClear(s)
    expect(s.conversation).toHaveLength(0)
    expect(s.userMessage).toBe('')
    expect(s.activeAiSessionId).toBe('')
    let calls = 0
    applyEnsureSessionId(s, () => {
      calls++
      return `uuid-${calls}`
    })
    expect(calls).toBe(1)
    expect(s.activeAiSessionId).toBe('uuid-1')
  })

  test('ensureSessionId is idempotent within a session', () => {
    const s = emptyChatState()
    let calls = 0
    const mint = () => {
      calls++
      return `uuid-${calls}`
    }
    const id1 = applyEnsureSessionId(s, mint)
    const id2 = applyEnsureSessionId(s, mint)
    expect(id1).toBe(id2)
    expect(calls).toBe(1)
  })
})
