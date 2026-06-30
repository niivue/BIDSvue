// Shared scratch-dir allocator for the deface executors.
//
// Both the M7 sidecar deface executor (`tauriExecutor.ts`) and the mindgrab
// dilation executor (`mindgrab/tauriExecutor.ts`) need a fresh writable temp
// dir. This is the single source of truth for WHERE that dir lives and WHY,
// plus the crash-leak sweep.

import { appCacheDir } from '@tauri-apps/api/path'
import { mkdir, readDir, remove, stat } from '@tauri-apps/plugin-fs'

import { detectSeparator, stripTrailingSeparators } from '$lib/util/paths'

/** Parent of every deface scratch dir: `$APPCACHE/deface-tmp`. */
async function defaceCacheRoot(): Promise<string> {
  const cacheRoot = stripTrailingSeparators(await appCacheDir())
  return `${cacheRoot}${detectSeparator(cacheRoot)}deface-tmp`
}

// Anything older than this is from a dead run. Far longer than any real
// deface/dilate (seconds to ~30s), so an age check can never race a live run.
const STALE_MS = 60 * 60 * 1000

/**
 * Injectable filesystem seam for the sweep, so `runDefaceCacheSweep` is
 * unit-testable without plugin-fs / a real `$APPCACHE`. Production wires these
 * to plugin-fs in `sweepStaleDefaceCache`.
 */
export interface DefaceCacheSweepDeps {
  /** Direct children of `deface-tmp` (name + whether it's a directory). */
  listEntries: () => Promise<{ name: string; isDirectory: boolean }[]>
  /** mtime of child `name` in epoch ms, or null if unavailable. */
  mtimeMs: (name: string) => Promise<number | null>
  /** Recursively remove child `name`. */
  removeDir: (name: string) => Promise<void>
  /** "now" in epoch ms (injected so tests are deterministic). */
  nowMs: number
  staleMs?: number
}

/**
 * Age-gated sweep core. Removes a child iff it is a directory AND its name
 * starts with `bidsvue-` AND its mtime is older than `staleMs`. Returns the
 * names removed (for tests). A live run's dir was `mkdir`'d milliseconds ago
 * and is never near the 1h cutoff, so this can't delete a concurrent run's
 * dir — no PID/owner check needed. A null mtime (some filesystems) fails safe
 * (keep). Per-entry errors (raced removal, unreadable) are swallowed so one
 * bad entry never aborts the sweep; a failed `listEntries` (no `deface-tmp`
 * yet) yields an empty result.
 */
export async function runDefaceCacheSweep(
  deps: DefaceCacheSweepDeps,
): Promise<string[]> {
  const staleMs = deps.staleMs ?? STALE_MS
  const removed: string[] = []
  let entries: { name: string; isDirectory: boolean }[]
  try {
    entries = await deps.listEntries()
  } catch {
    return removed // no deface-tmp yet, or cache unreadable
  }
  for (const entry of entries) {
    if (!entry.isDirectory || !entry.name.startsWith('bidsvue-')) continue
    try {
      const m = await deps.mtimeMs(entry.name)
      if (m !== null && deps.nowMs - m > staleMs) {
        await deps.removeDir(entry.name)
        removed.push(entry.name)
      }
    } catch {
      // Raced removal / vanished entry / unreadable — ignore.
    }
  }
  return removed
}

/**
 * Best-effort sweep of stale `bidsvue-*` scratch dirs left by a crash /
 * SIGKILL / power loss (the happy AND error paths remove their own dir in a
 * `finally`, so only an abrupt kill leaks one). Wires plugin-fs into the pure
 * `runDefaceCacheSweep`. Fully swallowed: housekeeping must never surface.
 */
export async function sweepStaleDefaceCache(): Promise<void> {
  try {
    const root = await defaceCacheRoot()
    const sep = detectSeparator(root)
    await runDefaceCacheSweep({
      listEntries: () => readDir(root),
      mtimeMs: async (name) =>
        (await stat(`${root}${sep}${name}`)).mtime?.getTime() ?? null,
      removeDir: (name) => remove(`${root}${sep}${name}`, { recursive: true }),
      nowMs: Date.now(),
    })
  } catch {
    // No deface-tmp yet, or cache unreadable — nothing to sweep.
  }
}

/**
 * Create and return a fresh `$APPCACHE/deface-tmp/bidsvue-<prefix>-<uuid>`
 * directory.
 *
 * `$APPCACHE` (not `@tauri-apps/api/path::tempDir()`): on macOS `tempDir()`
 * returns `/var/folders/...`, which is OUTSIDE the narrowed capability
 * `fs:scope` (`$APPDATA/**` + `$APPCACHE/**` + `$RESOURCE/**`), so `mkdir`
 * there fails with "forbidden path ... not allowed on the scope for
 * `allow-mkdir`". `appCacheDir` is `~/Library/Caches/<bundle-id>/` on macOS
 * (bundle-id-scoped on every platform), is in `fs:scope`, and is the
 * OS-preferred ephemeral location. Each call gets a fresh UUID subdir so
 * concurrent runs can't collide; the caller removes it in a `finally`, and a
 * fire-and-forget `sweepStaleDefaceCache()` reclaims crash leaks.
 */
export async function defaceCacheTempDir(prefix: string): Promise<string> {
  const root = await defaceCacheRoot()
  const sep = detectSeparator(root)
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const dir = `${root}${sep}bidsvue-${prefix}-${id}`
  await mkdir(dir, { recursive: true })
  // Reclaim crash-leaked siblings, opportunistically. Fire-and-forget: never
  // let housekeeping delay (or fail) the deface the user actually asked for.
  // The dir we just created is far younger than STALE_MS, so it's safe.
  void sweepStaleDefaceCache()
  return dir
}
