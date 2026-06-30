import type { AiCliId, AiCliProbe } from './types'

export interface AiRuntimePolicyContext {
  datasetOpen: boolean
  allowHighTrustCodex: boolean
}

export function aiCliRequiresHighTrust(
  id: AiCliId,
  context: AiRuntimePolicyContext,
): boolean {
  return id === 'codex' && context.datasetOpen && !context.allowHighTrustCodex
}

export function aiCliUsable(
  id: AiCliId,
  path: string | null,
  context: AiRuntimePolicyContext,
): boolean {
  return path !== null && !aiCliRequiresHighTrust(id, context)
}

export function onlyCodexBlockedForDataset(
  probe: AiCliProbe | null,
  context: AiRuntimePolicyContext,
): boolean {
  if (
    probe === null ||
    !context.datasetOpen ||
    context.allowHighTrustCodex ||
    probe.codex.path === null
  ) {
    return false
  }
  return probe.claude.path === null && probe.gemini.path === null
}
