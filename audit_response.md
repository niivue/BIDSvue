# Audit response — round 11 (2026-07-04)

Response to `audit_temp.md`. Both P1 (Merge) and P2 (Windows AI child leak) were **correct and are now fixed**, with cross-platform regressions. An independent security agent re-verified both fixes SOUND and found no other instances of the bug class. The `bun run check` gauntlet is green end-to-end on Windows (exit 0).

## P1 — Merge accepted raw Windows picker roots — CONFIRMED, now fixed

**The reviewer was right, and round 10's response over-claimed.** Round 10 said the `datasetSafeKey` separator-invariance change "also fixes the same latent bug in Merge." That was only half true: it fixed merge's app-data **keying** (so the merge is visible to History/Undo), but it did **NOT** touch the copy-scope **prefix filter**. On Windows a native picker root `C:\donor` fed to `scanDataset` yields MIXED index keys (`C:\donor/sub-01/...`), and `buildCopies`/`collectPhiWarnings` filtered those keys with `${donorRoot}${detectSeparator(donorRoot)}` (= `C:\donor\`) — so **every donor file was silently skipped** (incomplete merge, no clobber reported) and **PHI warnings were suppressed**. Windows-only, silent.

**Fix — normalize at the boundary AND make the internals POSIX-canonical (belt-and-suspenders):**

1. **Prepare boundary.** `scanMergeInputs` ([src/lib/merge/scanInputs.ts](src/lib/merge/scanInputs.ts)) now normalizes the recipient + every donor root to POSIX (`toPosixSeparators(stripTrailingSeparators(...))`) **before** `scanDataset`, so the resulting `index.byPath` keys are uniformly POSIX and the returned `MergeInputs` carries normalized roots. `MergeInputs` is constructed ONLY here (verified), so every downstream consumer inherits POSIX roots.
2. **Picker boundary.** `resolveMergeRoot` ([src/lib/state/actions.ts](src/lib/state/actions.ts)) returns `normalizeSeparators(...)` on all three paths, so the recipient/donor root stored for the lease + app-data safe-key is separator-consistent.
3. **Internals are POSIX-canonical** — no merge module derives a separator from a root anymore. `detectSeparator` is GONE from the merge tree (only comment references remain):
   - `copyScope.ts` `buildCopies` — normalizes `recRoot`, `donorRoot`, the recipient-path Set, and every indexed key before the donor prefix filter + recipient clobber check; emits POSIX copy destinations.
   - `scanInputs.ts` `collectPhiWarnings` + `gatherMergeMetadataSources` — normalize root + keys; build participants/dataset_description/sessions/.bidsignore read paths with `/` (plugin-fs/Rust accept `/` on Windows).
   - `preflight.ts` (`relativeTo`, `buildSourceManifest`, `pointerWarnings`, `overlapBlocks`), `reconcileMetadata.ts` (metadata write-targets), `applyMergePlan.ts` (op-log root, provenance + CHANGES paths) — all POSIX now, so the merge's write destinations match the POSIX copy dests and the separator-invariant safe-key.

   This directly implements the reviewer's refactoring asks #2 ("stop mixing separator detection with indexed absolute paths") and #1 (a consistent boundary for picker roots — merge now normalizes at both the picker and prepare boundaries, matching the import ACTION-boundary pattern).

4. **Adversarial regressions (reviewer's ask #3), cross-platform.** Rather than convert the on-disk end-to-end test (which round-trips through real node fs, where the root shape isn't the axis under test), I added focused unit regressions that feed **raw `C:\...` roots** and reproduce the exact mixed-key shape identically on POSIX and Windows CI:
   - `computeMergePlan.test.ts` — donor files under a `C:\d` root are still copied (POSIX `src`/`dest`); the recipient prefix set is read in POSIX space under a `C:\r` root.
   - `scanInputs.test.ts` — a PHI warning still fires under a native `C:\d` donor root with mixed-separator keys (the suppression footgun).

   The stale comment in `applyMergePlan.test.ts` (which claimed the planner keys off `detectSeparator(root)`) is corrected and points to the new regressions.

## P2 — Windows AI child could survive Job Object setup failure — CONFIRMED, now fixed

`run_ai_prompt` ([src-tauri/src/ai/spawn.rs](src-tauri/src/ai/spawn.rs)) spawned the CLI, then set up the Windows Job Object. The `?` on `child.raw_handle()` (None) and the `map_err(...)?` on `KillOnCloseJob::new()` returned **after** the spawn without `start_kill()`/`wait()` — and a tokio `Child` is not kill-on-drop — so on those (unlikely) error arms the spawned CLI leaked. Only the assign-failure arm cleaned up.

**Fix:** all three post-spawn error arms (raw-handle None, job-create fail, assign fail) now do `kill_ai_process_group(child_pid)` + `child.start_kill()` + a timed `child.wait()`, matching the existing stdout/stderr-`None` cleanup idiom. The only statement between a successful `spawn()` and a live `job_guard` is `child.id()`, so no early return skips cleanup. This is the **setup-failure** leak — distinct from the ACCEPTED assign-**race** residual (a grandchild in the pre-`AssignProcessToJobObject` microsecond window), which is unchanged and still documented in LIMITATIONS.md.

## Security re-verification (independent agent)

Both fixes **SOUND**. Swept every `detectSeparator(` call site in `src/`: no other place where a native/mixed picker root reaches a `byPath`/absolute-path prefix filter un-normalized — `dataset.root` sites are POSIX via `openDataset`; the import/mindgrab executor `detectSeparator` is the intentional native-join mirror with a normalized `destDir`; app-data/state-path builders aren't prefix filters and key on the separator-invariant safe-key. `pickMergeRecipient`/`pickMergeDonor` pass the raw `picked.path` only to `widenScopeFor` (the Rust security boundary, which compares with platform-aware `Path`) — outside this bug class — and return the normalized `resolveMergeRoot(...)` to the app. **Ranked other-hazard list: empty.**

## P2 (third finding) — Windows AI smoke remains OPEN

Acknowledged and unchanged. This changeset alters Windows CLI process containment (the Job-Object setup-failure cleanup). Windows AI stays **RELEASE-CANDIDATE / experimental** until the manual clean-VM three-CLI (Claude/Codex/Gemini) bare-chat **and** MCP-wired full-session smoke — including cancellation and app shutdown — is run and recorded. No unit test substitutes for it. This is the single remaining gate before dropping the "experimental" label.

## Verification

- `bun run check` (Windows, VS Dev shell): **green end-to-end, exit 0** — biome, svelte-check, i18n, `bun test` (2400 pass / 0 fail incl. the three new merge regressions), vite build, `cargo fmt --check`, `cargo test --workspace` (263 + 199). Doctests skipped (`doctest = false` on the `bidsvue` lib — a Tauri app crate with zero `///` examples; the empty doctest phase forced a flaky Windows tauri-rlib relink that intermittently failed `bun run check`).
- Independent security agent: both fixes SOUND; no other separator hazards; reversible-mutation invariant preserved for merge.

## Note

Round 10 caught the import keying bug but its "Merge is also fixed" claim was incomplete — it fixed the app-data key, not the copy-scope prefix filter, so a Windows merge would have silently dropped donor files and hidden PHI. Round 11 closes that (with cross-platform regressions) and removes the last separator-detection dependency from the merge internals. The changeset is green and staged; the only open gate remains the manual clean-VM AI smoke.
