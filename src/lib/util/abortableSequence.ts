/**
 * Run `step(item)` for each item sequentially, with cancellation
 * checked **between** items (never mid-step). If `signal.aborted` is
 * true before the next item begins, iteration stops and `cancelled`
 * is true in the result. The in-flight step is allowed to finish so
 * the caller can keep per-item atomic semantics (one
 * `OperationContext` per file).
 *
 * `step` errors are not caught — the caller's closure is expected to
 * wrap its own work in try/catch if it needs to collect per-item
 * failures without aborting the batch. The helper only owns the
 * abort check and the `completed` counter so its behavior stays
 * trivially testable.
 *
 * Single caller today: `defaceFilesBatch` (action layer). Lives
 * here rather than under `deface/` because the cancellation pattern
 * is generic; future batch-style action callers can reuse it.
 */
export interface AbortableSequenceOutcome {
  completed: number
  cancelled: boolean
}

export async function iterateAbortableSequence<T>(
  items: ReadonlyArray<T>,
  signal: AbortSignal | undefined,
  step: (item: T, index: number) => Promise<void>,
): Promise<AbortableSequenceOutcome> {
  let completed = 0
  let cancelled = false
  for (let i = 0; i < items.length; i++) {
    if (signal?.aborted === true) {
      cancelled = true
      break
    }
    try {
      await step(items[i] as T, i)
    } finally {
      completed++
    }
  }
  return { completed, cancelled }
}
