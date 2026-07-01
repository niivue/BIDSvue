#!/usr/bin/env bun
// Initialize/update git submodules so a fresh `git clone` + `bun install`
// produces a tree that the Rust backend can build.
//
// Why this exists: `src-tauri/crates/datalad-rs` is a git submodule and a
// path-dep workspace member. A fresh clone leaves it empty, so the first
// `bun tauri dev` / `bun tauri build` fails deep in Cargo with a confusing
// `cargo metadata ... No such file or directory` — long after `bun install`
// reported success. Running the init from `postinstall` makes the checkout
// buildable transparently, so other teams don't have to remember the
// `git submodule update --init --recursive` incantation from AGENTS.md.
//
// Non-fatal by design: the submodule is only needed for the Rust/Tauri
// build, not for frontend-only work (the renderer is browser-portable) or
// for installs from a source tarball with no `.git`. So if git is missing,
// this isn't a git checkout, or the network fetch fails, we warn and exit 0
// rather than aborting `bun install`. The eventual Cargo error remains the
// backstop for anyone who then tries to build the backend.
//
// Idempotent: `git submodule update --init --recursive` is a no-op once the
// submodules are present at the pinned commits.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

function git(args: string[], opts: { trim?: boolean } = {}): string {
  const out = execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Noninteractive + bounded so a credential/askpass/proxy prompt or a hung
    // fetch can't wedge `bun install` forever. `stdio` ignoring stdin stops the
    // basic TTY prompt, but a configured credential.helper / GIT_ASKPASS, an
    // `insteadOf` URL rewrite to ssh, or a stalled network would still block —
    // these env pins + the timeout make the call fail (caught → warn → exit 0)
    // instead of hanging. (Audit 2026-06-30 finding.)
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      SSH_ASKPASS_REQUIRE: 'never',
      GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
    },
    timeout: 120_000,
  })
  // `trim: false` for callers that need the raw output: `git submodule status`
  // prefixes each line with a SIGNIFICANT leading space (clean) / `+` / `-` /
  // `U`, and `.trim()` would strip the first line's space → a clean submodule
  // would read as dirty and the fast-path would never skip. (Audit r3.)
  return opts.trim === false ? out : out.trim()
}

/**
 * True only if EVERY `git submodule status --recursive` line is clean (space
 * prefix). git prefixes uninitialized entries with `-`, initialized-but-at-a-
 * different-commit with `+`, and merge-conflicted with `U`. We must run the
 * update on any of those — skipping a `+`/`U` would leave a stale or conflicted
 * engine checked out after a branch switch/pull. Empty input (no submodules)
 * returns false so the caller falls through rather than treating "nothing" as
 * "clean". Exported for unit testing. (Audit 2026-06-30 round 3.)
 */
export function allSubmodulesClean(status: string): boolean {
  const lines = status.split('\n').filter((line) => line.length > 0)
  return lines.length > 0 && lines.every((line) => line.startsWith(' '))
}

export function envFlagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false'
}

function main(): void {
  // Opt-out for frontend-only / renderer-only installs that never build the
  // Rust backend, so they never pay the submodule fetch. (Audit 2026-06-30.)
  if (envFlagEnabled(process.env.BIDSVUE_SKIP_SUBMODULES)) {
    console.log('[ensure-submodules] BIDSVUE_SKIP_SUBMODULES set; skipping.')
    return
  }

  // No `.gitmodules` => nothing to do (e.g. installed from a tarball).
  if (!existsSync('.gitmodules')) {
    console.log('[ensure-submodules] no .gitmodules; skipping.')
    return
  }

  // Not a git work tree (e.g. extracted source archive) => skip.
  try {
    if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') {
      console.log('[ensure-submodules] not a git work tree; skipping.')
      return
    }
  } catch {
    console.warn(
      '[ensure-submodules] git not available; skipping submodule init. The Rust/Tauri build needs `git submodule update --init --recursive`.',
    )
    return
  }

  // Cheap, LOCAL fast-path: skip the (network-touching, up-to-120s) update when
  // every submodule is already clean — the common case on every `bun install`
  // after the first clone, and it spares offline / auth-blocked trees the full
  // timeout stall. MUST only skip when fully clean: a `+` (wrong commit, e.g.
  // after a branch switch/pull advanced the pin) or `U` (conflict) still needs
  // the update, or we'd build against a stale engine. (Audit 2026-06-30 r1+r3.)
  try {
    if (
      allSubmodulesClean(
        git(['submodule', 'status', '--recursive'], { trim: false }),
      )
    ) {
      console.log(
        '[ensure-submodules] submodules already up to date; skipping.',
      )
      return
    }
  } catch {
    // status failed (older git, odd state) — fall through to the update below.
  }

  try {
    git(['submodule', 'update', '--init', '--recursive'])
    console.log('[ensure-submodules] submodules initialized/up-to-date.')
  } catch (err) {
    // Non-fatal: don't block frontend-only installs on a backend-only dep.
    console.warn(
      `[ensure-submodules] could not update submodules: ${err instanceof Error ? err.message : String(err)}\n[ensure-submodules] run \`git submodule update --init --recursive\` manually before building the Rust backend.`,
    )
  }
}

if (import.meta.main) {
  main()
}
