// `ImportExecutor` for the headless NeuroFlow ingest: spawns the importer
// directly with node:child_process instead of asking Rust to.
//
// It follows `run_import_process` in `src-tauri/src/process.rs`:
//
//   - sidecar tools (dcm2niix-reproin, pet2bids) run BIDSvue's bundled
//     dcm2niix, `src-tauri/binaries/dcm2niix-<target triple>`, unless the
//     caller names another one;
//   - dcm2bids gets a PATH whose first entry holds a `dcm2niix` link to
//     that binary, so its `shutil.which("dcm2niix")` finds the same one;
//   - dcm2niix's partial-success exits (8: some series failed, 10:
//     incomplete volumes) resolve with a warning instead of rejecting.
//
// The Rust side also validates every argv shape because the renderer is
// untrusted. Here the caller is the person running the CLI, so the argv
// `runImport` builds is used as is.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readdir,
  readlink,
  symlink,
  unlink,
} from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { ImportExecutor, ResolvedBinary } from '$lib/import/runImport'
import type { ImportToolId } from '$lib/import/tools'

/** Exit codes dcm2niix uses for a conversion that wrote usable output. */
const PARTIAL_OK: Partial<Record<ImportToolId, ReadonlyArray<number>>> = {
  'dcm2niix-reproin': [8, 10],
  pet2bids: [8, 10],
}

const PARTIAL_KIND: Record<number, string> = {
  8: 'some series failed (kEXIT_SOME_OK_SOME_BAD)',
  10: 'incomplete volumes in one or more series (kEXIT_INCOMPLETE_VOLUMES_FOUND)',
}

/** Rust target triple for the running host, as the sidecar files are named. */
export function hostTargetTriple(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null
  if (cpu === null) return null
  if (platform === 'darwin') return `${cpu}-apple-darwin`
  if (platform === 'linux') return `${cpu}-unknown-linux-gnu`
  if (platform === 'win32') return `${cpu}-pc-windows-msvc`
  return null
}

/**
 * Pick the dcm2niix to run: an explicit path, then the sidecar bundled in
 * this checkout, then `dcm2niix` on PATH.
 */
export function resolveDcm2niix(opts: {
  explicit?: string
  repoRoot: string
  triple?: string | null
}): string {
  if (opts.explicit !== undefined && opts.explicit !== '') return opts.explicit
  const triple = opts.triple === undefined ? hostTargetTriple() : opts.triple
  if (triple !== null) {
    const ext = triple.endsWith('windows-msvc') ? '.exe' : ''
    const bundled = join(
      opts.repoRoot,
      'src-tauri',
      'binaries',
      `dcm2niix-${triple}${ext}`,
    )
    if (existsSync(bundled)) return bundled
  }
  return 'dcm2niix'
}

export interface NodeImportExecutorOptions {
  /** dcm2niix executable (path or PATH name) for sidecar tools. */
  dcm2niix: string
  /** Scratch directory for the dcm2niix PATH shim dcm2bids needs. */
  shimDir: string
  /** Receives the child's stdout and stderr as they arrive (progress for long imports). */
  onOutput?: (chunk: string) => void
}

export function createNodeImportExecutor(
  opts: NodeImportExecutorOptions,
): ImportExecutor {
  return {
    async resolveBinary(tool): Promise<ResolvedBinary> {
      if (tool.kind === 'sidecar') {
        if (tool.binaryBasename !== 'dcm2niix') {
          throw new Error(`no bundled binary for "${tool.binaryBasename}"`)
        }
        return { kind: 'sidecar', identifier: opts.dcm2niix, toolId: tool.id }
      }
      if (tool.kind === 'external') {
        return {
          kind: 'external',
          command: tool.binaryBasename,
          toolId: tool.id,
        }
      }
      throw new Error(
        `the headless ingest cannot run ${tool.id} (a ${tool.kind} importer)`,
      )
    },

    async run(resolved, argv, cwd) {
      const command =
        resolved.kind === 'sidecar' ? resolved.identifier : resolved.command
      const env = { ...process.env }
      if (resolved.toolId === 'dcm2bids') {
        const shim = await ensureDcm2niixShim(opts.shimDir, opts.dcm2niix)
        if (shim !== null)
          env.PATH = [shim, env.PATH ?? ''].filter(Boolean).join(delimiter)
      }
      const exit = await spawnCollect(command, argv, cwd, env, opts.onOutput)
      if (exit.code === 0) {
        return {
          stdout: exit.stdout,
          stderr: exit.stderr,
          partialFailureWarning: null,
        }
      }
      const partial =
        resolved.toolId === undefined ? [] : (PARTIAL_OK[resolved.toolId] ?? [])
      if (exit.code !== null && partial.includes(exit.code)) {
        const tail = exit.stderr.trim()
        const kind = PARTIAL_KIND[exit.code] ?? 'partial conversion'
        const head = `${command} exited with code ${exit.code} (${kind}); continuing with post-pass against what landed on disk.`
        return {
          stdout: exit.stdout,
          stderr: exit.stderr,
          partialFailureWarning: tail === '' ? head : `${head}\n\n${tail}`,
        }
      }
      const tail = exit.stderr.trim()
      const how =
        exit.code === null
          ? `was killed by ${exit.signal ?? 'a signal'}`
          : `exited with code ${exit.code}`
      throw new Error(
        `${command} ${how}: ${tail === '' ? '<no stderr>' : tail}`,
      )
    },

    async listFiles(dir) {
      return walkFiles(dir)
    },
  }
}

interface ChildExit {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

function spawnCollect(
  command: string,
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onOutput?: (chunk: string) => void,
): Promise<ChildExit> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...argv], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
      onOutput?.(chunk)
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
      onOutput?.(chunk)
    })
    child.on('error', (err) => {
      reject(
        new Error(`could not start ${command}: ${err.message}`, { cause: err }),
      )
    })
    child.on('close', (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    )
  })
}

/**
 * Make `<shimDir>/dcm2niix` a link to `target`. Returns the directory, or
 * null when `target` is a bare PATH name (nothing to shim).
 */
async function ensureDcm2niixShim(
  shimDir: string,
  target: string,
): Promise<string | null> {
  if (!target.includes('/') && !target.includes('\\')) return null
  await mkdir(shimDir, { recursive: true })
  const link = join(
    shimDir,
    process.platform === 'win32' ? 'dcm2niix.exe' : 'dcm2niix',
  )
  try {
    const st = await lstat(link)
    if (st.isSymbolicLink() && (await readlink(link)) === target) return shimDir
    await unlink(link)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  await symlink(target, link)
  return shimDir
}

/**
 * Recursive file listing with absolute paths, skipping symlinks — the same
 * contract as the Tauri executor's walk: the top-level read must fail
 * loudly, deeper unreadable folders are skipped.
 */
async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const stack: string[] = []
  const visit = (
    dir: string,
    entries: Awaited<ReturnType<typeof readEntries>>,
  ): void => {
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const child = join(dir, e.name)
      if (e.isDirectory()) stack.push(child)
      else if (e.isFile()) out.push(child)
    }
  }
  visit(root, await readEntries(root))
  while (stack.length > 0) {
    const dir = stack.pop() as string
    try {
      visit(dir, await readEntries(dir))
    } catch {
      // Best-effort below the top level.
    }
  }
  return out
}

function readEntries(dir: string) {
  return readdir(dir, { withFileTypes: true })
}
