# BIDSvue — Roadmap

Future work only. Pairs with [LIMITATIONS.md](LIMITATIONS.md) (what shipped code can't do) and [ARCHITECTURE.md](ARCHITECTURE.md) (design rationale). Per-feature history + every "how we got here" detail lives in `git log`.

Living document: when an item lands, delete it here — shipped state belongs in AGENTS.md / ARCHITECTURE.md / LIMITATIONS.md, not here.

---

## 1. v0.2 priorities (scheduled)

The next signed cut. Items users reported or audits escalated.

| Item | Effort | Notes |
|---|---|---|
| Re-establish macOS signing identity | S | New repo needs a fresh Developer ID Application cert + a `bidsvue-notary` notarytool keychain profile before the first signed DMG. `scripts/macos-release.sh` is unchanged — only credentials. Pair with a committed public minisign key for the auto-updater. |
| Re-pin `@niivue/niivue` to npm rc.8+ | S | M-PHY0 ships a dev-loop `file:../mono/packages/niivue` spec. The release script blocks notarisation while any dep is `file:`/`link:`/`./`/`../`. Flip back to the published tag, drop the `@niivue/dev-images` `overrides` entry, drop `bunfig.toml`'s `linker = "hoisted"`. |
| Auto-updater redo | M | Build the signing harness as a standalone CLI first, dry-run minisign + notarize on a synthetic artifact, then re-enable `createUpdaterArtifacts`. (Lesson from the prior revert.) |
| Validator hard-cancel via Web Worker | M | Same scope as a future sidecar fallback. |
| Validator subprocess cancellation (Rust backend) | M | Mirror DataLad's `cancel_datalad_op` + `CancellationRegistry`: per-spawn UUID handle, `cancel_bids_validator(handle)`, SIGTERM→SIGKILL escalation. |
| Streaming TSV reader | S | Replace buffered `TauriFileOpener.stream()` with chunked `FileHandle.read()`. |
| Reproin multi-root operation history | M | Pairs with the `ImportOutput` refactor; bind app-data state to the auto-opened root, not the study-home destDir. Fixes `View > Operation history…` reading the wrong app-data dir. |
| Editor save-race shared helper | M | Extract `useEditorReseed(path, contents, savedAt)` distinguishing "last parent prop applied" from "last local save acknowledged". Fixes the visual-revert bug in `TsvEditor` + `TextEditor`. |
| Third-party-licenses panel | S | Scrollable surface separate from About (diagnostics-only). |
| Cross-platform Linux/Windows installers | M | In progress — see §2. |

### Security hardening (v1.1 cycle)

Didn't gate v0.1 but should land before 1.0 stable:

1. Symlink-aware canonicalization on the trust boundary.
2. Typed trust-set schema (purpose + createdAt + lastUsedAt).
3. Token single-use enforcement.

Plus LIMITATIONS.md §"Security limitations": operation-log path portability, PET metadata allowlist, lease-boundary path normalization, **Windows path validation in the TS layer (now relevant — cross-platform port)**, `atomicWrite.isUnderRoot` symlink resolution, `devCsp.connect-src` fixed-port narrowing.

---

## 2. v0.2+ backlog (open buckets)

### Cross-platform deployment

macOS arm64 is released locally (notarized DMG); `x86_64` macOS is permanently out of scope. Linux x86_64 + Windows x86_64 unsigned bundles build on GitHub Actions ([.github/workflows/crossplatform-bundles.yml](.github/workflows/crossplatform-bundles.yml)); committed sidecars live under `resources/{linux,windows}/` (fetched from AppVeyor via `scripts/fetch-sidecars.ts`). Remaining:

| Item | Effort | Notes |
|---|---|---|
| **Windows path-correctness pass** | M | ~41 `trust.rs`/`process.rs` tests assume POSIX absolute paths and fail on `C:\` (soft-failed in CI today). Some may be real Windows bugs in trust/argv/path validation, not just test assumptions — audit before a real Windows release. |
| Windows signing (Authenticode) | M | Needs a CI-capable signing service (Azure Trusted Signing / DigiCert KeyLocker / SSL.com eSigner) or a self-hosted runner with the token. A FIDO2 login key is NOT a code-signing credential. Ship unsigned until resolved. |
| Linux signing / packaging breadth | M | AppImage + `.deb` build today; add `.rpm`; document `webkit2gtk-4.1` in install instructions. |
| Windows MSI (after NSIS) | M | NSIS ships first; MSI for managed institutional deployment. |
| `dcm2niix` version parity across platforms | S | AppVeyor dev `dcm2niix` (`20260622`) lags the local macOS binary (`20260627`); decide whether platforms must match. |
| `dcm2bids` re-bundle per platform | M | PATH-resolved today (`pip install dcm2bids`). To bundle, revert the unbundle commit + add Linux/Windows Nuitka builders. |

### Cohort Dashboard — remaining phases

Phases 5 (subject × modality matrix), 6 (BOLD detail), 7 (participants viewer/editor). Open P3s: numeric panel ignores BIDS inheritance (label "local sidecar only" or resolve on demand); inheritance is O(BOLD × all files) — pre-index by (suffix, directory) when latency surfaces; non-BOLD sidecar parse errors swallowed; "Bytes" counter is `—` for non-DataLad; primary-record scope is MRI/PET only; dashboard button hidden during multi-row selection; serial sidecar reads in `aggregate.ts` (defer perf to the data-shape pass).

### i18n — Portuguese + Spanish follow-ups

`pt` + `es` shipped (AI-bootstrapped, `humanReviewed: false`; parity enforced by `bun run check-i18n`). Open:
- **Phase 4 — native-speaker review** (not a beta gate): reviewers tick `humanReviewed: true`; the Preferences hint clears per-locale when all entries pass.
- **Native-menu localisation** (v0.3): needs a runtime menu rebuild on locale change. Menus pass literal strings to Tauri's `Menu.popup()` today (English-only by policy).
- **Hard-coded-English audit** outside Svelte templates: `src/lib/share/*/upload.ts` progress strings, `formatTtl`/`formatBytes`, backend error strings, Tauri dialog titles. Classify each as localizable / upstream-technical / canonical-BIDS; route the localizable through `$_()`.
- **Plural-aware audit** of legacy keys (new keys use `{n, plural, …}`).
- Additional locales (Mandarin / French / …) after the review workflow proves out.

### Editor backlog

- **Across-app dirty-warn**: opening a new dataset / running an import while a TsvEditor / TextEditor / SidecarEditor has unsaved edits silently discards them.
- **Rename `'sidecarEdit'` OpType** — the text-file write path is legacy-named.
- Save-race shared helper (also §1).

### Format coverage

| Item | Effort | Notes |
|---|---|---|
| PET ECAT (`.v`) input (M13) | M | ~509 LOC port of `pypet2bids/read_ecat.py` + `ecat2nii.py` to TS. |
| Additional MEG vendors | S/vendor | One parser module + dispatch entry each. |
| EEG importer set | M/vendor | Start with BrainVision (`.vhdr`) + EDF. |

### MNE-BIDS importer — v2 + follow-ups

v1 shipped (interpreter-gated; single-file `.fif`/`.edf`/`.bdf`; empty-destination only; designed against MNE-BIDS). Open:

| Item | Effort | Notes |
|---|---|---|
| Existing-dataset merge | M | v1 imports into an empty destination only; root / `participants.tsv` / `*_scans.tsv` / leaf merge policy (+ tests) must land before multi-file import. Couples to the Merge feature's policy. |
| Companion-file formats | S/vendor | BrainVision `.vhdr`+`.vmrk`, EEGLAB `.set`+`.fdt`. One golden test per format. |
| Directory-based MEG | M/vendor | CTF `.ds`, KIT, BTi/4D. |
| Mocked + real-sample E2E | S | **Manual release gate**: before any MNE-BIDS-enabled DMG, run conversion against the MNE sample dataset and record interpreter path + versions + platform (CI uses a mock; real MNE isn't bundled). |

### Merge datasets — v2 Harmonize + v1 follow-ups

v1 shipped the in-place, preview-first, reversible core. Open:

| Item | Effort | Notes |
|---|---|---|
| **Harmonize** (the big one) | L | Detect scans sharing a BIDS filename pattern but differing acquisition parameters (Parameter Groups); distinguish Dominant vs Variant; offer `acq-VARIANT…` relabeling via the rename engine. v1 detects only file-path clobbers + metadata field conflicts. |
| Changed-subject validation pass | M | `changedRecipientSubjects(plan)` scopes it; wire a post-apply validator run + record real counts (today `not-run`). |
| Created-tree-aware merge undo | S | Undo leaves empty `sub-XX/anat/` dirs; record new top-level dirs so undo rmdirs them (mind the `undoOperation` created-tree short-circuit). |
| Session auto-promotion | M | Convert two sessionless same-person subjects into explicit `ses-*` so the same-person fold v1 refuses becomes possible. |
| Per-field conflict resolution UI | S | v1 uses a batch keep-recipient/keep-donor policy; add per-field override in the preview. |
| Root-artifact `copy-donor-as-supplement` | S | v1 refuses root clobbers; the supplement policy (`sourcedata/bidsvue_merge_artifacts/`) is specced but the executor only handles subject/metadata writes. |
| External-symlink + dereference policy | S | Preflight flags unfetched DataLad pointers; generic external-symlink detection is deferred. |
| DataLad save after merge | S | Optional `datalad save` commit after the reversible apply. |

### Task events — v2 + follow-ups

v1 shipped create / clone-where-missing / TaskName-backfill + the `author-events` AI prompt. Open:

| Item | Effort | Notes |
|---|---|---|
| **Vendor-log parsing** (the big one) | L | PsychoPy / Presentation / E-Prime log → `_events.tsv` with a column-mapping step. bidscoin + ezBIDS territory; v1 ships no parser (the AI prompt is the stopgap). |
| Localize the events UI | S | Clone dialog + context-menu entries are English-only in v1; route through `$_()` + pt/es if it graduates from alpha. |
| Per-run clone narrowing | S | Scope a clone to one subject/session, or a per-run create/overwrite toggle. |
| Events column templates | M | Reusable named column schemas seeding `trial_type` `Levels`. |
| HED integration | M | Validate / author HED tags in `_events.json`. |
| Onset/duration QA | M | Warn on overlapping/negative onsets or durations exceeding scan length. |
| Events-aware privacy scan | S | Extend the AI `find-dates` prompt to events columns. |

### AI integration follow-ups (alpha — default-on; disable via `VITE_BIDSVUE_ENABLE_AI=0` + `BIDSVUE_DISABLE_AI=1`)

In-app assistant running Claude Code / Codex / Gemini CLIs or direct OpenAI-compatible endpoints against the dataset, via a BIDSvue MCP server (CLIs) or an app-owned tool-call loop (direct). Every mutation routes through `MutationLease` + `OperationContext` + `operations.log` with a human Approve/Reject gate. **Windows ships without AI** (the MCP control bridge is a Unix-domain socket; `run_ai_prompt` refuses on Windows). Pending:

1. **Write-approval freshness lease** (top safety item) — approvals re-plan at approve time; capture target existence/mtime/size at preview and recheck before mutate (`acquireLease({snapshotFreshness})`), refusing with a re-preview message on mismatch.
2. **`ReadPolicy` struct** — consolidate the per-session 64 MiB egress cap, JSON-RPC frame cap, session-config size cap onto `ServerContext`; charge before serialization.
3. **`AiChildSession` RAII guard** — one struct owning session dir + cancellation registration + child + stream tasks (closes the exception-safe-cleanup + channel-send-leak + register-error paths).
4. **M-AI4 real bodies** — `get_dataset_summary` / `run_validator` / `get_validator_issues` (today hard-error stubs).
5. **Hardened-runtime smoke** — full notarized DMG → Finder-launch → spawn CLI → CLI spawns `bidsvue --mcp-server` → assert no FD-plumbing deadlock.
6. **HistoryDialog UI** — surface AI-session groups + revert + intervening-conflict refusal.
7. **Windows AI (deferred)** — port the control bridge to Windows named pipes (`tokio::net::windows::named_pipe`) if Windows AI is wanted; both ends are our binary.

### DataLad backlog

Native `datalad-rs` is the only DataLad path (reported in-app as `bidsvue-annex`; no Python `datalad`, no host `git-annex`). Open follow-ups:

- **M-DL12 "Update from upstream" UI** — engine + TS plumbing shipped; wire the HistoryDialog action (lease around `nativeUpdate`, `operations.log` `datalad-update` entry threading `result.backend`) + a durable half-applied-FF recovery marker (`.git/BIDSVUE_PENDING_FF`).
- **TOCTOU** between `compute_status` / `index_differs_from_head` / apply — re-run both precondition checks immediately before `apply_resolved_plan`.
- **Non-commit HEAD typed token** — peel-to-commit check + `UpdateRefusal::NonCommitHead` if HEAD is a tag.
- **Aggregate blob memory cap** — preflight buffers every changed blob; stream to per-file temps under `.git/bidsvue-update-tmp/` (mirror `fetch.rs` `TempFileGuard`).
- **File ↔ directory transitions** — build a virtual post-delete worktree view in preflight.
- **`validate_clone_url`** — drop plaintext `http://`; tighten path char rules.
- **M-DL15 RIA `ria+ssh://` fetch** + probe classifier surfacing `ssh://` origins when ssh-agent is detected.
- Refactors: `worktree_apply.rs` extraction (shared by `update.rs`+`revert.rs`); `withCancelHandle<T>` renderer helper; index pending reconcile once; scanner partial-snapshot cost.
- Wishlist (no milestone): nested `.gitmodules` recursion; whereis-aware `contentPresent`; validate past pointer files; committed `tests/fixtures/tiny-datalad/`; per-row Cancel buttons.

### Cloud share (alpha — distant / potential goal)

Three paste-in-token backends exist behind the Share… modal (brainlife / OpenNeuro / EBRAINS), but cloud publishing is **not a near-term focus**. Detailed pipeline history belongs in `git log`; keep the live backlog to the load-bearing follow-ups:

- **Streaming uploads** — brainlife builds its tar.gz in WebView memory (multi-GB OOM; ~1 GB/scan ceiling). OpenNeuro + EBRAINS already stream via Rust. Needs a Rust streaming tar builder.
- **OpenNeuro deletes UX** — `pushUpdate` refuses `deleted.length > 0`; needs a confirm-before-remove panel.
- **EBRAINS incremental `diff`/`pushUpdate`** — persist per-node KG IRIs in `share.json`, diff, PUT-by-id.
- **Server-side bids-validator pre-flight** — disable Upload when local validator errors > 0.
- **Per-backend hardening** — brainlife multi-subject manifest collisions + sidecar invisibility; upload byte-identity lease; `getAuthStatus()` AbortSignal; per-panel (not modal-wide) `linkLoadError`.

### Structural refactors

- **`ImportOutput` (multi-root imports)** *(L)* — return `{ roots: string[]; … }`; wizard picks which to auto-open. Reproin multi-root + future multi-vendor PET both need it.
- **Importer typed-policy descriptor** *(M)* — `{ argvBuilder, postPass, scaffolding, cleanup }` makes a fifth importer declarative.
- **Split `rootScaffolding.ts`** (~880 LOC) into `participants.ts` + `taskBold.ts` + `datasetDescription.ts` (only if a fifth scaffolding pass appears).
- **Post-pass per-root context object** *(M)* — `{root, provenance, failures, physio, cleanup, destructiveSkips}` makes the cross-pass counter-read data-loss class (the 2026-06-11 H1 physio bug) structurally impossible.
- **Extract remaining shared validators out of `process.rs`** *(S)* — move `validate_abs_path` and importer path helpers into a small validation module. Clone URL validation already lives in `datalad-rs`.
- **`finalizeUpload(datasetRoot, result, io)` helper** *(S)* — the 3-backend `writeShareState → clearIntent → backendMeta-merge` block is open-coded thrice.
- **Shared NiiVue viewer lifecycle helper** *(M)* — `NiivueViewer` + `SpectroscopyViewer` duplicate ~60 LOC of lifecycle + ~80 LOC of CSS; extract when a third overlay viewer arrives.
- **Per-(path, mtime) probe cache for `probeNiftiKind`** *(XS)* — defer until a tester reports arrow-paging latency.

---

## 3. Open-ended ideas (for discussion, not commitment)

When one is adopted, move it into §1 or §2 and delete it here.

### User workflows we don't yet cover

- **Preparing a dataset to share** — "Is this ready?" checks: license, authors, funding, DOI, README, CHANGES, PHI, deface coverage, DataLad clean+pushed.
- **Understanding the whole cohort** — which subjects miss which modalities, run-count consistency, TR values across BOLD, participants.tsv review.
- **Maintaining dataset documentation** — README / CHANGES / LICENSE / dataset_description as one coherent editing area.
- **Running the next tool** — MRIQC / fMRIPrep / QSIPrep / MNE-BIDS-pipeline launcher via Docker / Singularity / Podman.
- **Reviewing scan quality** — pass/warning/fail marks, notes, anatomical mosaic, original-vs-defaced compare, QC TSV export.
- **Repeating the same import** — saved import recipes + dry-run report.
- **Collaborating with DataLad** — higher-level "where's the content / is it pushed / ready for another site" view.
- **Viewing/editing cloud-hosted datasets** — hosted BIDSvue (a second deployment model).
- **Tracking human review decisions** — accepted warnings, follow-up notes, exception flags; in app-data, exportable.
- **Helping new BIDS users** — validator-message-to-spec links, plain-language code explanations, hover help for entities.

### Specific feature ideas

| # | Idea | Effort |
|---|---|---|
| 1 | "Ready to share" dashboard | M |
| 2 | Dataset search and filters | S-M |
| 3 | Drag-and-drop dataset onto the launch screen | S |
| 4 | Validator explanation panel | S |
| 5 | Cohort matrix view | M |
| 6 | Root metadata editor | M |
| 7 | PHI scrub check | M |
| 8 | Per-scan QC notes | M |
| 9 | QC mosaic + compare view | M-L |
| 10 | Import recipes + dry-run plan | M |
| 11 | DataLad sharing dashboard | M-L |
| 12 | BIDS App launcher | L |
| 13 | OpenNeuro / Brainlife / EBRAINS publishing path | L |
| 14 | Hosted BIDSvue mode | XL |
| 15 | Review notes + accepted warnings | M |
| 16 | HED tag helper for `events.tsv` | L |
| 17 | Modal focus trap + first focus | S |

### Bigger paths to choose between

These point in different directions; picking ONE may matter more than picking individual features.

1. **Make local datasets ready to share** — stay desktop, get better at release prep.
2. **Make scan review easier** — mosaic, compare, notes, QC export.
3. **Help users run the next tool** — BIDS App launcher (expands support surface).
4. **Bring BIDSvue to hosted datasets** — a cloud-connected deployment model with OpenNeuro / Brainlife / EBRAINS.

> **Discussion question for users**: should BIDSvue stay focused on local dataset creation and repair, become a desktop tool for getting datasets ready to share and review, or also become a cloud-connected way to manage hosted datasets?

### Explicitly out of scope

- **Plugin system** — revisit only if a real third party asks.
- **Heavy provenance graph UI** — operation history covers undo.
- **Full pipeline management platform** (queues, cluster submission, derivative comparison) — a BIDS App launcher is plausible; a workflow manager is a different product.

### Wishlist (open-ended)

- **Cloud / remote datasets** — a `DatasetBackend` interface over `@tauri-apps/plugin-fs` swappable for HTTP/WebSocket against S3 / WebDAV / Globus / OpenNeuro / DataLad.
- **Browser build** (the front end is deliberately web-portable; the heavy tools run as native sidecars — see AGENTS.md).
- **Multi-dataset compare mode.**
- **NiiVue ecosystem version sweep** — pin to a unified 1.0 when `@niivue/*` cuts one.
- **Spectroscopy viewer follow-ups** — MRSI viewer (complex+spatial NIfTI, needs a `.nii.gz`+`.json` fixture); editable peak annotations via Preferences (v1 hardcodes NAA 2.0 / Cr 3.0 / Cho 3.2); advanced phase/apodize/component disclosure; anatomy underlay + voxel marker (needs a BIDS-side SVS↔anatomy pairing rule).
- **NiiVue streaming gunzip** — design note (authored 2026-06-17, preserved in `git log`) to switch the upstream gzipped-NIfTI load path to `DecompressionStream('gzip')`, halving peak memory. Ready to paste into a NiiVue PR.

---

## 4. Verification owed

- Production CSP build smoke for `asset:` connect-src.
- Interactive smoke for the mutation-dialog in-flight contract.
- Cross-platform: real-hardware smoke of the produced AppImage/deb/NSIS installers (CI proves they build, not that they run). On clean Linux + Windows VMs, walk: app launches; About reports the bundled `dcm2niix` + `bids-validator`; dataset picker + scanner + offline validator work; DICOM import reaches `dcm2niix`; deface works (or the UI clearly says it is unavailable); DataLad clone/fetch works or fails with a clear message; Text/TSV editors save + undo; cloud-share panels open without native-path regressions; the Windows installer installs/launches/uninstalls cleanly; the Linux AppImage + `.deb` launch on a clean supported distro.

---

## 5. How decisions get made

- **Design rationale lands in the commit message and, when long-lived, in [ARCHITECTURE.md](ARCHITECTURE.md) or this file.** Per-feature history stays in `git log`.
- **Architecture, limitations, and roadmap are living docs** — a code change that shifts a decision updates the relevant doc in the same commit.
- **Scanner perf baseline** — CI fails when `bun run bench:scanner` exceeds 2.5× the committed baseline (50k files).
- **Don't document opt-in build flags that aren't wired through to TS** — skip the gate, rely on runtime capability probes + lazy `import()`.
