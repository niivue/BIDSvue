/**
 * Race a promise against an `AbortSignal`. The returned promise rejects
 * with `DOMException('Aborted', 'AbortError')` as soon as the signal
 * fires, even if `p` is still working. The original `p` is NOT
 * cancelled (there's no JS API for that here) — it continues in the
 * background and its eventual settlement is dropped.
 *
 * Listener self-cleans once the race resolves so the AbortSignal
 * doesn't retain the callback past the original work.
 *
 * Used by `runValidator.ts` to make the outer await return immediately
 * on signal abort even when the bundled `@bids/validator` is still
 * doing pure-CPU work between IO points (the IO chokepoints already
 * honor the signal via the BIDSFile reader path; see
 * LIMITATIONS.md "Validator caveats" for the full story and
 * ROADMAP.md's v0.2 "Validator hard-cancel via Web Worker" row).
 */
export function raceWithAbort<T>(
  p: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return p
  if (signal.aborted) {
    // Suppress the eventual settlement of `p` so a late rejection
    // doesn't surface as an unhandledRejection. The caller has already
    // moved on because of the abort.
    p.catch(() => {})
    return Promise.reject(new DOMException('Aborted', 'AbortError'))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}
