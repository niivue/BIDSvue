// Structured-event parser for `datalad get` stderr lines.
//
// `datalad get` emits a mix of unstructured `[INFO ] ...` lines and
// per-file event lines that follow the same shape git-annex itself
// uses for its `--json` output (DataLad re-emits them on stderr in
// text form when `--json` isn't requested):
//
//   get(ok): sub-01/anat/T1w.nii.gz (file) [from web...]
//   get(error): sub-01/anat/T1w.nii.gz (file) [unable to fetch from web]
//   copy(ok): sub-01/anat/T1w.nii.gz (file) [from web...]
//
// Parsing those per-file events lets the renderer flip the
// corresponding row's icon / clear the progress entry the moment the
// file finishes, instead of waiting for the whole spawn to return.
//
// The parser is intentionally LENIENT: anything it doesn't recognise
// (the `[INFO ]` lines, byte-count summaries, etc.) is returned as
// `{ kind: 'info' }` so the caller can still surface it as the
// generic "current activity" string. Returning `null` reserved for
// truly empty input.
//
// Path resolution: per-file events emit paths relative to the
// dataset root. We normalise to an absolute path so the caller
// can look the file up in `datasetStore.busyPaths` /
// `dataset.index.byPath` without re-doing the join elsewhere.

export type ProgressEvent =
  | { kind: 'fetched'; path: string }
  | { kind: 'failed'; path: string; reason: string }
  | { kind: 'info'; line: string }

const FETCHED_RE = /^(?:get|copy)\(ok\):\s+(\S+)/
const FAILED_RE =
  /^(?:get|copy)\(error\):\s+(\S+)(?:\s+\(file\))?\s*(?:\[(.*?)\])?/

/**
 * Parse one stderr line emitted by `datalad get`. Returns `null` for
 * empty/whitespace-only input; otherwise an event tagged with the
 * recognised kind.
 *
 * `datasetRoot` is used to resolve per-file event paths to absolute.
 * If the parsed path is already absolute (defensive — datalad never
 * emits absolute, but the validator stripping in the future might),
 * it's returned as-is.
 */
export function parseProgressLine(
  line: string,
  datasetRoot: string,
): ProgressEvent | null {
  const trimmed = line.trim()
  if (trimmed === '') return null

  const fetched = FETCHED_RE.exec(trimmed)
  if (fetched !== null) {
    return {
      kind: 'fetched',
      path: resolvePath(fetched[1], datasetRoot),
    }
  }

  const failed = FAILED_RE.exec(trimmed)
  if (failed !== null) {
    return {
      kind: 'failed',
      path: resolvePath(failed[1], datasetRoot),
      reason: (failed[2] ?? '').trim() || 'unknown',
    }
  }

  return { kind: 'info', line: trimmed }
}

function resolvePath(rel: string, datasetRoot: string): string {
  if (rel.startsWith('/')) return rel
  const trimmedRoot = datasetRoot.endsWith('/')
    ? datasetRoot.slice(0, -1)
    : datasetRoot
  return `${trimmedRoot}/${rel}`
}
