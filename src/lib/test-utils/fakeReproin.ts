// Test helper: canned reproin-core bridge that records its calls.
import { writeFile } from 'node:fs/promises'
import type {
  ReproinBridge,
  ReproinOptions,
  ReproinPlan,
} from '$lib/import/reproin'

export function fakeReproinBridge(plan: Partial<ReproinPlan> = {}): {
  bridge: ReproinBridge
  calls: Array<{ root: string; exclude: string[]; options: ReproinOptions }>
} {
  const calls: Array<{
    root: string
    exclude: string[]
    options: ReproinOptions
  }> = []
  return {
    calls,
    bridge: {
      async plan(root, exclude, options) {
        calls.push({ root, exclude: [...exclude].sort(), options })
        return {
          ops: [],
          log: [],
          failures: [],
          roots: [],
          fatal: null,
          ...plan,
        }
      },
      // Stand-in transform: the temp sibling holds a marker, not voxels.
      async dropVolumes(path, indices) {
        const temp = `${path}.bidsvue-tmp-test`
        await writeFile(temp, `dropped ${indices.join(',')}`)
        return temp
      },
    },
  }
}
