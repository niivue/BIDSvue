// Production `ImportExecutor` backed by Rust process commands + plugin-fs.
// Mirrors the layout of `$lib/deface/tauriExecutor.ts` — kept narrow so
// the orchestrator stays bun:test-friendly without coupling to Tauri.
//
// The renderer never receives shell execute permission. It sends a
// stable tool id + argv to Rust; Rust chooses the fixed executable and
// validates the complete argv shape before spawning.
//
// PATH-injection special case for dcm2bids: dcm2bids resolves its
// dcm2niix sibling via `shutil.which("dcm2niix")`, which ignores env
// vars other than PATH, so we can't pass an explicit "use this dcm2niix"
// flag. Rust prepends the bundled sidecar directory to PATH on every
// dcm2bids invocation, so `which dcm2niix` resolves to OUR bundled
// sibling rather than to whatever the user happens to have installed.
// The user-installed dcm2bids binary itself is found via the inherited
// PATH (PATH-resolved tool — `kind: 'external'`).

import { invoke } from '@tauri-apps/api/core'
import { readDir } from '@tauri-apps/plugin-fs'

import { detectSeparator } from '$lib/util/paths'
import type { ImportExecutor, ResolvedBinary } from './runImport'
import type { ImportTool } from './tools'

export interface ImportProcessAuth {
  srcDirToken: string
  destDirParentToken: string
  heuristicToken?: string
  configToken?: string
}

/**
 * Map a sidecar tool descriptor's `binaryBasename` (the user-facing
 * tool name) to the bundle entry label we keep in `ResolvedBinary` for
 * diagnostics and test parity. Rust does the real sidecar resolution.
 *
 * External tools (`kind: 'external'`) bypass this table entirely:
 * their `binaryBasename` IS the PATH binary name.
 */
const SIDECAR_NAMES: Record<string, string> = {
  dcm2niix: 'binaries/dcm2niix',
}

export function createTauriImportExecutor(
  auth: ImportProcessAuth,
): ImportExecutor {
  return {
    async resolveBinary(tool: ImportTool): Promise<ResolvedBinary> {
      if (tool.kind === 'sidecar') {
        const sidecarName = SIDECAR_NAMES[tool.binaryBasename]
        if (sidecarName === undefined) {
          throw new Error(
            `tauriImportExecutor.resolveBinary: no sidecar mapping for "${tool.binaryBasename}". Known: ${Object.keys(
              SIDECAR_NAMES,
            ).join(', ')}`,
          )
        }
        return { kind: 'sidecar', identifier: sidecarName, toolId: tool.id }
      }
      return { kind: 'external', command: tool.binaryBasename, toolId: tool.id }
    },

    async run(
      resolved: ResolvedBinary,
      argv: readonly string[],
      _cwd: string,
    ): Promise<{
      stdout: string
      stderr: string
      partialFailureWarning?: string | null
    }> {
      if (resolved.toolId === undefined) {
        throw new Error(
          'tauriImportExecutor.run: resolved binary is missing toolId',
        )
      }
      // Rust's `ProcessOutput` may include a `partialFailureWarning`
      // when dcm2niix exits with code 8 (some series failed) or 10
      // (incomplete volumes). `serde(skip_serializing_if = "Option::is_none")`
      // means the field is absent on clean success.
      return invoke<{
        stdout: string
        stderr: string
        partialFailureWarning?: string | null
      }>('run_import_process', {
        toolId: resolved.toolId,
        argv: [...argv],
        auth,
      })
    },

    async listFiles(dir: string): Promise<string[]> {
      // Recursive walk. plugin-fs's readDir returns DirEntry[] with
      // `isFile` / `isDirectory` flags; we recurse on directories and
      // collect absolute paths for every file we see. Used by the
      // orchestrator for two things: pre-flight "is destDir empty"
      // and post-flight "did the importer actually produce output".
      return walk(dir)
    },
  }
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = []
  // readDir returns entries with names only; we have to rebuild
  // absolute paths ourselves. Use a small in-place stack rather than
  // recursion to keep memory bounded on huge BIDS trees (M8 imports
  // routinely produce hundreds of files).
  //
  // Symlinks are skipped to match scanner.ts's M1 convention and to
  // close the audit's symlink-cycle hazard: `e.isDirectory` is `true`
  // for a symlink pointing at a directory, so without the isSymlink
  // check below a self-referential symlink would wedge the walk.
  //
  // Contract: the top-level `readDir(root)` MUST propagate its error
  // so the orchestrator's collision-baseline check can register the
  // failed child in `baselineFailedChildren` and fail loud on any
  // post-conversion file that lands under it. A mid-walk readDir
  // failure for a SUBDIR stays best-effort — that path can be
  // common-mode (same dir fails before and after conversion) and
  // hard-failing would break legitimate imports against datasets
  // with a noisy `.AppleDouble/` etc. somewhere deep.
  const topEntries = await readDir(root)
  const stack: string[] = []
  for (const e of topEntries) {
    if (e.isSymlink) continue
    const childPath = joinPath(root, e.name)
    if (e.isDirectory) {
      stack.push(childPath)
    } else if (e.isFile) {
      out.push(childPath)
    }
  }
  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) break
    let entries: Awaited<ReturnType<typeof readDir>>
    try {
      entries = await readDir(dir)
    } catch {
      // Best-effort for deep subdirs only — see the contract note above.
      continue
    }
    for (const e of entries) {
      if (e.isSymlink) continue
      const childPath = joinPath(dir, e.name)
      if (e.isDirectory) {
        stack.push(childPath)
      } else if (e.isFile) {
        out.push(childPath)
      }
    }
  }
  return out
}

function joinPath(dir: string, name: string): string {
  const sep = detectSeparator(dir)
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}
