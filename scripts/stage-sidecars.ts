#!/usr/bin/env bun
// Stage bundled Tauri sidecars from the committed source-of-truth at
// `resources/<platform>/<basename>` to the gitignored Tauri-lookup path
// `src-tauri/binaries/<basename>-<target-triple>`.
//
// Why this exists: a fresh `git clone` + `bun install` has no
// `src-tauri/binaries/`, so the very first `bun tauri dev` /
// `bun tauri build` blows up with
// `resource path 'binaries/<name>-<triple>' doesn't exist` from
// Tauri's externalBin staging. This script runs from `postinstall` so
// the staging happens transparently and `bun install` produces a
// buildable tree on every supported developer platform.
//
// The script is also wired into CI (`.github/workflows/ci.yml`) so the
// CI step automatically picks up new sidecars added to
// `resources/<platform>/` without anyone remembering to edit the
// workflow.
//
// Only the current host platform is touched. Supported source
// directories today are resources/darwin, resources/linux, and
// resources/windows.
//
// Idempotent: existing staged copies are overwritten only if the
// source's mtime is newer (skips a no-op `cp` on every dev start). On
// the very first run it copies unconditionally.

import { chmod, copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

interface PlatformTarget {
  /** Directory under `resources/` holding source binaries. */
  sourceDir: string
  /** Tauri target triple suffix appended to each staged binary. */
  targetTriple: string
  /** `process.platform` value this target serves. */
  hostPlatform: NodeJS.Platform
}

// Add a new entry here once we stage binaries for that platform. Keep
// in sync with `bundle.externalBin` in `src-tauri/tauri.conf.json` and
// the per-platform CI staging step.
const TARGETS: PlatformTarget[] = [
  {
    sourceDir: 'resources/darwin',
    targetTriple: 'aarch64-apple-darwin',
    hostPlatform: 'darwin',
  },
  {
    sourceDir: 'resources/linux',
    targetTriple: 'x86_64-unknown-linux-gnu',
    hostPlatform: 'linux',
  },
  {
    sourceDir: 'resources/windows',
    targetTriple: 'x86_64-pc-windows-msvc',
    hostPlatform: 'win32',
  },
]

// Tauri's externalBin lookup wants `<basename>-<triple>` on Unix and
// `<basename>-<triple>.exe` on Windows — NOT `<basename>.exe-<triple>`.
// Source files under `resources/windows/` keep their `.exe` suffix, so
// split it off the basename and re-append it after the triple.
export function stagedName(sourceName: string, targetTriple: string): string {
  const ext = sourceName.endsWith('.exe') ? '.exe' : ''
  const base = ext ? sourceName.slice(0, -ext.length) : sourceName
  return `${base}-${targetTriple}${ext}`
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function isNewer(src: string, dst: string): Promise<boolean> {
  const dstInfo = await stat(dst).catch(() => null)
  if (dstInfo === null) return true
  const srcInfo = await stat(src)
  return srcInfo.mtimeMs > dstInfo.mtimeMs
}

async function stageOne(
  target: PlatformTarget,
): Promise<{ copied: number; skipped: number }> {
  if (!(await pathExists(target.sourceDir))) {
    // Not an error: the platform's source dir simply isn't populated
    // for this checkout (e.g. we'll skip darwin staging on Linux CI
    // once Linux targets land).
    return { copied: 0, skipped: 0 }
  }
  const stagingDir = 'src-tauri/binaries'
  await mkdir(stagingDir, { recursive: true })

  const entries = await readdir(target.sourceDir, { withFileTypes: true })
  let copied = 0
  let skipped = 0
  for (const ent of entries) {
    if (!ent.isFile()) continue
    const src = join(target.sourceDir, ent.name)
    const dst = join(stagingDir, stagedName(ent.name, target.targetTriple))
    if (!(await isNewer(src, dst))) {
      skipped++
      continue
    }
    await copyFile(src, dst)
    if (target.hostPlatform !== 'win32') await chmod(dst, 0o755)
    copied++
    console.log(`[stage-sidecars] ${src} -> ${dst}`)
  }
  return { copied, skipped }
}

async function main(): Promise<void> {
  let totalCopied = 0
  let totalSkipped = 0
  for (const target of TARGETS) {
    if (process.platform !== target.hostPlatform) continue
    const { copied, skipped } = await stageOne(target)
    totalCopied += copied
    totalSkipped += skipped
  }
  if (totalCopied === 0 && totalSkipped === 0) {
    console.log(
      `[stage-sidecars] no sidecars to stage for platform=${process.platform}; add a TARGETS entry + resources/<platform>/ directory to support this host.`,
    )
    return
  }
  console.log(
    `[stage-sidecars] ${totalCopied} copied, ${totalSkipped} up-to-date.`,
  )
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(
      `[stage-sidecars] failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  })
}
