// Minimal pure-TS MD5 implementation. Used by the import post-pass to
// derive the `randstr` column in `<sub>[_<ses>]_scans.tsv` so the file
// is byte-for-byte compatible with heudiconv's reproin (and with the
// upstream `reproinx.py` port that BIDSvue mirrors).
//
// Why pure TS: WebKit's `crypto.subtle.digest` deliberately does NOT
// support `'MD5'` — only SHA-1/256/384/512. Node's `node:crypto`
// supports MD5 but isn't available in the Tauri renderer. A 50-line
// pure-TS implementation is the cheapest cross-environment fit. MD5 is
// not used for security (heudiconv chose it for a stable 8-hex
// identifier per series); a future migration to SHA-256 would change
// the visible randstr value, so we match heudiconv here.
//
// Reference: RFC 1321. Implementation cross-checked against the
// "abc" → "900150983cd24fb0d6963f7d28e17f72" vector in the unit test.

const HEX = '0123456789abcdef'

/**
 * Compute the lowercase 32-character hex MD5 of a UTF-8 string. The
 * caller is responsible for choosing the right byte representation
 * (heudiconv hashes UTF-8 of the sorted concatenation of UIDs).
 */
export function md5Hex(input: string): string {
  return bytesToHex(md5Bytes(utf8Encode(input)))
}

/**
 * Lowercase first 8 hex characters of the MD5 — heudiconv's `randstr`
 * column shape. Exposed as a separate convenience so callers don't
 * have to repeat the slice and so the docstring documents the
 * deliberate length choice.
 */
export function md5Hex8(input: string): string {
  return md5Hex(input).slice(0, 8)
}

function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    out += HEX[(b >>> 4) & 0xf] + HEX[b & 0xf]
  }
  return out
}

const S: readonly number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21,
]

const K: readonly number[] = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
  0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
  0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
  0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
  0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
  0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]

function leftRotate(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c)) | 0
}

function md5Bytes(message: Uint8Array): Uint8Array {
  // Pre-processing: append `1` bit, zero-pad so total length ≡ 56
  // (mod 64) bytes (leaving 8 bytes for the 64-bit length), append
  // 64-bit length (little-endian).
  const origLenBits = BigInt(message.length) * 8n
  // After the 0x80 byte, we need zero-bytes to push total-before-length
  // to a multiple of 64 minus 8.
  const padZeros = (56 - ((message.length + 1) % 64) + 64) % 64
  const padded = new Uint8Array(message.length + 1 + padZeros + 8)
  padded.set(message)
  padded[message.length] = 0x80
  // Length as 64-bit LE.
  for (let i = 0; i < 8; i++) {
    padded[padded.length - 8 + i] = Number(
      (origLenBits >> (8n * BigInt(i))) & 0xffn,
    )
  }

  let a0 = 0x67452301 | 0
  let b0 = 0xefcdab89 | 0
  let c0 = 0x98badcfe | 0
  let d0 = 0x10325476 | 0

  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength)
  const m = new Int32Array(16)
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let j = 0; j < 16; j++) m[j] = view.getInt32(chunk + j * 4, true)
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      const temp = d
      d = c
      c = b
      b = (b + leftRotate((a + f + K[i] + m[g]) | 0, S[i])) | 0
      a = temp
    }
    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
  }

  const out = new Uint8Array(16)
  const outView = new DataView(out.buffer)
  outView.setInt32(0, a0, true)
  outView.setInt32(4, b0, true)
  outView.setInt32(8, c0, true)
  outView.setInt32(12, d0, true)
  return out
}
