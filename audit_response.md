# Audit response — round 15 (2026-07-12)

Response to `audit_temp.md` — which this round was **not** a list of issues to triage but an **implementation report**: the external auditor took a turn *writing code* across the uncommitted tree, largely closing out round-14's open items (chiefly the cross-platform niimath release-blocker) plus subprocess hardening. Two supervised agents (security+bugs, refactor) independently re-derived the diff from `git diff HEAD` and verified the auditor's claims against the actual code rather than the report. Independent ground-truth checks were run at the supervisor level too (full `bun run check`; `shasum` of the committed binaries).

**Bottom line: verified, no blocker. Ready to commit + push.** Every claim in `audit_temp.md` that touches shippable code checked out; the one genuinely new issue found is a cosmetic perf nit, not a correctness or security defect.

## Ground-truth verification (supervisor-level, not agent-reported)

- **`bun run check`: PASSED.** Biome 894 files / 0 errors / 0 warnings; `bun test` **2420 pass / 0 fail** (14 fixture skips); `svelte-check` clean; `check-i18n` parity OK; production build OK; `cargo fmt --check` clean; Rust workspace **292 pass / 0 fail / 1 ignored**; `datalad-rs` **199 pass / 0 fail / 46 ignored**.
- **niimath / dcm2niix SHA re-pin: PASSED.** Computed `shasum -a 256` of the committed binaries; all match both the report and the manifest in [scripts/fetch-sidecars.ts](scripts/fetch-sidecars.ts):
  - `resources/linux/niimath` → `ebd5a91d…700624c` ✓ (manifest line 76)
  - `resources/windows/niimath.exe` → `31092fb4…c183307` ✓ (manifest line 83)
  - `resources/windows/dcm2niix.exe` → `c5c0310b…c31982d` ✓ (manifest line 98) — the prior round-14 mismatch (`7d9ae5…` manifest vs `c8a352…` committed) is resolved; both now agree on `c5c0310b…`.

## P1 (was the sole open release-blocker) — cross-platform niimath — RESOLVED

Round 14 shipped correct macOS niimath but left Linux/Windows on stale pre-`fast` builds, so `allineate` (default "fast") silently degraded to the `-cost hel` algorithm there — same CodeValue, different math. The auditor re-pinned Linux + Windows niimath to PR #66 merge build `12-Jul-2026_g74e9bbc`, re-fetched, and updated the manifest hashes. Verified: hashes match, `cargo check` clean, deface descriptors ([src/lib/deface/tools.ts](src/lib/deface/tools.ts)) unchanged and correct. **This unblocks the release.** (Live confirmation that the Linux/Windows binaries advertise FAST-default is CI/host work — cannot be run from the macOS dev box; the mandatory cross-platform CI workspace test is the authoritative gate.)

## Verified-correct high-risk changes (security+bugs agent, independently traced)

- **`import_mne_bids.rs` subprocess** — `drain_pipe<R: Read>` head/tail bounds enforced (memory capped at `limit`; both branches fully drain to EOF → no pipe-fill deadlock); drain threads spawned *after* the Windows Job `assign` so an assign-fail early return leaks no thread; every exit path (normal / wait-error / timeout) reaps before joining; `reap_child_group`'s `kill(-pid)` is PID-reuse-safe (POSIX reserves the PID while the group is non-empty); interpreter probing correctly moved onto `spawn_blocking`.
- **`process.rs` deface allowlist** — three hardcoded variants; every fixed flag position-checked; `-cost` value locked to `hel`; `resolve_deface_spawn` rebuilds argv from canonical paths + fixed flags so zero raw renderer bytes reach the child. No injection, no new TOCTOU.
- **`actions.ts` deface/revert** — dataset/statePaths captured + null-checked *before* `await acquireLease` (no lease leak on close-during-stat); dual NIfTI+JSON leases both freshness-snapshotted and asserted; `session.sessionLive()` re-checked after async acquire; `willCreateSidecar` → real `rescanCurrentDataset` (structural), else `refreshViewerInPlace` gated on unchanged root **and** `scanGeneration` (close+reopen-same-root is a no-op).
- **`lease.ts`** — `snapshotCaptured` correctly distinguishes "snapshot not requested" (skip) from "target absent at snapshot" (a file appearing later throws `TargetMutatedError`).
- **`datasetWatcher.ts`** — `matchesExpectedSelfWrite` suppresses only exact output paths + their `.bidsvue-tmp-` atomic siblings; any unrelated path in the batch makes `every()` false → normal rescan.
- **`registry.ts` + `ShareWindow.svelte`** — one `myId` generation token threaded through `refreshLink`→`refreshStatuses`, re-checked in success + error paths; no probes after close; EBRAINS hidden from picker but still resolvable for existing links.

## New this round

- **P4 (cosmetic, NEW) — deface pristine-mirror write is not in the watcher self-write suppression set.** `defaceFile` registers only `[targetPath, sidecar]` with `suppressWatcherSelfWriteRescan`, but deface also writes the pristine original into `<root>/sourcedata/…` (inside the watched tree; `sourcedata` is not in `IGNORED_NAMES`). With auto-revalidate armed, that unsuppressed write makes `watcherEventContainsOnlySelfWrites` return false → one extra `rescanCurrentDataset()` (~800 ms later), partially defeating the flash-free optimization on the *first-ever* deface of a file. **End state is correct and safe** (rescan uses `preserveSelection`; drafts survive via the baseline no-clobber check; the deid entry is on disk). **Decision: DEFER** — it is a perf/UX nit on one path, not data loss, and adding a code change now would require re-running the full gauntlet against an otherwise-validated tree. Follow-up: add the pristine-mirror path to the suppression set.

## Accepted / for the owner (unchanged from round 14, re-confirmed)

- **P3 — `trust.rs TOKEN_TTL` 5→30 min.** Broadens the compromised-renderer window over a user-picked path, but tokens stay path-bound, non-persisted, and picker-gesture-minted; deliberate tradeoff to stop false-positive `token expired` during long import-wizard form-fills. Accepted.
- **P3 — `resolve_interpreter()` on the async executor.** Real latency (up to two 20 s probes). Deferred — moving into `spawn_blocking` needs care with the async command structure.
- **Deface mask provenance** — `resources/common/avg152T1mask.nii.gz` (~988 voxels changed before this session). The auditor added repository-local provenance for the template/mask pair ([resources/common/README.md](resources/common/README.md): upstream commit, Git blob IDs, SHA-256, engine context, replacement acceptance requirements) — this **closes** the round-14 "record provenance or revert" ask.
- **Refactor polish (all OPTIONAL, none block):** a narrow `withDefaceLeases(...)` wrapper to de-dupe the paired lease/session-gate boilerplate across `defaceFile`/`revertDefaceFile` (~25 lines, 2 call sites); hoist the twice-written `affectedPaths` idiom; a one-line `resetSelectionIfHidden()` in ShareWindow. The refactor agent confirmed the auditor's turn is **net-simplifying** (real de-dups: `deface_variant`, `drain_pipe<R>`, the `{#snippet pointerChip()}`), and re-confirmed round-14's rejected abstractions stay rejected.
- **SignPath / Windows CI** — SignPath doc now pins a reviewed action SHA + fail-closed tagged releases; Windows Rust workspace tests no longer soft-fail in the bundle workflow. The cross-platform CI run is the authoritative Windows Job-Object compile/test gate (macOS host lacks the Windows SDK).

## Verdict

No push/commit blocker from a security, correctness, or build standpoint. The round-14 sole release-blocker (cross-platform niimath) is resolved and hash-verified. Residual items are one deferred cosmetic nit, accepted tradeoffs, and optional polish. **Ready to commit + push**; the cross-platform CI run remains the authoritative post-push gate for the Windows/Linux artifacts.
