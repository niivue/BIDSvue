/**
 * Minimal POSIX USTAR archive builder.
 *
 * Brainlife's upload endpoint accepts a `tar.gz` body with
 * `?untar=true`. We hand-roll the format here so we don't have to
 * add a JS tar / gzip dependency — gzip is the WebView's
 * `CompressionStream` (see [upload.ts]), and USTAR is just a
 * sequence of 512-byte headers followed by 512-aligned file
 * contents.
 *
 * Scope: regular files only. No symlinks (DataLad pointers must be
 * fetched before upload — same posture as the deface pipeline), no
 * directories (brainlife unpacks into a flat layout; nested paths
 * inside the tar are fine because `tar -x` creates intermediate
 * directories on extract).
 *
 * Format reference:
 *   https://www.gnu.org/software/tar/manual/html_node/Standard.html
 *
 * The header is 512 bytes laid out as:
 *   0-100  name (NUL-terminated string)
 *   100-8  mode (octal string)
 *   108-8  uid
 *   116-8  gid
 *   124-12 size (octal string, NUL-terminated)
 *   136-12 mtime
 *   148-8  checksum
 *   156-1  typeflag ("0" or '\0' = regular file)
 *   157-100 linkname (unused)
 *   257-6  magic "ustar\0"
 *   263-2  version "00"
 *   265-32 uname
 *   297-32 gname
 *   329-8  devmajor
 *   337-8  devminor
 *   345-155 prefix (long-name extension)
 *   500-12 pad
 */

/** One file in the upload archive. `contents` is the in-memory
 * payload; the caller (upload.ts) reads the file once into a
 * Uint8Array and hands it to this builder. M4 is in-memory only; a
 * streaming variant is on the v0.2 wishlist (see ROADMAP). */
export interface TarEntry {
  /** Path inside the archive, e.g. `sub-01/anat/sub-01_T1w.nii.gz`.
   * Forward slashes only; lengths > 100 use the USTAR `prefix`
   * field, capped at 155 bytes for `prefix` + 100 for `name`. */
  path: string
  /** File contents. */
  contents: Uint8Array
  /** Unix mode bits (file-type bits stripped automatically). Defaults
   * to 0o644. */
  mode?: number
  /** mtime in seconds since epoch. Defaults to the current time. */
  mtimeSec?: number
}

const HEADER_SIZE = 512
const BLOCK_SIZE = 512

/**
 * Build a USTAR archive from `entries`. Returns a single
 * `Uint8Array` ready to be piped through gzip.
 *
 * Throws if any path is too long for USTAR (combined prefix+name >
 * 255). For a BIDS-typed upload that limit is generous; the longest
 * realistic path is ~80 characters.
 */
export function buildTar(entries: TarEntry[]): Uint8Array {
  // Two trailing 512-byte zero blocks terminate the archive (per
  // POSIX). We over-allocate up front and trim.
  let total = 2 * BLOCK_SIZE
  for (const e of entries) {
    total += HEADER_SIZE + alignTo(e.contents.length, BLOCK_SIZE)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const entry of entries) {
    writeHeader(out, offset, entry)
    offset += HEADER_SIZE
    out.set(entry.contents, offset)
    offset += alignTo(entry.contents.length, BLOCK_SIZE)
  }
  // The trailing two zero blocks are already 0 since `Uint8Array` is
  // zero-initialised; just advance the offset to be explicit.
  offset += 2 * BLOCK_SIZE
  return out.subarray(0, offset)
}

function writeHeader(buf: Uint8Array, offset: number, entry: TarEntry): void {
  const { name, prefix } = splitPath(entry.path)
  const enc = new TextEncoder()

  writeString(buf, offset + 0, enc.encode(name), 100)
  writeOctal(buf, offset + 100, (entry.mode ?? 0o644) & 0o7777, 7)
  writeOctal(buf, offset + 108, 0, 7) // uid
  writeOctal(buf, offset + 116, 0, 7) // gid
  writeOctal(buf, offset + 124, entry.contents.length, 11)
  writeOctal(
    buf,
    offset + 136,
    entry.mtimeSec ?? Math.floor(Date.now() / 1000),
    11,
  )
  // The checksum field is computed with all 8 bytes treated as spaces.
  for (let i = 0; i < 8; i++) buf[offset + 148 + i] = 0x20
  buf[offset + 156] = 0x30 // typeflag '0' (regular file)
  // 157..257 linkname stays zero
  buf[offset + 257] = 0x75 // 'u'
  buf[offset + 258] = 0x73 // 's'
  buf[offset + 259] = 0x74 // 't'
  buf[offset + 260] = 0x61 // 'a'
  buf[offset + 261] = 0x72 // 'r'
  buf[offset + 262] = 0x00 // NUL
  buf[offset + 263] = 0x30 // '0'
  buf[offset + 264] = 0x30 // '0'
  // 265..297 uname / 297..329 gname / 329..345 dev fields all zero
  writeString(buf, offset + 345, enc.encode(prefix), 155)

  // Compute checksum: sum of all 512 header bytes.
  let checksum = 0
  for (let i = 0; i < HEADER_SIZE; i++) checksum += buf[offset + i]
  // Write octal checksum followed by NUL + SP into the checksum field.
  writeOctal(buf, offset + 148, checksum, 6)
  buf[offset + 154] = 0x00 // NUL
  buf[offset + 155] = 0x20 // SP
}

function splitPath(path: string): { name: string; prefix: string } {
  // Normalise to forward slashes and strip a leading slash so paths
  // are archive-relative.
  const p = path.replace(/^\/+/, '').replace(/\\/g, '/')
  if (p.length === 0) throw new Error('tar: entry path is empty')
  if (p.length <= 100) return { name: p, prefix: '' }
  // Split on the last '/' that leaves <=100 chars on the right and
  // <=155 chars on the left.
  for (let i = p.length - 100; i < p.length; i++) {
    if (p[i] === '/') {
      const prefix = p.slice(0, i)
      const name = p.slice(i + 1)
      if (prefix.length <= 155 && name.length <= 100) return { name, prefix }
    }
  }
  throw new Error(
    `tar: path too long for USTAR layout (255-byte combined limit): ${path}`,
  )
}

function writeString(
  buf: Uint8Array,
  offset: number,
  bytes: Uint8Array,
  maxLen: number,
): void {
  if (bytes.length > maxLen) {
    throw new Error(
      `tar: string exceeds ${maxLen}-byte field (${bytes.length} bytes)`,
    )
  }
  buf.set(bytes, offset)
}

function writeOctal(
  buf: Uint8Array,
  offset: number,
  value: number,
  width: number,
): void {
  // USTAR represents numeric fields as `width` octal digits followed
  // by a NUL terminator (the field is `width + 1` bytes wide). The
  // value is left-padded with zeros.
  const oct = value.toString(8)
  if (oct.length > width) {
    throw new Error(
      `tar: numeric value ${value} (${oct.length} octal digits) exceeds ${width}-digit field`,
    )
  }
  const padded = oct.padStart(width, '0')
  for (let i = 0; i < width; i++) {
    buf[offset + i] = padded.charCodeAt(i)
  }
  buf[offset + width] = 0x00 // NUL terminator
}

function alignTo(value: number, alignment: number): number {
  const rem = value % alignment
  return rem === 0 ? value : value + (alignment - rem)
}

/** Gzip-compress `data` using the WebView's native `CompressionStream`.
 *
 * Returns a single `Uint8Array` containing the full gzip stream.
 * In-memory for M4 — the v0.2 streaming variant will pipe straight to
 * fetch's body. */
export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error(
      'CompressionStream is not available in this WebView; brainlife upload requires gzip support.',
    )
  }
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new CompressionStream('gzip'))
  const buffer = await new Response(stream).arrayBuffer()
  return new Uint8Array(buffer)
}
