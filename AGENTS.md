# AGENTS.md — BIDSvue

Working guide for AI agents (Claude Code, Codex, …) + humans. **Root file: always-loaded, so keep it lean.** It holds only project-wide, always-relevant, non-obvious invariants. Backend/Rust gotchas live in [src-tauri/AGENTS.md](src-tauri/AGENTS.md) and frontend/Svelte gotchas in [src/AGENTS.md](src/AGENTS.md) — those load on demand when you work in those trees, so don't duplicate them here. Companion docs: [README.md](README.md) (product), [ARCHITECTURE.md](ARCHITECTURE.md) (design rationale), [LIMITATIONS.md](LIMITATIONS.md) (current-code caveats), [ROADMAP.md](ROADMAP.md) (planned work). Per-feature history + "how we got here": `git log`.

## What this is

A lean **orchestrator** for creating, inspecting, and modifying BIDS datasets. Heavy lifting is delegated to external tools (`dcm2niix`, `bids-validator-rs`, `niimath`, NiiVue, the `datalad-rs` engine, the mindgrab WebGPU model). The UI is web tech in a WebView; the compute tools are native binaries across a process boundary. When adding a feature, ask whether it belongs in the portable web front end or as a native tool — don't fuse them, and don't rebuild what those tools already do well. Resist adding Rust without measurement (see [src-tauri/AGENTS.md](src-tauri/AGENTS.md)).

The product/UI name is **BIDSvue**; the repo, npm package, and Rust crate stay `bidsvue` — don't rename without a deliberate decision.

## Status

**Current version `0.1.20260704`** — alpha; expect breaking churn. Five alpha tracks live in `main` alongside stable v0.1: **Cohort Dashboard**, **Cloud-share** (parked — see ROADMAP), **in-app TSV/text editors**, **Merge datasets**, **Task events**. Per-track scope, locked decisions, and history: [ROADMAP.md](ROADMAP.md) + `git log`.

**Updates are manual DMG re-downloads** — no outbound version check (so PRIVACY.md needn't disclose one). The version is bumped in [package.json](package.json) / [src-tauri/Cargo.toml](src-tauri/Cargo.toml) / [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) (release script asserts they match). The last shipped notarized DMG is `0.1.20260615`. **When you flip the next DMG live on GitHub Releases, change this line to "Released as a notarized macOS arm64 DMG…"** — the prior "version bumped ≠ DMG released" conflation confused a release operator.

## Stack

- **Shell:** Tauri 2. **Renderer:** Svelte 5 + TypeScript + Vite + SvelteKit (static SPA). **Rust surface:** intentionally minimal — security boundary only.
- **Package manager + runtime:** [Bun](https://bun.sh). Always `bun` / `bunx` — never `npm` / `npx` / `pnpm` / `yarn`. **Lint/format:** [Biome](https://biomejs.dev/).
- **Tauri plugins (TS, official):** `plugin-fs` / `-dialog` / `-store` / `-os`. `plugin-shell` is intentionally NOT installed — process spawning is owned by Rust.
- **i18n:** `svelte-i18n` (ICU). Catalogs `en` (source) / `pt` / `es` at `src/lib/i18n/locales/` (pt/es AI-bootstrapped, `humanReviewed:false`).
- **Validator:** `bids-validator-rs` (bundled sidecar, default) — JS `@bids/validator` 2.4.1 is an opt-in fallback. **DataLad engine:** the vendored [`datalad-rs`](https://github.com/rordenlab/datalad-rs) submodule. **Viewer:** `@niivue/niivue` (npm `1.0.0-rc.10`; the universal entry runtime-selects WebGPU with a WebGL2 fallback — see [LIMITATIONS.md](LIMITATIONS.md)).
- Bundled sidecars (`dcm2niix`, `niimath`, `bids-validator`) + optional PATH-resolved Python tools (`heudiconv`, `dcm2bids`) + in-process WebGPU mindgrab. Recompile recipes + the cross-platform sidecar matrix: [src-tauri/AGENTS.md](src-tauri/AGENTS.md).

## Workspace layout

- `src-tauri/` — Rust; the **Cargo workspace root**. `src-tauri/crates/datalad-rs` is a **git submodule** (path-dep workspace member) → `bun install` auto-initializes it (`scripts/ensure-submodules.ts`); to init by hand instead, run `git submodule update --init --recursive`. Backend gotchas: [src-tauri/AGENTS.md](src-tauri/AGENTS.md).
- `src/` — Svelte + TS renderer (browser-portable — keep it so for a future hosted deployment). Frontend gotchas: [src/AGENTS.md](src/AGENTS.md).
- Data model is plain TS structures (Map/Set/objects) — no SQLite, no IndexedDB.

## Build / lint / test

- `bun install` — deps (postinstall auto-inits git submodules via `scripts/ensure-submodules.ts` — non-fatal, noninteractive, skipped when already initialized or via `BIDSVUE_SKIP_SUBMODULES=1`; then stages sidecars + builds the offline validator bundle). Linux x86_64 is a working dev target as of 2026-06-30 (GTK-init, WebGL2 fallback, watcher-loop fixes — rationale in [src/AGENTS.md](src/AGENTS.md), [src-tauri/AGENTS.md](src-tauri/AGENTS.md), [LIMITATIONS.md](LIMITATIONS.md)).
- `bun tauri dev` — desktop app, HMR. `bun tauri build` — release bundle.
- `bun test` — Bun tests. `bun run lint` / `format` / `typecheck` (`svelte-check`) / `check-i18n`.
- **`bun run check`** — full pre-push gauntlet (validator-artifacts, lint, typecheck, i18n, bun tests, build, `cargo fmt --check`, `cargo test --workspace`). **Run before every push.**
- `bun run release:macos` — notarized macOS arm64 DMG (local; needs Apple creds + clean tree; ignored `.env.macos-release` is sourced automatically when present). `bun run bench:scanner` / `test:e2e` for the perf gate + happy-path E2E.

## Always-on invariants

- **Every mutation is reversible.** All file-modifying actions route through `src/lib/mutate/backup.ts` (`OperationContext` + JSONL `operations.log` + LIFO rollback), under a `MutationLease`. **Non-negotiable.** Mechanics + the per-call-site lease scopes + the no-clobber/recompute-under-lease rules: [src/AGENTS.md](src/AGENTS.md).
- **The renderer never spawns processes and never bypasses Tauri plugins.** All FS via `@tauri-apps/plugin-fs`; no `shell:allow-execute`. Capability is narrow at startup; runtime scope widening is token-gated; the renderer sends `(toolId, argv)` and Rust re-validates the complete argv + path. The full security-boundary contract: [src-tauri/AGENTS.md](src-tauri/AGENTS.md) + [ARCHITECTURE.md §6](ARCHITECTURE.md#6-security-boundary).
- **All per-dataset state lives under app-data, NOT inside the dataset** (`<appDataDir>/datasets/<safeKey>/`) — so BIDSvue is safe on read-only / cloud-mounted / conformance-strict datasets. (One exception: the deface pristine mirror. Detail in [src/AGENTS.md](src/AGENTS.md).)

## Working norms

- **Stay lean.** This is an orchestrator — resist building what `dcm2niix` / `bids-validator` / `niimath` / NiiVue / mindgrab already do, and resist adding Rust without a measurement.
- **Markdown: no hard-wrapping.** One paragraph (or list item) = one line; let the editor soft-wrap. When editing a `.md` with hard-wrapped paragraphs, unwrap them. Preserve blank lines between blocks.
- **Conventional commits** from the first commit. **No emoji** in source, scripts, or generated reports.
- **Version scheme `0.MINOR.YYYYMMDD`** — bump the date stamp on every released (notarized DMG) build; keep package.json / tauri.conf.json / Cargo.toml in sync.
- **Design rationale is written, not verbal** — load-bearing decisions land in the commit message and, when long-lived, in ARCHITECTURE / LIMITATIONS / ROADMAP. These three are living docs: if a code change shifts a decision, update the relevant one in the same commit. **Validate before committing** (`bun run check`); prefer fewer clean, validated commits.
