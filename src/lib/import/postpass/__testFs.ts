// Test helper: node:fs-backed PostPassFs adapter. Used by every bun:test
// suite in postpass/. The leading underscores keep this file out of the
// production module graph (Vite + svelte-kit pass-through filter would
// exclude it anyway given the `.test.ts` peers, but explicit > implicit).
//
// This module is NOT importable from $lib/* at runtime; it's only used
// from sibling *.test.ts files.

import { createReadStream, promises as nodeFs } from 'node:fs'
import { createGunzip } from 'node:zlib'
import type { PostPassDirEntry, PostPassFs } from './fs'

export const nodeFsPostPassAdapter: PostPassFs = {
  async exists(path: string): Promise<boolean> {
    try {
      await nodeFs.access(path)
      return true
    } catch {
      return false
    }
  },

  async readDir(path: string): Promise<PostPassDirEntry[]> {
    const entries = await nodeFs.readdir(path, { withFileTypes: true })
    return entries.map((e) => ({
      name: e.name,
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
    }))
  },

  async readTextFile(path: string): Promise<string> {
    return nodeFs.readFile(path, 'utf8')
  },

  async readPartialBytes(path: string, size: number): Promise<Uint8Array> {
    const fh = await nodeFs.open(path, 'r')
    try {
      const buf = Buffer.alloc(size)
      const { bytesRead } = await fh.read(buf, 0, size, 0)
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead)
    } finally {
      await fh.close()
    }
  },

  readPartialGzipBytes(path: string, size: number): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const source = createReadStream(path)
      const gunzip = createGunzip()
      const chunks: Buffer[] = []
      let total = 0
      let settled = false

      const settle = (value: Uint8Array | Error): void => {
        if (settled) return
        settled = true
        source.destroy()
        gunzip.destroy()
        if (value instanceof Error) reject(value)
        else resolve(value)
      }

      gunzip.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        total += chunk.length
        if (total >= size) {
          const combined = Buffer.concat(chunks)
          settle(
            new Uint8Array(
              combined.buffer,
              combined.byteOffset,
              Math.min(combined.length, size),
            ),
          )
        }
      })
      gunzip.on('end', () => {
        const combined = Buffer.concat(chunks)
        settle(
          new Uint8Array(
            combined.buffer,
            combined.byteOffset,
            Math.min(combined.length, size),
          ),
        )
      })
      gunzip.on('error', settle)
      source.on('error', settle)
      source.pipe(gunzip)
    })
  },
}
