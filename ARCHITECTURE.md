# BIDSvue — Architecture

**Audience:** engineers maintaining the codebase or evaluating an architectural change.

**Scope:** how the v1 codebase is organized, what each layer is responsible for, where the security and mutation boundaries live, and which domain rules are load-bearing. Known caveats of the currently-shipped code live in [LIMITATIONS.md](LIMITATIONS.md); planned work + the new-feature wishlist live in [ROADMAP.md](ROADMAP.md); per-feature history lives in `git log`.

---

## 1. Big picture

BIDSvue is an *orchestrator* — the heavy lifting is delegated to existing tools (`dcm2niix`, `bids-validator`, `niimath`, `NiiVue`, `mindgrab`). The renderer is pure TypeScript on Tauri 2 + Svelte 5; the Rust surface is intentionally narrow (security boundary only, no business logic).

We use **Tauri 2** for small bundle size, native WebView, first-class sidecar support, and a capability-based runtime security model.

```
┌─────────────────────────────────────────────────────────────────┐
│ WebView (Svelte 5 + TS + Web Workers) — the entire app lives here│
│                                                                 │
│  Tree explorer · Sidecar editor · NiiVue viewer · Validator UI  │
│  BIDS scanner · entity parser · pairing · rename engine         │
│  OperationContext (backup/undo) · MutationLease                 │
│  validator UI (Rust sidecar default, JS fallback) · mindgrab    │
│  MEG vendor parsers (CTF/FIF/KIT/BTi) · PET enricher            │
└─────────────────────────────┬───────────────────────────────────┘
                              │  Tauri plugin APIs
              ┌───────────────┴───────────────┐
              │       Rust shell              │
              │  Trust store (trust.rs)       │
              │  Process boundary (process.rs)│
              │  Pickers · open_in_os · etc.  │
              └─┬──────┬───────────────────┬──┘
                │      │                   │
         dcm2niix  niimath  bids-validator   dcm2bids (external)
         (sidecar) (sidecar) (sidecar)        heudiconv (external)
```

## 2. Stack

| Layer | Tech |
|---|---|
| Shell | Tauri 2 |
| Renderer | Svelte 5 + TypeScript + Vite + SvelteKit (static SPA) |
| Tauri plugins (TS) | `plugin-fs`, `-dialog`, `-store`, `-os`. **No `plugin-shell`** — process spawning is owned by Rust. (`-updater` was wired and reverted during 0.1; see [ROADMAP.md](ROADMAP.md) for the v0.2 plan.) |
| Package manager / runtime | [Bun](https://bun.sh). Always `bun` / `bunx`. |
| Lint + format | [Biome](https://biomejs.dev/) |
| Viewer | `@niivue/niivue` — npm `1.0.0-rc.10` (universal entry; `attachToCanvas` runtime-selects WebGPU→WebGL2). Was a `file:../mono/packages/niivue` sibling build during M-PHY0; re-pinned to npm 2026-07-01, so the release-script `file:`/`link:` gate is satisfied. |
| Validator | `bids-validator-rs` sidecar by default; optional `@bids/validator` 2.4.1 JS bundle via `VITE_BIDSVUE_VALIDATOR_BACKEND=js` |
| Data model | Plain TS structures (`Map`, `Set`, objects). No SQLite, no IndexedDB. |
| i18n | `svelte-i18n` with ICU MessageFormat. English is source-of-truth; pt/es catalogs are AI-bootstrapped and flagged unreviewed. |
| Testing | Bun (TS unit + integration), `cargo test` (Rust), WebdriverIO + `tauri-driver` (E2E) |

## 3. Rust surface

The Rust surface is security-boundary code, not BIDS business logic or performance code.

The pure-Rust DataLad / git-annex engine behind `datalad_native_*` lives in the standalone [`rordenlab/datalad-rs`](https://github.com/rordenlab/datalad-rs) library crate, vendored as `src-tauri/crates/datalad-rs` and consumed as `datalad_rs`. `src-tauri` is the Cargo workspace root. Unlike `bids-validator-rs`, this is a compiled library, not a sidecar. BIDSvue keeps only the Tauri boundary: trust/path validation, cancellation bridging, progress channels, and undo/operation-log integration. `bun install` auto-initializes this submodule (postinstall `scripts/ensure-submodules.ts`); to init by hand instead, run `git submodule update --init --recursive`.

| Command | Purpose |
|---|---|
| `pick_dataset_directory`, `pick_file` | Native pickers that return a path + a freshly-minted token bound to that path (5-min TTL, descendant-aware). |
| `allow_dataset_scope(root, token)` | Widens plugin-fs + asset-protocol scope to a user-picked dataset root. Token-validated. |
| `allow_fs_scope(path, token)` | Widens fs scope only (no asset protocol) for non-viewer paths — DICOM/MEG sources, PET metadata. |
| `widen_to_trusted_path(path)` | Widens scope for a path already in the persistent trust set. No token needed (trust set membership is the authorization). |
| `trust_path(target, token)` | Persists `target` to the trust set after a successful open or import. Token must authorize `target`. |
| `clear_trusted_paths` | Wipes in-memory + on-disk trust state. Called by Reset Application Data. |
| `list_trusted_paths`, `is_path_trusted` | Read-only queries used by RecentDropdown and the boot-path `lastOpenedDataset` pre-flight. |
| `open_in_os(path)` | Trust-validated dispatch to the OS default opener. Replaces renderer-side `shell.open`. |
| `run_import_process(toolId, argv, auth)` | Runs an importer. Rust selects the fixed binary, re-validates the complete argv shape, and validates per-path tokens (`srcDir`, `destDir`, dcm2bids config, custom heudiconv heuristic). |
| `probe_import_tool(toolId)` | Spawns the fixed version probe (e.g. `dcm2niix -h`, `dcm2bids --version`) for wizard-mount availability detection. |
| `run_deface_process(toolId, argv, datasetRoot)` | Runs the bundled `niimath` deface sidecar for `allineate` (`-robustfov -deface`, 12-DOF affine). Validates the fixed `niimath <input> -robustfov -deface <template> <mask> <output>` argv shape, requires template/mask to be the bundled `avg152T1` resources, input under `datasetRoot` (which must be runtime-authorized in this session), and output under app cache. |
| `read_link(path)` | Returns the target of a symbolic link without following it. Backs the TS scanner's DataLad / git-annex pointer detection (`plugin-fs` exposes `lstat` but not `readlink`). Gated to runtime-authorized paths. |
| `stat_followed(path) → Option<u64>` | Follow-stat for pointer detection. Returns `Some(size)` for fetched annex content, `None` for un-fetched OR for symlinks whose canonical target escapes the authorized scope (re-checks the resolved canonical path so a hostile in-dataset symlink to `/etc/passwd` can't leak size info). Bypasses plugin-fs's `stat()` because its scope check canonicalizes through relative symlink targets incorrectly. |
| `detect_pointers_batch(paths) → SymlinkProbe[]` | Batched (readLink + follow-stat) probe for the scanner's pointer-detection pass. Collapses N×2 sequential round-trips per `readDir` to one. ds005016 (~2,400 annex pointers) was bottlenecked on ~4,800 round-trips at ~3 ms each (~14 s); this command made initial load fluid. Per-path security checks match the singular commands exactly. |
| `prepare_clone_destination(parentPath, parentToken, name)` | Mints a token for the composed `<parentPath>/<name>` path so the clone flow can name a destination that doesn't yet exist (no native picker would return it). Leaf-name guard rejects `..` / `.` / leading `-` / non-`[A-Za-z0-9._-]` chars. `symlink_metadata` rejects any pre-existing entry at the composed path (round-32 P1: a symlink there would redirect the subsequent clone). |
| `cancel_datalad_op(handle)` | Fires the cancellation registry's `Notify` for a running `datalad_native_clone` / `datalad_native_get` / `datalad_native_install_subdataset` / `openneuro_upload_file` spawn. Returns `true` if the handle matched a live spawn, `false` if it had already finished. The renderer side mints handles via `crypto.randomUUID()` and listens on an `AbortSignal` to dispatch this. |
| `datalad_native_version` | Returns `{name: "bidsvue-annex", version, gix, datalad_compat}` for the native engine. Consumed by the About dialog + the renderer's `bidsvueAnnexRunner.probe()`. No arguments; `version` / `gix` / `datalad_compat` are read from the `datalad-rs` crate's `VERSION` / `GIX_VERSION` / `DATALAD_COMPAT_VERSION` constants (M-DL9), so the row reports the extracted engine's identity, not BIDSvue's app build. |
| `datalad_native_probe(datasetRoot)` | Enumerates the dataset's git-annex remotes via the `git-annex` branch (`remote.log` via `gix`) plus the implicit `web` special remote (UUID `00000000-0000-0000-0000-000000000001`); reports each one's supported/unsupported verdict + the local `annex.uuid`. Supports S3 `exporttree=yes` + `web` URL lists; everything else surfaces as "unsupported" with a reason. |
| `datalad_native_head(datasetRoot)` | Returns the current HEAD commit hex for `datasetRoot` via `gix` (no spawn). Used by the renderer's reconcile path to capture a pre-save baseline. |
| `datalad_native_siblings(datasetRoot)` | Reads configured git remotes via `gix` and returns the list of sibling names. Read-only — Push to upstream is out of scope for the native engine; renderer-side "Share these changes upstream…" routes through Cloud Share instead. |
| `datalad_native_log_for_intent(datasetRoot, expectedParent, intentId)` | Walks the commit log from `expectedParent..HEAD` via `gix`, returning every commit whose message contains the `bidsvue-intent: <intentId>` trailer. Backs the renderer-side reconcile-pending-DataLad flow. |
| `datalad_native_status(datasetRoot)` | HEAD-vs-worktree walker via `gix` + `gix_ignore`'s `Search` (root `.gitignore` + `.git/info/exclude`). Returns dataset-relative POSIX paths bucketed `{added, modified, deleted}` so the renderer's "DataLad: N pending" chip + Save dialog render dirty state without spawning Python. Blob hashes are compared via `gix::objs::compute_hash` (≤16 MiB) / `compute_stream_hash` (larger). Per-entry `read_dir`/`file_type` errors propagate as a hard failure — silent swallowing could mis-bucket a permission error as a deletion and let `save_dirty` commit the wrong tree (audit_temp 2026-06-14 P2). |
| `datalad_native_save(datasetRoot, message, paths)` | Explicit-paths save. Tree-overlay implementation via `gix`: HEAD's tree is the starting point, each requested path is read from the worktree and written as a fresh blob via `repo.write_blob()`, the affected subtrees are rewritten recursively, and `repo.commit(HEAD_ref, message, new_tree, [parent])` creates the commit. Refuses any path under `.git/` (audit_temp 2026-06-14 P1 — annex objects get a Cloud-Share-pointing message; other repo internals get a generic refusal); refuses detached-HEAD checkouts; refuses overlaying registered submodules. Result carries `{commitHash, parentHash, createdCommit, backend}` so `operations.log` entries are correlatable. Runs the blocking gix work in `tokio::task::spawn_blocking`. |
| `datalad_native_save_dirty(datasetRoot, message)` | Dirty-tree save. Composes `datalad_native_status` (to enumerate adds / modifications / deletes) + `save_changes_with_deletes` (the overlay machinery in `save.rs` now stages deletions via tree-entry removal — audit_temp 2026-06-14 P1.2). Errors when the worktree is clean. Same backend identity + cloud-share refusals as `datalad_native_save`. |
| `datalad_native_revert(datasetRoot, commitHash, message)` | Inverse-commit application via `gix`. Refuses a dirty worktree, refuses non-ancestor commits, refuses merge commits (2+ parents). Reads the parent-vs-target diff, applies the INVERSE to HEAD as a tree overlay (SetTo for paths the target modified-or-removed; Delete for paths the target added), commits with the renderer-supplied message + `bidsvue-intent:` trailer, AND updates the affected worktree files on disk so the immediate post-revert rescan reads clean (audit_temp 2026-06-14 P1.1 — silently skipping the worktree write left HEAD desynced from disk and broke history undo). Conflict: if HEAD's entry for a touched path doesn't match the commit being reverted, refuses with a clear error. |
| `datalad_native_clone(url, dest, recursive, destToken, cancelHandle?)` | URL validation against a strict scheme allowlist (`https://` / `http://` / `git://` / `ssh://` / SCP-form `user@host:path`, no credentials, hosts AND usernames cannot start with `-`, clone path's first byte (after stripping leading `/`) cannot be `-`, ≤2 KiB). M-DL16 (2026-06-14 transport-layer closure + 2026-06-15 audit rounds 6 + 7 + 8): `ssh://` delegates to [`validate_ssh_url`](src-tauri/crates/datalad-rs/src/ssh.rs); SCP form delegates to `validate_scp_url`; both paths share `validate_ssh_clone_path` for the empty-path + first-byte-leading-dash rejections. `ria+ssh://` parses for classification but is rejected pending SSH-RIA support. gix-transport's `Scheme::Ssh` arm spawns the host `ssh` binary inheriting `$SSH_AUTH_SOCK`; the Tauri main process pre-scrubs the full SSH-command-override set (`GIT_SSH` / `GIT_SSH_COMMAND` / `GIT_SSH_VARIANT` / `GIT_PROXY_COMMAND`) AND sets `GIT_TERMINAL_PROMPT=0` / `GIT_ASKPASS=/usr/bin/false` / `SSH_ASKPASS=/usr/bin/false` / `SSH_ASKPASS_REQUIRE=never` via testable helpers `git_safety_env_scrub_for_startup` + `git_safety_env_set_for_startup`. `DISPLAY=""` is also set at startup on non-Linux platforms; Linux keeps `DISPLAY` for GTK WebView startup and relies on the askpass pins plus per-spawn child env scrubbing. Dest token validated against the trust store. `gix::prepare_clone(...).fetch_then_checkout(...).main_worktree(...)` runs inside `tokio::task::spawn_blocking`; cancellation handle flips an `AtomicBool` the gix loop polls. HEAD is resolved via `repo.head_id()` (returns a real commit hash, not `ref: refs/heads/main`). On success, runs `apply_widen_dataset` + `authorize_runtime_dataset_root` + `trust_path_internal` so `openDataset` Just Works. With `recursive=true`, walks `.gitmodules` and installs every entry via `install_subdataset` (best-effort: failures log but don't abort the clone). |
| `datalad_native_install_subdataset(datasetRoot, subpath, cancelHandle?)` | Mirrors `datalad get -n <path>`. Reads `.gitmodules` to recover the URL + name, then drives `gix::prepare_clone(url, .git/modules/<name>).fetch_then_checkout(...)` (blocking; runs under `tokio::task::spawn_blocking`) and moves the produced layout into the submodule's gitfile-pointed module dir. `cancel_datalad_op(handle)` flips an `AtomicBool` that gix's fetch loop polls. |
| `datalad_native_get(datasetRoot, paths, cancelHandle?, onProgress)` | Native fetch. Reads each symlink to extract the git-annex key, then synchronously builds a candidate URL list (S3 export URL via `remote.log`; per-key web URLs via `<hashdirlower>/<key>.log.web` — only `http(s)://` URLs free of control chars survive `is_safe_web_url`, audit_temp 2026-06-14 P2); round-robins through them in descending-timestamp order, streaming the body over HTTPS through a shared `reqwest::Client`, verifying SHA-256 against the key's encoded hash, and writing into `<datasetRoot>/.git/annex/objects/<hashdirmixed>/<key>/<key>` at mode 0o444. HTTP 4xx skips to the next URL without retry. The `gix::Repository` is dropped before any await (it isn't `Send`) — per-path URL planning is fully synchronous. Fetches run through a `tokio::Semaphore`-bounded parallel batch (default 8 concurrent; `BIDSVUE_DATALAD_FETCH_PARALLELISM` env override 1..=32, no user-facing knob). `cancelHandle` registers a `CancellationRegistry` Notify; `cancel_datalad_op(handle)` fires it, the semaphore is closed so queued tasks short-circuit, and in-flight `JoinHandle`s are aborted. Progress flushes at 300 ms cadence: one `get(ok)/get(error)` line per completed file + a `datalad_native: N/M files (B bytes transferred)` summary. On success, `journal::write_present_key` appends a `setpresentkey`-equivalent line to `.git/annex/journal/` so a side-installed `git-annex` recognises the content as locally present. |
| `share_token_put`, `share_token_get`, `share_token_delete` | Cloud-share credential vault. Atomic mode-0600 write to `<appDataDir>/share/<backend>/jwt`. Backend slug allowlisted (`brainlife | ebrains | openneuro` + dev-only `stub`); 8 KiB value cap; rejects newlines / NUL. Both plugin-fs `fs:scope` and the asset-protocol scope exclude `$APPDATA/share/**` so a renderer XSS cannot exfiltrate tokens via `convertFileSrc`. |
| `openneuro_upload_file(file_path, url, bearer)` | Per-file POST to OpenNeuro's `/uploads/<endpoint>/<datasetId>/<uploadId>/<:-encoded-path>` shard, routed through Rust because `/uploads/...` does not include the Tauri WebView origin in its `Access-Control-Allow-Origin` header (the WebView `fetch` blocks the response). The renderer composes the URL + bearer; Rust re-validates the URL prefix (`https://openneuro.org/uploads/`), the bearer envelope, and the file path against `validate_authorized_path_canonical` (canonicalizes through symlinks before re-checking trust). Response bodies are JWT-scrubbed before any error string reaches the renderer. The only renderer-initiated HTTP path in the Rust surface today. |
| `test_open_dataset`, `open_devtools` | Testability / dev-only. |

**Path-validation helpers.** Rust commands that need a path from the renderer use one of two validators depending on what the command does with it:

- `validate_authorized_path` — lexical check only (`..` / `.` reject + prefix membership against runtime-authorized roots). Appropriate for `lstat`-only commands (`read_link`, `stat_followed`, `chmod_path`, `share_token_*`) where the metadata IS the answer and symlink-following is the caller's explicit concern.
- `validate_authorized_path_canonical` — the lexical check followed by `std::fs::canonicalize` through every symlink in the chain, with the resolved canonical target re-checked against the trust store. MUST be used by any Rust command that follows symlinks during `std::fs::read` / `std::fs::write` / `std::fs::metadata`. `openneuro_upload_file` is the canonical caller (added 2026-05-23 after an audit caught a symlink-escape where a symlinked file under a trusted root could redirect the upload to a file outside the trust set). Any future follow-the-path Rust command (re-introduced byte upload, export-to-zip, anything that opens a renderer-named file) MUST reuse it.

Rust tests run as a Cargo workspace: `cargo test --workspace`. `bidsvue` owns boundary tests; `datalad-rs` owns engine tests. Ignored git/network fixtures run through `scripts/check-datalad-native.sh`. Details live in §12.

### When (and only when) to add Rust

Rust enters only when measurement proves TypeScript is the bottleneck for a specific operation. Two pre-identified triggers — **neither has fired:**

1. **Scanner port.** If cold-loading a 100k-file dataset takes > 5 s with the TS + Web Worker scanner, port [src/lib/bids/scanner.ts](src/lib/bids/scanner.ts). M1 measured 1.42 s; bench gate at [bench/baselines/scanner.json](bench/baselines/scanner.json).
2. **Backup/undo atomicity.** If failure-injection tests show partial-state bugs that are awkward to fix in TS, port [src/lib/mutate/backup.ts](src/lib/mutate/backup.ts). M6 shipped pure-TS `OperationContext` with LIFO rollback.

When you do add Rust: keep the surface narrow (one well-defined function), generate TS bindings via `tauri-specta`, and keep the TS implementation as a fallback so the cloud port still works without the native module.

## 4. Data model

Built once on dataset open in a Web Worker; updated incrementally on filesystem changes. Lives entirely in JavaScript memory — no database. Per-file record averages ~500 bytes; a 100k-file dataset is ~50 MB resident.

### 4.1 Core types

```ts
interface Dataset {
  root: string
  description: DatasetDescription
  participants?: ParticipantsTable
  tree: TreeNode
  validatorState: ValidatorState
  index: DatasetIndex                    // O(1) secondary indexes
}

type TreeNode =
  | { kind: 'folder'; path; name; children; level }
  | { kind: 'group';  commonPrefix; commonEntities; members; suffixes }
  | { kind: 'file';   path; entities; suffix; extension; size; sidecarFor? }

interface DatasetIndex {
  byPath:           Map<string, TreeNode>
  bySubject:        Map<string, FileNode[]>
  bySubjectSession: Map<string, FileNode[]>
  bySuffix:         Map<string, FileNode[]>
  byValidatorStatus: { errors: Set<string>; warnings: Set<string> }
}
```

Full definitions: [src/lib/bids/types.ts](src/lib/bids/types.ts).

### 4.2 Pairing rules

Sibling files that share a true **leading BIDS-entity prefix** (walk `CANONICAL_ENTITY_ORDER` in [src/lib/bids/entities.ts](src/lib/bids/entities.ts); stop at first divergence; never an unordered set intersection) coalesce into one tree row. The status-bar `showFullFilenames` toggle (off by default) switches to one row per member.

- Sidecars (`.json`, `.tsv`, `.bval`, `.bvec`) coalesce with their data file.
- Multi-echo / multi-part stay separate (users routinely interact with individual echoes).

Worked example: `sub-crlab_T1w.nii.gz` + `sub-crlab_T1w.json` → one row `[sub-crlab_]T1w[.json; .nii.gz]`.

Algorithm in [src/lib/bids/pairing.ts](src/lib/bids/pairing.ts); test coverage in [src/lib/bids/pairing.test.ts](src/lib/bids/pairing.test.ts).

### 4.3 Special folders

- `sourcedata/`, `derivatives/`, `code/`, `.heudiconv/`, `.bidsvue/` — show but dim. Excluded from validator scope regardless.
- `.bidsignore` honored for both display dimming and validator scope. Injected into the validator so its own `ignore` package handles negation/re-include patterns.

### 4.4 Hidden vs visible vs dimmed

Off (default): scanner skips dotfiles at any depth + `sourcedata/` at the root. On: those entries appear but special folders and dotfiles render dimmed.

`isHiddenByDefault(name, isTopLevel)` in [src/lib/bids/level.ts](src/lib/bids/level.ts) is the single source of truth; the dim rule (`flags.specialFolder !== undefined || name.startsWith('.')`) must stay aligned with it.

## 5. Mutation, backup, undo

**Every mutation is reversible. Non-negotiable.**

### 5.1 OperationContext

All file-modifying actions route through [src/lib/mutate/backup.ts](src/lib/mutate/backup.ts):

```
beginOperation(root, statePaths, meta, fs?)
  → ctx.writeText / ctx.writeBytes / ctx.rename / ctx.delete
  → ctx.recordCreatedTree / ctx.removeTree
  → ctx.commit  (or)  ctx.rollback
```

Single-step callers use `atomicWriteText` / `atomicWriteFile` / `renamePath` wrappers. Operation log is JSONL with typed `children: ChildStep[]` (`'write'` / `'rename'` / `'delete'` / `'created-tree'` / `'removed-tree'`). LIFO rollback on mid-op failure.

### 5.2 MutationLease

Every action-layer mutator acquires a `MutationLease` before any work, releases in `finally`. Sits above `OperationContext` and covers the pre-`beginOperation` window. Implementation: `src/lib/mutate/lease.ts`.

```ts
acquireLease({ scope, kind, snapshotFreshness?, fs? })
type LeaseScope =
  | { kind: 'file'; path }
  | { kind: 'dataset'; root }
  | { kind: 'global' }
```

Conflict matrix: `global` ⊥ everything; `file` ⊥ `file` iff equal paths; `dataset` ⊥ `dataset` iff either root contains the other (containment-aware); `file(P)` ⊥ `dataset(R)` iff `P` is under `R`. Conflict throws `LeaseConflictError`.

Per-call-site scopes: single sidecar save → `file`; batch save / rename / undo / import → `dataset`; deface / revertDeface → `file` + `snapshotFreshness`; Reset → `global` (true write-ahead lock).

### 5.3 State location

**All per-dataset state lives under app-data, NOT inside the dataset.** `<appDataDir>/datasets/<safeKey>/` holds `prefs.json`, `operations.log`, `originals/<opId>/`. `safeKey = base64url(SHA-256(absoluteDatasetPath)).slice(0,32)`. Layout in [src/lib/state/appPaths.ts](src/lib/state/appPaths.ts).

This is why BIDSvue is safe against cloud-mounted / read-only / conformance-strict datasets. The dataset directory stays bit-clean except for the one **M7-deface exception**: `<dataset>/sourcedata/` is the pristine-bytes mirror used to revert.

Trade-off accepted: undo histories don't follow a dataset across machines.

### 5.4 Wrapper discipline

**Long-running mutation wrappers must capture `scanGeneration` + `datasetStore.dataset?.root` at entry.** `withOpenDatasetAndRescan` (used by single-target ops) and the per-call inline guards in `importDicoms` / `importMeg` capture both at entry and only rescan / auto-open if both still match in `finally`. Otherwise a deface or import that finishes after the user opened another dataset will rescan / reveal-into the wrong target.

## 6. Security boundary

### 6.1 Capability allowlist (narrow at startup)

[src-tauri/capabilities/default.json](src-tauri/capabilities/default.json):
- `fs:scope` covers `$APPDATA/**` + `$APPCACHE/**` + `$RESOURCE/**`.
- `$APPDATA/trust/**` is explicitly **denied** (Rust-managed trust file lives there).
- **No `shell:allow-execute`** — `@tauri-apps/plugin-shell` is not installed.
- All fs permissions declared in **string form** (no per-permission `allow` arrays) so they fall back to `fs:scope`. Tauri 2's permission system enforces per-permission `allow` BEFORE the runtime scope check; a per-permission array would shadow the runtime widening.

Pre-open XSS reachable surface = bundled `$RESOURCE` + `$APPDATA` only.

### 6.2 Trust-set + token registry

The renderer never has direct OS shell access and never sees a path it didn't ask the user to pick. In brief:

- **Pickers mint in-memory tokens.** `pick_dataset_directory` / `pick_file` return `(path, token)`. Picking does **not** auto-persist the path; persistence is a separate `trust_path(target, token)` call gated on the operation actually succeeding.
- **Tokens are bound + TTL-limited.** A token authorizes any path equal to or descendant of the bound path. 5-minute TTL. Path-component guard rejects `..` / `.` at validation time so lexical traversal can't bypass containment.
- **Persistent trust set** at `$APPDATA/trust/trusted_dataset_roots.json`. Atomic temp-then-rename writes (`MoveFileExW(REPLACE_EXISTING)` on Windows); corrupt parse quarantines the file rather than crashing setup.
- **Per-session runtime authorization** mirror in [src-tauri/src/trust.rs](src-tauri/src/trust.rs). Tauri plugin scopes are append-only by design and unreachable from native process commands; the runtime set is what `run_deface_process` consults to verify the dataset root is opened in this session. Cleared by Reset.

### 6.3 Process boundary

[src-tauri/src/process.rs](src-tauri/src/process.rs) owns every native spawn. The renderer sends `(toolId, argv)` over IPC; Rust validates the complete argv shape per tool, validates per-path tokens against the trust store, then spawns the fixed sidecar / external binary.

Argv validators today: `validate_reproin_argv`, `validate_pet2bids_argv`, `validate_dcm2bids_argv`, `validate_heudiconv_argv` (for imports); fixed `niimath <input> -robustfov -deface <template> <mask> <output>` shape for the `allineate` deface tool. Per-tool path checks: `srcDir`, `destDir`, dcm2bids config, custom heudiconv `.py` heuristic must each carry a token authorizing them.

**dcm2bids PATH injection.** dcm2bids does `shutil.which("dcm2niix")`. Rust sets `PATH = <bundled sidecar dir>:<inherited PATH>` (prepended, not replaced) so a PATH-resolved external `dcm2bids` is found via the user's homebrew / pyenv PATH AND its internal `shutil.which("dcm2niix")` resolves to OUR bundled sibling rather than the user's. The bundled-dir-first ordering keeps the dcm2niix version we validated; appending the inherited PATH lets the external dcm2bids itself be located. When no PATH is inherited (rare GUI-launch case), Rust falls back to the OS default dirs (`/usr/bin:/bin:/usr/sbin:/sbin` on Unix, `%SystemRoot%\System32` on Windows).

### 6.4 Wider rule

- All FS access from the renderer goes through `@tauri-apps/plugin-fs`. The renderer never imports `@tauri-apps/plugin-dialog`'s `open()` for scope-relevant paths — go through the Rust pickers.
- Tauri 2's runtime Scope API is **append-only** within a session. Closing+reopening the app is the only way to drop a previously-opened dataset's scope.
- `Scope::allow_directory` / `allow_file` pre-escape glob patterns via `glob::Pattern::escape`, so raw glob patterns can't be pushed at runtime — `<root>/**` does NOT match dotfiles. The atomic-write temp filename in `backup.ts` dropped its leading-dot convention (`<basename>.bidsvue-tmp-<opId>`) to survive the narrowed scope.

## 7. External tool integration

| Tool | How it ships | Invoked from | Platforms | Notes |
|---|---|---|---|---|
| `dcm2niix` (dev build) | Bundled Tauri sidecar | Rust `run_import_process` | macOS arm64, Linux x86_64, Windows x86_64 | CMake SuperBuild with OpenJPEG (JPEG2000) and CharLS (JPEG-LS) for compressed transfer syntaxes so both legacy lossy and JP-LS PET DICOMs convert in-process; every platform binary's `-v` line MUST include BOTH `(JP2:OpenJPEG)` AND `(JP-LS:CharLS)` markers per the verification step. Emits 11-col `.reproin_provenance.tsv` (adds `PatientAge` / `PatientSex` / `StudyDate` / `StudyTime` / `PatientID`); `-f %H` argv shape follows `dcm2niix/tools/reproinx.py`. `-ba o` mode (PII stripped, dates kept) is now wired for `anonymize=false`. Routes Siemens physio (`(7FE1,1010)` Raw Data Storage) into `<root>/derivatives/scanner/<sub>/.../func/` for the TS post-pass's physio-rescue (Pass 1b) to promote into the main BIDS tree. The macOS binary is the local dev build; Linux/Windows binaries are pinned AppVeyor artifacts recorded in `scripts/fetch-sidecars.ts`. |
| `pet2bids` | Same dcm2niix sidecar + BIDSvue PET enricher (pure TS) | Rust `run_import_process` | macOS arm64, Linux x86_64, Windows x86_64 | Ported from pypet2bids 1.4.6. DICOM-only in v1; ECAT deferred. |
| `dcm2bids` (optional) | User-installed Python (`pip install dcm2bids`) | Rust `run_import_process` | All (PATH-detected) | Was a bundled Nuitka sidecar through 2026-06-06; unbundled 2026-06-14 to shed ~7.6 MB and follow upstream releases. Rust still injects the bundled `dcm2niix` sibling on its PATH (`shutil.which('dcm2niix')` resolves to ours), so a clean `pip install dcm2bids` user does NOT need their own dcm2niix. `scripts/build-dcm2bids-sidecar.sh` is retained as the round-trip path. |
| `heudiconv` (optional) | User-installed Python | Rust `run_import_process` | All (PATH-detected) | Built-in heuristics or absolute `.py`. Detection at wizard mount. |
| `niimath` (deface sidecar) | Bundled Tauri sidecar | Rust `run_deface_process` | macOS arm64, Linux x86_64, Windows x86_64 | Backs `allineate` (`-robustfov -deface`, 12-DOF affine) on all bundled platforms, plus the mindgrab `niimath_dilate` mask dilation. Fixed `niimath <input> -robustfov -deface <template> <mask> <output>` shape; template/mask must match the bundled `avg152T1` resources. The macOS binary is the local `OMP=0 ZSTD=0` BSD build (no Homebrew dylibs, no GPL `spm_coreg`); Linux/Windows are pinned AppVeyor BSD builds. |
| `mindgrab` / `mindgrab8` | In-process WebGPU model (~370 KB chunks, lazy `import()`) | Renderer | Any platform with WebGPU-capable WebView | Weights ship as `bundle.resources` (~574 KB). |
| `bids-validator` | Offline esbuild bundle (`@bids/validator` JSR) | Renderer (in-WebView) | All | Import/export-rewrite regex transforms in `scripts/patch-validator-imports.ts`. |
| `NiiVue` | npm package | Renderer | All | Universal `@niivue/niivue` entry: `attachToCanvas` tries WebGPU then falls back to WebGL2. macOS WKWebView uses WebGPU; Linux WebKitGTK (no WebGPU) uses WebGL2. |
| `niimath_dilate` | Same bundled native `niimath` sidecar | Rust `run_deface_process` | macOS arm64, Linux x86_64, Windows x86_64 | Dedicated argv shape for mindgrab mask dilation (`-binv -edt -thr N -binv`). No WASM niimath remains in the app. |

### Bundled-binary staging

Source-of-truth: `resources/<platform>/<basename>` (committed). Tauri's `bundle.externalBin` reads `src-tauri/binaries/<basename>-<target-triple>` (gitignored; Windows uses `<basename>-<target-triple>.exe`). `bun install` runs `scripts/stage-sidecars.ts`, which stages the current host's committed sidecars automatically.

- `scripts/build-dcm2bids-sidecar.sh` is retained as the round-trip path back to bundling (drops the binary under `resources/darwin/dcm2bids`); dcm2bids ships PATH-resolved today so the staged binary is intentionally absent.
- dcm2niix / niimath / bids-validator: macOS arm64 binaries are maintained locally; Linux/Windows x86_64 binaries are pinned AppVeyor artifacts refreshed by `scripts/fetch-sidecars.ts` and committed under `resources/{linux,windows}/`.
- `scripts/stage-sidecars.ts::stagedName` owns the Windows `.exe` rule. Never stage `dcm2niix.exe-x86_64-pc-windows-msvc`; Tauri expects `dcm2niix-x86_64-pc-windows-msvc.exe`.

## 8. Validator integration

Load-bearing facts that aren't obvious from reading the code:

- **The validator runs in the WebView, NOT as a sidecar.** Pre-bundled offline by `scripts/bundle-validator.ts` (esbuild) into `src/lib/validation/_validator.bundle.js` (gitignored, ~5 MB minified) + `static/_validator.schema.json` (~560 KB).
- **Do not revive the Vite-resolver path** for `@bids/validator/*`. Vite's per-file CJS-shim wraps each validator source file in a way WebKit's ESM loader rejects. Esbuild's CJS interop handles JSR's Deno-flavoured patterns cleanly. Dead end — don't relitigate.
- **Two regex transforms** in `scripts/patch-validator-imports.ts` (postinstall, idempotent) rewrite `import { default as X } from "Y"` and `export { default as X } from "Y"` (both forms optionally with a `with { type: "json" }` attribute) into the WebKit-acceptable default-import / named-export shape. The patcher scans the validator + schema source trees so files added in future validator versions stay covered without enumerating them.
- **Lazy `TauriFileOpener`, NOT a browser `File[]`.** Each opener implements `readBytes(size, offset)` via `plugin-fs::open` → `FileHandle.seek` → `FileHandle.read`, so the NIfTI rule's `readBytes(1024, 0)` only reads 1 KB header bytes — not the 800 MB BOLD payload. Memory scales with file COUNT + per-file METADATA, not byte payload. ds002606 (16 GB on disk) peaks under ~700 MB during validation.
- **Load-bearing**: the `BIDSFile.path` passed into `filesToTree` MUST start with `/`. The validator's `filesToTree` does `parts.dir.split('/').slice(1)` and assumes the leading empty segment.
- **UI gating**: `preferencesStore.validatorDisplay` (`'warningsAndErrors'` / `'errorsOnly'` / `'silent'`). Silent suppresses every validator-driven UI element but the validator still runs so the messages panel has data.

### Watcher

[src/lib/state/datasetWatcher.ts](src/lib/state/datasetWatcher.ts): 800 ms debounce, path-component ignore filter (`.bidsvue`, `.git`, `.datalad`, `.heudiconv`, `sourcedata`, `derivatives`, `code`, `.DS_Store`, `Thumbs.db`), and event-kind filter (`isContentRelevantKind`) that drops pure read/access events plus metadata-only events to avoid Linux inotify scan-read feedback loops. Relevant fires call `rescanCurrentDataset()` (full rescan + revalidate). `View > Re-validate now` (`Cmd/Ctrl+R`) calls `revalidateCurrentDataset()` directly without re-scanning.

## 9. UI surfaces

### 9.1 Launch screen

Shown on cold start when there is no last-opened dataset (or the user holds a modifier key during launch). Three entry points: open existing BIDS dataset, create new dataset from DICOM/MEG, recent datasets list.

A reachable last-opened dataset jumps straight to the explorer (pre-flighted through `is_path_trusted`).

### 9.2 Main window

Three panels, resizable, persisted: tree explorer (left), detail panel with tabbed sidecar editor / NiiVue / raw JSON / validator-messages (right), status bar.

The NiiVue viewer auto-attaches BIDS physio overlays (M-PHY1). When the previewed file ends in `_bold.nii[.gz]` and the loaded volume reports `dim[4] > 1`, the viewer reads the parent dir for sibling `*_recording-*_physio.tsv.gz` files via `pairPhysioFiles` (in `src/lib/viewer/pairPhysio.ts`), pre-resolves symlinks for fetched DataLad / git-annex pointers, and calls `viewer.loadSignals(...)` with `attachToId: vol.id` so the existing crosshair-timecourse graph gains one trace per recording on a shared time axis. Multi-echo BOLDs share one physical physio recording — the `_echo-N` entity is stripped from the pairing stem so both echoes resolve to the same `_recording-*_physio.tsv.gz` set. `_sbref` files never trigger pairing. Switching to another file calls `removeAllSignals()` before the new attach so traces don't leak across volumes. Best-effort: readDir or `loadSignals` failures log and continue; the BOLD itself stays usable.

**NIfTI files split three ways at preview time** (M-SVS, 2026-06-12). `Preview.svelte` calls `probeNiftiKind(path, fs)` in `src/lib/deface/headerProbe.ts` for every `.nii` / `.nii.gz` selection; the streaming 352-byte header read returns one of `'volume'` (the existing `NiivueViewer` — the default), `'svs'` (single-voxel NIfTI-MRS: `dim1=dim2=dim3=1 AND dim4>1`, mounts the new `SpectroscopyViewer` with NAA / Cr / Cho peak annotations + a two-input ppm range row + an "average transients" checkbox), or `'file-only'` (complex datatype with spatial extent — typically an MRSI/CSI volume the signal reader cannot represent; no viewer mounts and the existing file-info card surfaces dims + size). The discriminator mirrors `@niivue/niivue/src/signal/detect.ts::niftiBufferIsSignal` — BIDS suffix is NOT consulted, only the header dim shape + datatype. `SpectroscopyViewer.svelte`'s lifecycle inherits the `attachPhysio.ts` race-closure pattern via `src/lib/viewer/attachSpectroscopy.ts` so a fast path-switch between SVS files cannot leak a spectrum onto the next canvas paint.

### 9.3 Tree explorer

- Virtualized scrolling (only render visible rows).
- Keyboard-first nav: Up/Down, Left/Right (collapse/expand), Enter, Space (multi-select toggle), Cmd/Ctrl-A.
- Bulk gestures: Alt-click chevron (this folder + descendants), Cmd/Ctrl-click chevron (peers at same level), toolbar collapse-all + progressive expand-next-level (chevrons-down icon; one click opens the shallowest depth that still has any unexpanded folder via `nextLevelPaths` BFS; greys out when fully expanded). View menu carries the same actions plus a one-shot Expand All.
- Folder badges: entity counts (`sub-01  [3 ses · 47 files]`).
- Validator errors propagate up as red-dot badges; disappear when fixed.
- Right-click context menu: open, reveal in Finder/Explorer, edit sidecar, view in NiiVue, rename entity, deface (any 3D volume), restore from backup, delete.

### 9.4 Selection model

Three decoupled axes:
- `selectedPaths: Set<string>` — selected rows.
- `primaryPath` — drives Preview pane; normally in `selectedPaths`.
- `activeIdentity` — keyboard cursor; decoupled from selection so Shift+arrow can extend without losing the anchor.

Plain click / arrow replaces all three. Shift-arrow extends selection while moving only the cursor. Preview's group-tab strip uses `setPreviewTarget(path)` to retarget the Preview alone — the only legitimate way `primaryPath` is allowed to diverge from `selectedPaths`.

### 9.5 Sidecar editor

Two coordinated views, same in-memory document:
1. **Form view** (default). Schema-driven from the BIDS schema. Fields grouped by section (Required, Recommended, Optional, Manufacturer-specific). Inline validator callouts; required-but-missing fields pre-stubbed with `?` and a "Click to fill" affordance.
2. **Raw view** (Monaco). Syntax-highlighted with JSON-schema-driven autocomplete.

Save is explicit (Cmd-S). On save, re-validate affected files and update badges. Clickable entity-pattern chips apply an edit across all matching siblings.

### 9.6 Rename / refactor

Entity-typed renames are first-class — `sub-` / `ses-` / `acq-` etc. are typed values, never substring search. Engine: `src/lib/rename/`.

- Folder entities (`sub`, `ses`) rename folders + descendants + cross-references (`IntendedFor` in fmap sidecars; filename columns in `*_scans.tsv` / `participants.tsv`).
- Filename entities (`task`, `acq`, `run`, `chunk`, …) are dataset-wide basename renames.
- Word-boundary regex protects `run-1 → run-2` from corrupting `run-10`.
- `derivatives/` / `sourcedata/` / `code/` are intentionally out of scope.

Dry-run preview rendered as a unified tree-diff (added/removed/renamed badges) before commit. Commit writes through `OperationContext` so the op is reversible.

### 9.7 Defacing

For any 3D volume:
1. Dropdown in the NiiVue control row lists `original` plus `allineate` (the bundled `niimath` sidecar's 12-DOF affine `-deface` path) and `mindgrab` / `mindgrab8` / `mindgrab8robust` (in-process WebGPU; `mindgrab8robust` adds a niimath `-robustfov` neck crop before the model).
2. Picking a tool: backup manager copies the pristine NIfTI to `<dataset>/sourcedata/<sub>/anat/…` (if not already there — re-defacing reads from this mirror), writes the defaced bytes over the target, appends a `DeidentificationMethodCodeSequence` sidecar row. All three run under one `OperationContext`.
3. Picking `original` reverts: read sourcedata bytes, overwrite target, strip the BIDSvue sidecar entry. Sourcedata stays for future re-defacing.

Per-target `MutationLease` with `snapshotFreshness: true` defends against external edits during the 1–30 s mutation window. The deface dropdown is hidden for 4D inputs (BOLD / DWI / ASL — `dim[4] > 1`) since the CPU defacers produce meaningless output there; Batch Deface skips 4D targets per file rather than aborting the batch.

### 9.8 Importers

DICOM importer covers four tools — `dcm2niix-reproin`, `pet2bids`, `dcm2bids`, `heudiconv` — each with its own argv builder and post-pass. Code: `src/lib/import/`.

- **dcm2niix-reproin** runs BIDSvue's port of the upstream `dcm2niix/tools/reproinx.py` post-pass (latest sync: 2026-07-15, commit `e6e9cbd`). It collapses non-reproin double-root output, rescues `Unknown/*` from `BidsGuess` + provenance TSV, cleans bidsguess artifacts, resolves multi-echo BOLD+phase collisions into `_part-<mag|phase>` entities, renames duplicate output stems, backfills sessions, rescues physio from `derivatives/scanner/`, writes scans/events/root scaffolding, and optionally drops `derivatives/scanner/`. Load-bearing gotchas: Unknown physio rescue runs in a `finally` after BOLD rescue; family moves go through atomic `moveStemFiles`; session inference is gated to `BIDS_DATATYPES` so `code/` / `stimuli/` / `sourcedata/` cannot steer it; physio rescue requires both `.tsv.gz` and `.json`, and a half-pair warning preserves `derivatives/scanner/` instead of deleting the remaining companion; **part-entity resolution (`partEntities.ts`) runs inside the bidsguess cleanup AFTER the 3D-bold demote and BEFORE dup-naming — that order is load-bearing (dup-naming skips a group already consumed by part resolution).**
- **pet2bids** runs the M12 PET post-pass: walk every `_pet.json`, apply `enrichPetSidecar` with an optional operator-supplied metadata JSON overlay.
- **heudiconv / dcm2bids** arrange BIDS themselves; BIDSvue skips its own post-pass and writes a minimal `dataset_description.json` only if absent.

MEG importer is pure-TS, four vendors in one wizard entry — CTF / Elekta-FIF / KIT / BTi. Code: `src/lib/import/meg/`.

**MNE-BIDS importer** (`feat/mne-bids-importer` branch) is **delegated local execution**, distinct from the bundled offline MEG converter: it runs the user's local Python `mne`/`mne_bids` (0.14–<0.21) over one raw **file** (`.fif`/`.edf`/`.bdf`). The trust boundary is Rust-owned end to end (`src-tauri/src/import_mne_bids.rs`): Rust probes the interpreter (fixed candidate allowlist + PATH backfill — `probe_mne_bids_interpreter`), token-validates the raw file, detects + reads the ranked events sibling (`detect_mne_events`), writes a 0o600 options JSON, and spawns `<interpreter> <bundled-runner> <json>` (`run_mne_bids_import`) into a self-cleaning `$APPCACHE/mne-bids-stage-<uuid>` tree (the runner at `resources/common/importers/mne_bids_runner.py` redirects stdout→stderr so stdout is exactly one JSON object). The renderer merges the staging tree into an **empty** destination with OS-native `fs.copyFile` + a wholesale `recordCreatedTree` (reversible from History; multi-GB recordings never enter the JS heap). The wizard (`Import.svelte` mne-bids branch) shows a file picker (not a DICOM folder), the resolved interpreter + versions (trust-boundary line), and an events code→name table that blocks Run until every detected code is named (decision 8). Renderer code: `src/lib/import/{pythonInterpreter,mneEventsFile,mneBidsRunner,mneBidsDetectionTauri,runMneBidsImport}.ts` + `importMneBids` in `actions.ts`. Spec: `git log` + ROADMAP "MNE-BIDS importer"; audit: `git log`.

### 9.9 i18n discipline

UI strings go through `$_(…)`. **BIDS data values do not.** Sidecar fields, entity labels (`sub-`, `T1w`), validator codes stay canonical English with `.`-as-decimal-separator regardless of locale.

- **Native menus** (`appMenu.ts`, `contextMenu.ts`) are intentionally English-only for v1 — they pass literal strings to Tauri's `Menu.popup()` API and don't route through `$_(…)`.
- `bun run check-i18n` verifies every `$_('key')` exists in `en.json`. Can't catch new untracked-string menu items; document them in `src/AGENTS.md` if you add any.
- RTL-ready (CSS logical properties, explicit `dir="ltr"`) but not shipped.

### 9.10 Merge datasets (alpha)

"Merge datasets" (Launch screen → workspace-modal `MergeWindow`) combines one **recipient** plus one-or-more **donors** in place into the recipient, preview-first and reversibly. Isolated alpha track like Dashboard / Share / AI: code under `src/lib/merge/` + `src/lib/components/merge/`, with four integration points (`appView.mergeOpen`, the `<MergeWindow/>` branch in `+page.svelte`, the Launch button, and `actions.ts` thin wrappers). Spec: `git log` + ROADMAP "Merge datasets".

The core is a **pure planner + executor split** (mirrors the import post-pass): `preflight.ts` (overlap blocks, path-free source manifests, pointer/PHI warnings) → `collisions.ts` (cumulative donor-order subject/session collision detection + next-free-label renumber + same-person fold; sessionless-same is refused) → `copyScope.ts` (copy-with-remap file list via the shared `rename/tokenReplace.ts` word-boundary substitution, subject-scoped derivatives/sourcedata per policy, unfetched-pointer skip, clobber detection) → `reconcileMetadata.ts` (fill-missing participants.tsv / participants.json / sessions.tsv union + dataset_description list-union + .bidsignore line-union) → `computeMergePlan.ts` (the pure orchestrator returning a fully-resolved, re-runnable `MergePlan`). `provenance.ts` builds the durable, path-free `sourcedata/bidsvue_merge_provenance.json` + CHANGES entry (tests assert no absolute paths / no PHI values). `applyMergePlan.ts` runs an unblocked plan as ONE reversible `'merge'` `OperationContext` (`ctx.copyInto` for OS-native binary copies, read+token-remap+write for renumbered `.tsv`/`.json`, backed-up metadata writes; rolls back on any failure incl. cancellation). The whole pure core is bun-tested without a running app; the executor is tested on disk with a node:fs adapter (defaced-donor merge + bit-for-bit undo + multi-donor single-op-log + cancellation rollback). v2 "Harmonize" (Entity Set / Parameter Group heterogeneity) is deliberately out of scope — see ROADMAP §2.

### 9.11 Task events (alpha)

Authoring BIDS `_events.tsv` files (+ an inheritable `_events.json` column-description scaffold) for functional runs, through the tree context menu and an `author-events` AI stock prompt. Isolated alpha track: pure logic under `src/lib/events/`, one preview dialog at `src/lib/components/EventsCloneDialog.svelte`, pure menu-gating at `src/lib/menu/eventsMenu.ts`; no top-level Window. Spec: `git log` + ROADMAP "Task events".

Same **pure planner + executor split** as merge / the import post-pass. `eventsPaths.ts` derives the echo-collapsed `_events.tsv` path for a BOLD run via the canonical `parseFilename`/`entitiesToPrefix` parser (no echo-strip regex — `echo` is a typed entity dropped by object-omit) plus the task-coverage rule for inheritable sidecars; `eventsTemplate.ts` builds the header-only TSV (reusing the importer's `EVENTS_TSV_HEADER` const) and the `_events.json` scaffold; `cloneTargets.ts` is the task-pinned matcher (enumerate `index.bySuffix.get('bold')`, filter to NIfTI runs outside `derivatives`/`sourcedata`/`code`, partition into create / skip / un-fetched-pointer, multi-echo collapse with fetched-echo-wins); `computeEventsPlan.ts` is the pure orchestrator returning a fully-resolved `EventsPlan` for create or clone. `applyEventsPlan.ts` runs an unblocked plan as ONE reversible `'events'` `OperationContext` — every events file is a **no-clobber create** (`ctx.writeNewText` → `finalizeNewFileNoReplace`), so clone is create-only-where-missing. The clone action wrapper (`applyEventsClonePlan`) RE-READS the source bytes and RECOMPUTES the plan against the current dataset under the lease, refusing with `EventsStaleError` when the fresh plan is blocked or its review signature differs from the preview (source edited/deleted, or dataset switched) — mirroring merge's recompute-under-lease; the no-clobber finalize is the last-line guard for a target that materialises mid-apply (clean LIFO rollback, not a clobber). The same module's `applyTaskNameBackfill` handles the one-click "Add TaskName" via the shared `mergeTaskNameIntoSidecar` primitive. The pure core is bun-tested; the executor is tested on disk with a node:fs adapter (create + scaffold + undo, clone-of-N + undo, no-clobber preservation, TaskName backfill). The events UI surface is English-only for alpha (the native menu is English-only by policy; the dialog carries no `$_()` keys); only the AI prompt routes through i18n. v1 does NOT parse vendor stimulus logs (bidscoin / ezBIDS territory) — see ROADMAP §2.

## 10. Persistence layout

| Scope | Where | What |
|---|---|---|
| Application | `tauri-plugin-store` in OS config dir | Last-opened dataset, recent datasets, window geometry, theme, validator display mode, default tool preferences |
| Per-dataset | `<appDataDir>/datasets/<safeKey>/` | `prefs.json`, `operations.log` (JSONL), `originals/<opId>/` byte backups, `meta.json` (datasetRoot ↔ safeKey reverse lookup) |
| Trust set | `<appDataDir>/trust/trusted_dataset_roots.json` | Rust-managed; renderer denied via `fs:scope.deny` |
| Deface mirror | `<dataset>/sourcedata/` | Pristine NIfTI bytes (the one in-dataset exception) |

## 11. Performance budget (as-shipped)

| Operation | Target | Measured |
|---|---|---|
| Open 5,000-file dataset | < 2 s | ✓ |
| Open 100,000-file dataset | < 10 s; tree usable while remaining nodes stream in | 1.42 s on synthetic benchmark — 3.5× under spec budget |
| Tree scroll | 60 fps with 50,000 visible-able rows | ✓ (virtualization) |
| Single sidecar save + revalidate | < 500 ms | ✓ |
| Full-dataset re-validate (5,000 files) | < 30 s background | ✓ (lazy `TauriFileOpener` keeps memory sub-GB) |

Bench gate: `bun run bench:scanner` against `bench/baselines/scanner.json`. CI fails when the scan exceeds 2.5× the committed baseline (threshold sized for runner variance).

## 12. Testing strategy

- **TS unit + integration** (`bun test`): 1863 tests across 152 files cover entity parser, pairing, rename engine (with conflict detection), backup/undo, scanner fixtures, importer orchestrators, post-passes, lease conflict matrix, DataLad pointer + subdataset + cycle-guard paths, batch deface, the clone-URL leaf-name suggester, the runner's AbortSignal cancellation wiring (clone/get/save/revert), the native `bidsvueAnnexRunner` selector + invoke shape + fallback behaviour, operations-log child validation, and the bulk-fetch chunking / bounded-verification helpers.
- **Property tests** (`fast-check`) where round-trips apply.
- **Rust** (`cargo test --workspace`; ignored end-to-end fixtures via `scripts/check-datalad-native.sh`): `bidsvue` covers trust/process/cloud-share/runtime boundaries and command-layer orchestration; the vendored `datalad-rs` crate covers engine behavior, URL validators, remote parsing, key/hashdir/journal logic, clone/subdataset layout, status/save/revert/update, and content verification.
- **E2E** (WebdriverIO + `tauri-driver`): happy-path open-and-validate against `tests/fixtures/tiny-bids/`, plus a Linux WebKitGTK NiiVue render gate (`BIDSVUE_E2E_REQUIRE_VIEWER_RENDER=1`) that requires WebGL2 attach and nonblank canvas pixels. Renderer honors `BIDSVUE_TEST_OPEN_DATASET=<abs-path>` to bypass the launch screen.

## 13. Forward-compatibility

The architecture preserves these even though we don't build them now:

- **Cloud / remote datasets.** All filesystem access goes through TS interfaces on top of `@tauri-apps/plugin-fs`. Future implementations (S3, WebDAV, Globus, OpenNeuro, DataLad) implement the same interface. There is no Rust core to port. DataLad / git-annex pointer files are detected by the scanner via Rust `read_link` + `PointerInfo` metadata on `NodeFlags.pointer`. Current coverage: tree badging, validator filtering with visible skipped-unfetched status, preview gating, deface refusal, fetch buttons and bulk fetches via `datalad_native_get`, subdataset install, dirty-tree status, save/revert, and per-handle cancellation. Nested-subdataset detection remains on the roadmap. Push to upstream is intentionally out of scope — "Share these changes upstream…" opens Cloud Share.
- **Browser / mobile.** The renderer is the entire app. Targeting a browser build means swapping the Tauri plugin layer for HTTP/WebSocket. Nothing else changes.
- **Plugins.** External tool definitions live in declarative TS manifests (id, kind, argv builder, post-pass). Adding a new importer is one descriptor + one argv validator (TS + Rust). No plugin loader yet, but the slot exists.

## 14. Tech inventory (concrete)

- **Shell:** Tauri 2.x. Rust surface is security-boundary code: trust/scope, process sidecars, validator sidecar, DataLad command boundary, share token/upload helpers, and the AI bridge. The DataLad engine itself lives in the vendored `datalad-rs` crate.
- **Application code:** TypeScript everywhere. All BIDS logic, FS access, sidecar orchestration, validation, and rendering live in the renderer + Web Workers.
- **Renderer:** Svelte 5 + TypeScript, Vite, SvelteKit (static SPA).
- **Tauri plugin APIs (TS, official):** `@tauri-apps/plugin-fs`, `-dialog`, `-store`, `-os`. No `plugin-shell`.
- **Data model:** plain TS structures (Maps, Sets, plain objects). No SQLite / IndexedDB.
- **Editor component:** Monaco (raw JSON view); custom Svelte form components for the schema-driven view.
- **Viewer:** [`@niivue/niivue`](https://github.com/niivue/niivue) — npm `1.0.0-rc.10`, imported via the universal entry (`attachToCanvas` runtime-selects WebGPU, falls back to WebGL2) so the renderer can call `loadSignals(...)` / `removeAllSignals()` / `setSignal(...)` for physio overlays. Default export is `NiiVueGPU`; `destroy()` exists. Was a `file:../mono/packages/niivue` sibling build during M-PHY0; re-pinned to npm 2026-07-01 (dropped the `@niivue/dev-images` `overrides` entry + `bunfig.toml`'s `linker = "hoisted"`), so `scripts/macos-release.sh`'s `file:`/`link:`/relative-dep + `bunfig.toml`-linker gate is satisfied.
- **Validator:** bundled `bids-validator-rs` sidecar by default; optional [`@bids/validator`](https://www.npmjs.com/package/@bids/validator) 2.4.1 JS fallback, pre-bundled offline by esbuild and run in-WebView.
- **Schema:** Extracted from `@jsr/bids__schema` to `static/_validator.schema.json` at bundle time.
- **External binaries (bundled Tauri sidecars):** `dcm2niix`, `niimath`, `bids-validator` (macOS arm64, Linux x86_64, Windows x86_64). `niimath` is a BSD-2 build on every platform.
- **External binaries (optional, PATH-detected):** `heudiconv`, `dcm2bids`.
- **In-process WebGPU model:** `mindgrab` / `mindgrab8` (tinygrad-generated WGSL; weights at `resources/common/mindgrab/`).
- **i18n:** [`svelte-i18n`](https://github.com/kaisermann/svelte-i18n) with ICU MessageFormat, JSON catalogs under `src/lib/i18n/locales/`.
- **Package manager + runtime:** [Bun](https://bun.sh).
- **Lint + format:** [Biome](https://biomejs.dev/).
- **Testing:** Bun (TS), `cargo test` (Rust), WebdriverIO + `tauri-driver` (E2E).
- **CI:** GitHub Actions. The notarized macOS release path remains local; the cross-platform bundle workflow builds unsigned Linux x86_64 and Windows x86_64 artifacts from committed sidecars. Static checks (lint / typecheck / Bun tests / cargo fmt), scanner bench, and Linux WebKitGTK e2e render smoke run on Linux; full Rust workspace tests run in the bundle workflow on Linux.
