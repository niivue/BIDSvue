// Filesystem surface the import post-pass needs. Kept separate from
// `MutateFs` (the orchestrator's write-side adapter) because the post-
// pass needs partial reads + streaming gunzip that MutateFs doesn't
// expose; mixing them would force every MutateFs consumer to grow
// methods they don't need.
//
// Production implementation lives in `tauriPostPassFs` (Tauri plugin-fs
// for raw reads + WebKit's `DecompressionStream("gzip")` for gunzip).
// Tests inject a node:fs-backed adapter.
//
// The partial-read methods are shared with the deface header probe via
// `PartialReadFs`; defining the type here and reusing it keeps the two
// modules from drifting if a future read primitive changes shape.

export interface PostPassDirEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
}

/**
 * Header-only read surface. Lives here (rather than in
 * `src/lib/deface/headerProbe.ts`) so it can be the canonical
 * partial-read contract: `PostPassFs` extends it for the import path,
 * and the deface 4D guard imports it directly. Two callers, one
 * type — adding a new partial-read method or changing semantics
 * updates one definition.
 */
export interface PartialReadFs {
  /**
   * Read the first `size` bytes of an uncompressed file. Caller may
   * receive fewer than `size` bytes if the file is shorter; the parser
   * decides whether that's a fatal error or a "skip this file" signal.
   */
  readPartialBytes(path: string, size: number): Promise<Uint8Array>
  /**
   * Read and gunzip enough of a gzip-compressed file to yield `size`
   * decompressed bytes. The implementation should stop reading from
   * disk once the decompressed-byte budget is met, so a multi-GB
   * `.nii.gz` only consumes a few KB of compressed bytes when the
   * caller asks for 348 header bytes.
   */
  readPartialGzipBytes(path: string, size: number): Promise<Uint8Array>
}

export interface PostPassFs extends PartialReadFs {
  /** Does anything (file or directory) exist at this path? */
  exists(path: string): Promise<boolean>
  /** Non-recursive directory listing. */
  readDir(path: string): Promise<PostPassDirEntry[]>
  /** Read a UTF-8 text file in full. Used for JSON sidecars. */
  readTextFile(path: string): Promise<string>
}
