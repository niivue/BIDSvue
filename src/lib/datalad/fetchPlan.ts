const encoder = new TextEncoder()

export const DATALAD_GET_ARGV_BUDGET_BYTES = 256 * 1024
export const DATALAD_VERIFY_CONCURRENCY = 32

const DATALAD_GET_ARG_OVERHEAD_BYTES =
  byteLength('datalad') + byteLength('get') + 2

function byteLength(value: string): number {
  return encoder.encode(value).length
}

/**
 * Split a bulk `datalad get` request into argv-safe chunks.
 *
 * The budget is deliberately below macOS ARG_MAX so the environment and
 * Tauri's process-wrapper overhead still have room. A single over-budget path
 * is emitted as its own chunk; rejecting it here would not give the caller a
 * better recovery path than letting the OS/DataLad report the real failure.
 */
export function chunkDataladGetPaths(
  paths: readonly string[],
  budgetBytes = DATALAD_GET_ARGV_BUDGET_BYTES,
): string[][] {
  if (budgetBytes <= DATALAD_GET_ARG_OVERHEAD_BYTES) {
    throw new Error('chunkDataladGetPaths: byte budget is too small')
  }

  const chunks: string[][] = []
  let chunk: string[] = []
  let used = DATALAD_GET_ARG_OVERHEAD_BYTES

  for (const path of paths) {
    const cost = byteLength(path) + 1
    if (chunk.length > 0 && used + cost > budgetBytes) {
      chunks.push(chunk)
      chunk = []
      used = DATALAD_GET_ARG_OVERHEAD_BYTES
    }
    chunk.push(path)
    used += cost
  }

  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

/**
 * Parse the native engine's aggregate progress line —
 * `datalad_native: <fetched>/<total> files (<n> bytes transferred)` (emitted
 * on stdout) — into `{ fetched, total }`, or `null` for any other line.
 * `fetched` counts only successfully-fetched files (not failed attempts), so
 * a partial-failure batch never reads as `total/total`. Drives the StatusBar
 * aggregate bar; extracted pure for unit coverage.
 */
export function parseNativeFetchAggregate(
  line: string,
): { fetched: number; total: number } | null {
  const m = /datalad_native:\s*(\d+)\/(\d+)\s+files/.exec(line)
  if (m === null) return null
  return { fetched: Number(m[1]), total: Number(m[2]) }
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      'mapWithConcurrency: concurrency must be a positive integer',
    )
  }
  if (items.length === 0) return []

  const results = new Array<R>(items.length)
  let next = 0
  const workerCount = Math.min(concurrency, items.length)

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = next
        next++
        if (index >= items.length) return
        results[index] = await mapper(items[index], index)
      }
    }),
  )

  return results
}
