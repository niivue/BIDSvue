import { dataladRunner } from '$lib/datalad/native'
import type { DataladRunner, DataladStatusResult } from '$lib/datalad/run'
import { dataladStore } from './datalad.svelte'
import { datasetStore } from './dataset.svelte'

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

function emptyDirty(): DataladStatusResult {
  return { added: [], modified: [], deleted: [] }
}

class DataladSaveStore {
  root = $state<string | null>(null)
  status = $state<LoadState>('idle')
  dirty = $state<DataladStatusResult>(emptyDirty())
  error = $state<string | null>(null)

  get dirtyCount(): number {
    return (
      this.dirty.added.length +
      this.dirty.modified.length +
      this.dirty.deleted.length
    )
  }

  reset(): void {
    statusRequestId++
    this.root = null
    this.status = 'idle'
    this.dirty = emptyDirty()
    this.error = null
  }
}

export const dataladSaveStore = new DataladSaveStore()

let statusRequestId = 0

export async function refreshDataladStatus(
  runner: DataladRunner = dataladRunner,
): Promise<void> {
  const root = datasetStore.dataset?.root ?? null
  if (root === null || dataladStore.available !== true) {
    dataladSaveStore.reset()
    return
  }

  const requestId = ++statusRequestId
  dataladSaveStore.root = root
  dataladSaveStore.status = 'loading'
  dataladSaveStore.error = null
  try {
    const dirty = await runner.status({ datasetRoot: root })
    if (requestId !== statusRequestId || datasetStore.dataset?.root !== root) {
      return
    }
    dataladSaveStore.dirty = dirty
    dataladSaveStore.status = 'ready'
  } catch (err) {
    if (requestId !== statusRequestId || datasetStore.dataset?.root !== root) {
      return
    }
    dataladSaveStore.dirty = emptyDirty()
    dataladSaveStore.status = 'error'
    dataladSaveStore.error = err instanceof Error ? err.message : String(err)
  }
}
