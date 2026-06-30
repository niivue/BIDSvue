// Dev-only helper: cycle BIDSvue's selection through every NIfTI in
// the currently open dataset N times so the user can watch process /
// GPU memory in Activity Monitor (or equivalent) for a leak.
//
// NiiVue 1.0.0-rc.3 doesn't expose a dispose() method; this helper is
// how we exercise the "viewer releases volumes on switch" acceptance
// criterion from decisions/M5-niivue.md without writing a full WebGL-aware
// benchmark.
//
// Bound to `window.__memorySmoke` only when `import.meta.env.DEV` is
// true so production builds never carry the surface. Pasted from the
// procedure section in decisions/M5-niivue.md:
//
//   await __memorySmoke()           // 50 iterations, 300 ms each
//   await __memorySmoke(100, 200)   // 100 iterations at 200 ms each
//
// Watch Activity Monitor's "Memory" + "GPU" columns for the BIDSvue
// process during the run. The expectation is bounded oscillation, not
// monotonic growth.

import { datasetStore } from '$lib/state/dataset.svelte'
import { selectionStore } from '$lib/state/selection.svelte'
import { isNiivueViewable } from '$lib/util/fileFormat'

interface MemorySmokeResult {
  iterations: number
  volumesPerIteration: number
  totalSwitches: number
  elapsedMs: number
}

/**
 * Cycle selection through every NIfTI in the open dataset `iterations`
 * times, pausing `intervalMs` between switches. Returns timing info
 * once the loop completes. No-op (and warns) when no dataset is open
 * or the dataset has no viewable volumes.
 *
 * Doesn't await NiiVue's loadVolumes — the M5 viewer's $effect token
 * model drops superseded loads, so we cycle as fast as the interval
 * allows and let the viewer handle the contention. That's the
 * stressful case we want to exercise anyway.
 */
async function memorySmoke(
  iterations = 50,
  intervalMs = 300,
): Promise<MemorySmokeResult | null> {
  const dataset = datasetStore.dataset
  if (dataset === null) {
    console.warn('[memory-smoke] no dataset open; nothing to cycle')
    return null
  }
  const volumes: string[] = []
  for (const node of dataset.index.byPath.values()) {
    if (node.kind !== 'file') continue
    if (!isNiivueViewable(node.extension)) continue
    volumes.push(node.path)
  }
  if (volumes.length === 0) {
    console.warn('[memory-smoke] dataset has no NIfTI / MGH volumes to cycle')
    return null
  }
  console.info(
    `[memory-smoke] cycling ${volumes.length} volumes × ${iterations} iterations (interval ${intervalMs} ms)`,
  )
  console.info(
    '[memory-smoke] open Activity Monitor (Memory + GPU columns) and watch the BIDSvue process',
  )
  const start = performance.now()
  let switches = 0
  for (let i = 0; i < iterations; i++) {
    for (const path of volumes) {
      selectionStore.setSelection(path)
      switches++
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    if ((i + 1) % 5 === 0) {
      console.info(`[memory-smoke] ${i + 1}/${iterations} iterations done`)
    }
  }
  const elapsed = performance.now() - start
  const result: MemorySmokeResult = {
    iterations,
    volumesPerIteration: volumes.length,
    totalSwitches: switches,
    elapsedMs: Math.round(elapsed),
  }
  console.info('[memory-smoke] done', result)
  return result
}

declare global {
  interface Window {
    __memorySmoke?: typeof memorySmoke
  }
}

/**
 * Attach the helper to `window`. Called once from +layout.svelte's
 * dev-only boot path. Production builds (`import.meta.env.DEV` false)
 * never import this module thanks to the conditional at the call
 * site.
 */
export function installMemorySmoke(): void {
  if (typeof window === 'undefined') return
  window.__memorySmoke = memorySmoke
  console.info(
    '[memory-smoke] window.__memorySmoke() ready — see git log around src/lib/devtools/memorySmoke.ts for the procedure',
  )
}
