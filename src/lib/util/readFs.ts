// Read-only filesystem surfaces: `PostPassFs` for importer post-passes
// (PET, non-ReproIn scaffolding), `PartialReadFs` (partial reads +
// streaming gunzip) for the deface header probe. Production: both via
// `tauriPostPassFs`. Tests inject a node:fs-backed `PostPassFs`.

export interface PostPassDirEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
}

/** Header-only read surface (deface 4D guard). */
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

export interface PostPassFs {
  /** Does anything (file or directory) exist at this path? */
  exists(path: string): Promise<boolean>
  /** Non-recursive directory listing. */
  readDir(path: string): Promise<PostPassDirEntry[]>
  /** Read a UTF-8 text file in full. Used for JSON sidecars. */
  readTextFile(path: string): Promise<string>
}
