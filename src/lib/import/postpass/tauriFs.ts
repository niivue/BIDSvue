// Production `PostPassFs` backed by Tauri plugin-fs for raw reads and
// WebKit's built-in `DecompressionStream("gzip")` for stream-gunzip.
// The implementation is intentionally narrow: bun:test can't drive
// Tauri's plugin layer, so there's nothing to unit-test here -- the
// orchestrator-level coverage lives in postpass/*.test.ts via the
// node:fs-backed `nodeFsPostPassAdapter`.
//
// Two non-obvious behaviours:
//
//   1. `readPartialBytes` opens a FileHandle, seeks to 0, reads `size`
//      bytes, closes. This is the same pattern runValidator.ts's lazy
//      TauriFileOpener uses for 1 KB NIfTI sniffs.
//   2. `readPartialGzipBytes` streams compressed chunks from the file
//      handle into a `DecompressionStream("gzip")` and stops the moment
//      we've collected `size` decompressed bytes -- so a multi-GB
//      `.nii.gz` only consumes a few KB of compressed input for a
//      348-byte header read.

import {
  readTextFileWithRustFallback,
  resolveSymlinkIfPresent,
} from '$lib/util/readTextFile'
import { type DirEntry, exists, open, readDir } from '@tauri-apps/plugin-fs'
import type { PostPassDirEntry, PostPassFs } from './fs'

const COMPRESSED_CHUNK = 4096

export const tauriPostPassFs: PostPassFs = {
  async exists(path: string): Promise<boolean> {
    // plugin-fs's `exists()` THROWS for paths that fall outside the
    // runtime-widened scope. Before falling all the way back to a
    // silent `false`, retry through the Rust read helper that
    // bypasses plugin-fs's broken-on-dotfile glob check (see
    // `src/lib/util/readTextFile.ts` for the full story). If THAT
    // also says the file isn't there (or genuinely errors), treat
    // it as ENOENT.
    try {
      return await exists(path)
    } catch {
      try {
        await readTextFileWithRustFallback(path)
        return true
      } catch {
        return false
      }
    }
  },

  async readDir(path: string): Promise<PostPassDirEntry[]> {
    const entries: DirEntry[] = await readDir(path)
    return entries.map((e) => ({
      name: e.name,
      isFile: e.isFile,
      isDirectory: e.isDirectory,
    }))
  },

  async readTextFile(path: string): Promise<string> {
    return readTextFileWithRustFallback(path)
  },

  async readPartialBytes(path: string, size: number): Promise<Uint8Array> {
    // Pre-resolve symlinks so the deface 4D guard (header probe via
    // `headerProbe.ts`) works on fetched DataLad annex pointers.
    // Without this, `open()`'s scope check fails on relative annex
    // symlinks the same way `stat` / `readFile` did before commits
    // 99f9072 + 037c647 wrapped them. Surfaced by the 2026-05-20
    // round-2 audit's security agent — same root cause, different
    // plugin-fs entry point.
    const handle = await open(await resolveSymlinkIfPresent(path), {
      read: true,
    })
    try {
      await handle.seek(0, 0) // SeekFrom::Start
      const buf = new Uint8Array(size)
      const bytesRead = (await handle.read(buf)) ?? 0
      return buf.subarray(0, bytesRead)
    } finally {
      // FileHandle.close is a method on the handle, not an IPC command;
      // see memory note `reference_tauri_fs_permissions`. Best-effort:
      // a missing/no-op close should not turn a successful read into a
      // failure.
      try {
        await handle.close()
      } catch {
        /* ignore */
      }
    }
  },

  async readPartialGzipBytes(path: string, size: number): Promise<Uint8Array> {
    // Same symlink pre-resolve as `readPartialBytes` above. The 4D
    // deface guard probes `.nii.gz` files through this path, so a
    // fetched DataLad pointer would otherwise fail the guard before
    // the deface tool ever runs.
    const handle = await open(await resolveSymlinkIfPresent(path), {
      read: true,
    })
    try {
      await handle.seek(0, 0)
      const ds = new DecompressionStream('gzip')
      const writer = ds.writable.getWriter()
      const reader = ds.readable.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      let eof = false
      let writeError: unknown = null

      const pumpFromDisk = async (): Promise<void> => {
        try {
          while (!eof && total < size) {
            const inBuf = new Uint8Array(COMPRESSED_CHUNK)
            const n = (await handle.read(inBuf)) ?? 0
            if (n === 0) {
              eof = true
              await writer.close()
              return
            }
            await writer.write(inBuf.subarray(0, n))
          }
        } catch (err) {
          writeError = err
          try {
            await writer.abort(err)
          } catch {
            /* ignore */
          }
        }
      }

      // Audit 2026-06-05 P3.4: cap each decompressed chunk to the
      // remaining capacity so a pathological gzip can't inflate a
      // single chunk much larger than `size` (e.g. a 348-byte header
      // request) before the loop's `total >= size` guard fires.
      // WebKit's DecompressionStream has no per-chunk size limit; a
      // hostile gzip with a giant decompressed block would otherwise
      // pin the renderer's working set. The slice keeps memory
      // bounded by `size`.
      const drainDecompressed = async (): Promise<void> => {
        while (total < size) {
          const { value, done } = await reader.read()
          if (done) return
          if (value === undefined) continue
          const room = size - total
          const slice =
            value.byteLength <= room ? value : value.subarray(0, room)
          chunks.push(slice)
          total += slice.byteLength
        }
      }

      // Run pump + drain concurrently. The pump stops feeding once we
      // have enough decompressed bytes; the drain stops reading once
      // its `total >= size` condition fires. Both then unwind.
      const pumpP = pumpFromDisk()
      await drainDecompressed()
      // Best-effort: stop accepting input. If the writer is already
      // closed (pump hit EOF), this is a no-op.
      try {
        await writer.close()
      } catch {
        /* ignore */
      }
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
      await pumpP.catch(() => {
        /* surfaced via writeError below */
      })
      if (writeError !== null && total === 0) {
        throw writeError instanceof Error
          ? writeError
          : new Error(String(writeError))
      }
      // Splice chunks into one buffer, truncated to `size`.
      const out = new Uint8Array(Math.min(total, size))
      let offset = 0
      for (const c of chunks) {
        if (offset >= size) break
        const room = size - offset
        const slice = c.byteLength <= room ? c : c.subarray(0, room)
        out.set(slice, offset)
        offset += slice.byteLength
      }
      return out
    } finally {
      try {
        await handle.close()
      } catch {
        /* ignore */
      }
    }
  },
}
