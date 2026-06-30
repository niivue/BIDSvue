/**
 * Upload-id hash for OpenNeuro `prepareUpload`.
 *
 * Ported (in shape, not code) from the web UI's
 * `packages/openneuro-app/src/scripts/uploader/hash-file-list.ts`
 * (MIT-licensed). The server stores upload sessions keyed by
 * `(datasetId, uploadId)`; a deterministic hash over the file
 * list lets the WebView resume an interrupted upload by sending
 * the same `prepareUpload` again — the server `findOneAndUpdate`s
 * an existing session instead of allocating a new one.
 *
 * The hash function is intentionally weak (Java's 32-bit `hashCode`)
 * because the server doesn't trust it for anything beyond
 * idempotency / collision-detection. Any change to a file's
 * relative path or byte size produces a different uploadId, which
 * is exactly what we want for incremental push: changed files →
 * fresh upload session → server treats it as a new commit.
 */

/** Java `String.hashCode()` semantics — 32-bit signed integer hash,
 * derived char-by-char. Browser/WebView/Node all produce identical
 * output because `|0` coerces to a 32-bit signed int after every
 * step. The web UI uses this so we match its on-the-wire ids. */
function hashCode(input: string): number {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0
  }
  return h
}

/** Inputs to [hashFileList]. The web UI computes this from `File`
 * objects (with `webkitRelativePath` + `size`); we feed it the
 * dataset-relative path the walker produces and the byte size from
 * `plugin-fs::stat`. */
export interface HashFileInput {
  /** Dataset-relative POSIX path (e.g. `sub-01/anat/sub-01_T1w.nii.gz`). */
  relativePath: string
  /** File size in bytes. */
  size: number
}

/** Compute the OpenNeuro upload-session id. Identical output to the
 * web UI's `hashFileList(datasetId, files)`: lowercase hex string of
 * `Math.abs(hashCode(datasetId + sorted-entries.join(":")))`.
 *
 * Two implementations must match wire-for-wire so a resume started in
 * one client can be finished in another. Tests cross-check against the
 * web UI's reference output. */
export function hashFileList(
  datasetId: string,
  files: ReadonlyArray<HashFileInput>,
): string {
  const entries = files
    .map((f) => `${f.relativePath}:${f.size}`)
    .sort()
    .join(':')
  return Math.abs(hashCode(datasetId + entries)).toString(16)
}
