// Shared node:fs adapter for `MutateFs`-driven unit tests.
//
// Both `backup.test.ts` and the M6 `rename/applyPlan.test.ts` need a
// node:fs implementation of `MutateFs` so they can run under bun:test
// without spinning up Tauri. The two test files previously defined
// near-identical copies; this module is the single source of truth.
//
// The `exists` implementation handles two error shapes:
//
//   - ENOENT → the path doesn't exist.
//   - EISDIR → directories throw EISDIR from `readFile`. We treat that
//     as "exists" so the adapter answers honestly for directories.
//
// Any other error is re-thrown.
//
// **Only imported from test files.** The Tauri plugin-fs implementation
// (`tauriMutateFs` in `backup.ts`) is the one production code uses.

import {
  appendFile,
  chmod,
  copyFile,
  link,
  mkdir,
  stat as nodeStat,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import type { MutateFs } from './backup'

export const nodeMutateFs: MutateFs = {
  async exists(path) {
    try {
      await readFile(path)
      return true
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return false
      // readFile on a directory throws EISDIR; that means it exists.
      if (err.code === 'EISDIR') return true
      throw e
    }
  },
  async mkdir(path, options) {
    await mkdir(path, { recursive: options.recursive })
  },
  async readDir(path) {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))
  },
  async stat(path) {
    const s = await nodeStat(path)
    // node:fs `Stats.mode` is `st_mode` (file-type bits plus permission
    // bits). The MutateFs contract exposes the same raw value plugin-fs
    // returns — callers mask to `0o7777` before acting on it.
    return { size: s.size, mode: s.mode }
  },
  async chmod(path, mode) {
    await chmod(path, mode & 0o7777)
  },
  async readTextFile(path) {
    return await readFile(path, 'utf8')
  },
  async readFile(path) {
    const buf = await readFile(path)
    // Buffer is a Uint8Array under the hood; copy into a plain
    // Uint8Array so the return type matches the interface exactly.
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  },
  async writeTextFile(path, contents) {
    await writeFile(path, contents, 'utf8')
  },
  async appendLogLine(path, line) {
    await appendFile(path, `${line}\n`, 'utf8')
  },
  async writeTextAtomicAppData(path, contents) {
    // Tests don't model power-loss durability — a plain truncate+write
    // is the simplest faithful behaviour. The production tauri adapter
    // routes through Rust for fsync semantics.
    await writeFile(path, contents, 'utf8')
  },
  async writeFile(path, contents) {
    await writeFile(path, contents)
  },
  async copyFile(src, dst) {
    await copyFile(src, dst)
  },
  async rename(from, to) {
    await rename(from, to)
  },
  async renameNoReplace(from, to) {
    // node has no atomic no-replace rename on POSIX; model the production
    // contract's distinct error prefixes with link+unlink. `link` rejects
    // EEXIST if `to` exists (files) and EPERM/EXDEV for dirs / cross-device
    // — surface the former as the EEXIST prefix (the caller refuses to
    // overwrite) and everything else as UNSUPPORTED (the caller falls back
    // to plain rename, which handles directories and cross-device moves).
    try {
      await link(from, to)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'EEXIST') {
        throw new Error(
          `RENAME_NO_REPLACE_EEXIST: destination already exists: ${to}`,
        )
      }
      throw new Error(`RENAME_NO_REPLACE_UNSUPPORTED: ${err.message}`)
    }
    await rm(from, { force: false })
  },
  async finalizeNewFileNoReplace(src, dst) {
    // node has no no-replace rename on POSIX. Model the production
    // contract with link+unlink: link throws EEXIST if dst exists; on
    // success src is removed so callers never record an orphan temp.
    await link(src, dst)
    try {
      await rm(src, { force: false })
    } catch (err) {
      await rm(dst, { force: true }).catch(() => {})
      throw err
    }
  },
  async remove(path, options) {
    // `force: true` keeps the single-file remove tolerant of races
    // (the production Tauri plugin-fs::remove is also forgiving of
    // ENOENT). The `recursive` option lets the M8 import-undo path
    // collapse the imported dataset wholesale.
    await rm(path, { recursive: options?.recursive ?? false, force: true })
  },
}
