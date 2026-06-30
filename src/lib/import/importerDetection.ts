// Runtime availability detection for importer tools (M8 follow-up).
//
// Both sidecar (bundled) and external (system PATH) tools get probed
// by running `<binary> <versionArgs>` and treating a zero exit code as
// "available". Tools like heudiconv print their version on stdout;
// dcm2niix prints it in its `-h` help text. We extract a sensible
// version string for the wizard tooltip / About dialog, falling back
// to null when no `X.Y[.Z]` pattern matches.
//
// **Why probe sidecars** (changed from "always available" — round-24
// follow-up): a bundled sidecar can still be missing for a given
// target or broken for the current host.
// An unprobed wizard would claim the sidecar was available, the user
// would fill out the wizard, and only see Tauri's "binary not found
// for this target" error at Run time. Spawning `--version` once at
// wizard mount surfaces the platform mismatch up-front. Cost: one
// extra cold-start of each sidecar at first wizard mount (~50–200ms);
// downstream calls hit the cached DetectionResult.
//
// `'js'` tools (pure-TS in-process converters with no binary) still
// short-circuit to available — there's nothing to spawn.
//
// The pure `detectImporter` function takes a `VersionProbe` runner so
// it's bun:test-friendly with a stub. The Tauri-backed runner lives
// in `importerDetectionTauri.ts`.

import type { ImportTool } from './tools'

export interface VersionProbe {
  /**
   * Run `tool.binaryBasename <tool.versionArgs>` and return the
   * captured stdout/stderr + exit code. Throws only on process-spawn
   * errors (e.g. binary not on PATH) — non-zero exit codes are
   * reported via the returned `exitCode`, not by throwing.
   */
  run(tool: ImportTool): Promise<{
    exitCode: number | null
    stdout: string
    stderr: string
  }>
}

export interface DetectionResult {
  available: boolean
  /** Parsed version string (e.g. "1.3.2"), or null if no probe / unparseable output. */
  version: string | null
  /** When `available` is false, a one-line reason for the wizard tooltip. */
  error: string | null
}

/**
 * Detect availability of `tool`. `'js'` tools short-circuit to
 * available (no binary to probe); sidecars and external tools both
 * run the probe so we catch missing-for-this-platform sidecars
 * up-front rather than at Run time (see module header).
 */
export async function detectImporter(
  tool: ImportTool,
  probe: VersionProbe,
): Promise<DetectionResult> {
  if (tool.kind === 'js') {
    return { available: true, version: null, error: null }
  }
  try {
    const r = await probe.run(tool)
    if (r.exitCode === 0) {
      return {
        available: true,
        version: parseVersionString(r.stdout) ?? parseVersionString(r.stderr),
        error: null,
      }
    }
    const tail = (r.stderr || r.stdout || '')
      .trim()
      .split('\n')[0]
      ?.slice(0, 200)
    return {
      available: false,
      version: null,
      error: `${tool.binaryBasename} exited with code ${r.exitCode ?? 'null'}${
        tail ? `: ${tail}` : ''
      }`,
    }
  } catch (err) {
    return {
      available: false,
      version: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Pull a version string out of `--version` / `-h` output. Looks for
 * the first dotted-numeric token — `1.2.3`, `1.2`, or `1.0.20240202`
 * (dcm2niix's date-shaped patch). Build suffixes like `+dev` or
 * `-rc.1` are intentionally trimmed; the dotted core is plenty for a
 * dialog tooltip. Returns `null` when no dotted pattern matches.
 */
export function parseVersionString(out: string): string | null {
  if (out === '') return null
  // Drop the leading `\b`: word-boundary before a digit doesn't fire
  // when the digit follows another word char (e.g. `dcm2niix v1.0.20240202`
  // — `v1` is word-word, so `\bv1.0...` would match starting at `0.20...`
  // instead of `1.0...`). The trailing `\b` is enough to keep the match
  // from extending into a build suffix.
  const m = out.match(/(\d+\.\d+(?:\.\d+)?)\b/)
  return m ? m[1] : null
}
