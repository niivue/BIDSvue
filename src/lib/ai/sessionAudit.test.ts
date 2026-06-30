import { describe, expect, test } from 'bun:test'
import {
  type AiSessionAuditRecord,
  buildAiSessionAuditLine,
} from './sessionAudit'

const rec: AiSessionAuditRecord = {
  aiSessionId: '11111111-1111-4111-8111-111111111111',
  cli: 'claude',
  datasetRoot: '/data/ds',
  startedAt: 1000,
  endedAt: 2000,
  egressBytes: 4096,
  filesRead: 3,
  bridgeReads: 1,
  appdataReadable: true,
  datasetStateReadable: false,
}

describe('sessionAudit', () => {
  test('builds a single-line JSON record with every field', () => {
    const line = buildAiSessionAuditLine(rec)
    // append_log_line rejects embedded newlines/CR/NUL.
    expect(line).not.toContain('\n')
    expect(line).not.toContain('\r')
    expect(line).not.toContain('\0')
    const parsed = JSON.parse(line)
    expect(parsed).toEqual(rec)
  })

  test('preserves the exposed-data counts + permission classes', () => {
    const parsed = JSON.parse(buildAiSessionAuditLine(rec))
    expect(parsed.egressBytes).toBe(4096)
    expect(parsed.filesRead).toBe(3)
    expect(parsed.bridgeReads).toBe(1)
    expect(parsed.appdataReadable).toBe(true)
    expect(parsed.datasetStateReadable).toBe(false)
    expect(parsed.cli).toBe('claude')
  })
})
