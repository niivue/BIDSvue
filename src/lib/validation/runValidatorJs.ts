// JS-backend implementation of the BIDS validator runner.
//
// Selected by the dispatcher in `./runValidator.ts` when the build is
// compiled with the default `VITE_BIDSVUE_VALIDATOR_BACKEND=js` (or
// the env var is unset). The companion `runValidatorRust.ts` shells
// out to the bundled `bids-validator-rs` sidecar instead.
//
// Original M3 Phase B + Codex `ram.md` follow-up: run the BIDS validator
// against an open Dataset using a memory-light file adapter.
//
// Previously this module built a browser `File[]` by `readFile()`-ing
// every in-scope file into memory before calling the validator's
// `fileListToTree(files)`. For real datasets that's catastrophic —
// the BIDS validator's NIfTI rules only need `readBytes(1024, 0)` for
// the header, but the eager adapter materialised the entire 800 MB
// payload of every functional run into WebView RAM (see `ram.md` +
// audit M-6).
//
// Replacement: a `TauriFileOpener` that implements the validator's
// `FileOpener` interface with TRUE range reads, backed by
// `@tauri-apps/plugin-fs::open` → `FileHandle.seek` → `FileHandle.read`.
// We construct one `BIDSFile` per in-scope candidate, hand the array
// to the validator's lower-level `filesToTree`, then `validate` it.
// Memory now scales with file COUNT + per-file METADATA, not byte
// payload — opening ds002606 should stay under ~700 MB at peak even
// though the dataset is 16 GB on disk.

import { isInValidatorScope } from '$lib/bids/level'
import type { Dataset, FileNode } from '$lib/bids/types'
import { relativizeFromRoot } from '$lib/state/persistence'
import { raceWithAbort } from '$lib/util/abort'
import { detectSeparator } from '$lib/util/paths'
import {
  readTextFileWithRustFallback,
  resolveSymlinkIfPresent,
} from '$lib/util/readTextFile'
import {
  type FileHandle,
  SeekMode,
  exists,
  open,
  readTextFile,
  stat,
} from '@tauri-apps/plugin-fs'
import type {
  FileOpener,
  FileTree,
  ValidationResult,
  BIDSFile as ValidatorBIDSFile,
  FileIgnoreRules as ValidatorIgnoreRules,
} from './_validatorEntry'
import { appendDateLintIssues } from './dateInNameCheck'
import { transformPointerIssues } from './pointerIssueTransform'

export type {
  Issue,
  IssueSeverity,
  ValidationResult,
} from './_validatorEntry'

/**
 * Wrapper around the upstream `ValidationResult` plus the count of
 * files BIDSvue refused to feed to the validator. Today only
 * un-fetched DataLad / git-annex pointers are skipped; the count
 * surfaces in the status bar so a partial-validation result is
 * never silent.
 */
export interface BidsvueValidationResult {
  result: ValidationResult
  pointerSkippedCount: number
}

export interface RunValidatorOptions {
  /**
   * Abort-on-cancel. The validator itself doesn't take a signal, but
   * the pre-validation tree-build pass does — a long-running open that
   * gets superseded shouldn't keep grinding through stat()s.
   */
  signal?: AbortSignal
}

/**
 * Validator `FileOpener` backed by Tauri's plugin-fs `FileHandle`. The
 * key win over the previous `BrowserFileOpener(File)` adapter: range
 * reads use `seek` + `read(buffer)` against an OS file descriptor.
 * The 800 MB NIfTI payload never enters WebView memory; only the
 * 1 KB header bytes the validator's NIfTI rule actually requests.
 *
 * `size` is captured at construction time via `stat()`. The validator
 * uses it (a) for NIfTI rule heuristics and (b) for full-file JSON /
 * TSV reads (`readBytes(file, file.size)` in json.ts). Stat is cheap
 * (~µs per file on macOS) so per-file pre-stat is a fine cost.
 */
class TauriFileOpener implements FileOpener {
  readonly path: string
  readonly size: number

  constructor(path: string, size: number) {
    this.path = path
    this.size = size
  }

  async readBytes(size: number, offset = 0): Promise<Uint8Array> {
    if (size <= 0) return new Uint8Array(0)
    let handle: FileHandle | null = null
    try {
      handle = await open(this.path, { read: true })
      if (offset > 0) {
        await handle.seek(offset, SeekMode.Start)
      }
      const buf = new Uint8Array(size)
      const nread = await handle.read(buf)
      const count = typeof nread === 'number' ? nread : 0
      return buf.subarray(0, count)
    } finally {
      if (handle !== null) {
        await handle.close().catch(() => {
          /* best-effort */
        })
      }
    }
  }

  async text(): Promise<string> {
    // UTF-8 decoded full read. Used by the validator's JSON / TSV /
    // .bidsignore paths.
    return readTextFile(this.path)
  }

  async stream(): Promise<ReadableStream<Uint8Array>> {
    // Used by the validator's TSV / TSV.GZ paths via `openStream(file)`
    // (`@bids/validator/src/files/{access,tsv}.ts`). NIfTI validation
    // does NOT come through here — it takes the bounded `readBytes(1024,
    // 0)` path for headers.
    //
    // Current implementation reads the whole file into one chunk before
    // yielding. Acceptable today because BIDS TSVs (participants /
    // events / motion regressors) are kilobyte-to-megabyte, not GB.
    // **Future large-TSV risk** tracked in LIMITATIONS.md
    // "Validator caveats" + ROADMAP.md's "Streaming TSV reader" row:
    // replace with a chunked reader over `readBytes(chunkSize, offset)`
    // when a real dataset exercises the path.
    const bytes = await this.readBytes(this.size, 0)
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
  }
}

/**
 * Build a validator `FileTree` from the dataset's in-scope file nodes,
 * using lazy `TauriFileOpener` per file. Replaces the old eager
 * `datasetToFileList` + `fileListToTree` pair.
 *
 * Steps:
 *   1. Filter the in-memory index to validator-scope files.
 *   2. For each: stat() to capture size; skip if stat fails (a
 *      first-class diagnostic surface is queued for a future audit
 *      follow-up — for now we drop with a console.warn, matching the
 *      old code's behaviour).
 *   3. Construct a `BIDSFile` whose `path` is dataset-relative POSIX
 *      and whose `opener` is a `TauriFileOpener` over the absolute
 *      path.
 *   4. Inject `.bidsignore` from disk if it exists but wasn't surfaced
 *      by the scanner (showHiddenFiles=off filters dotfiles).
 *   5. `filesToTree(bidsFiles, ignore)` to build the FileTree, then
 *      apply `.bidsignore` patterns via `readBidsIgnore`.
 */
async function datasetToBidsTree(
  dataset: Dataset,
  bundle: typeof import('./_validator.bundle.js'),
  signal?: AbortSignal,
): Promise<{ tree: FileTree; pointerSkippedCount: number }> {
  const { BIDSFile, FileIgnoreRules, filesToTree, readBidsIgnore } = bundle
  const sep = detectSeparator(dataset.root)
  const ignore = new FileIgnoreRules([]) as ValidatorIgnoreRules & {
    add(patterns: string[]): void
  }

  // Walk the scanner's index for in-scope file nodes. Mirrors the old
  // adapter's scope predicate so the validator's view stays in sync
  // with the tree's special-folder classification.
  //
  // DataLad / git-annex pointer files with `contentPresent: false`
  // are filtered out here. The validator's NIfTI rule does
  // `readBytes(1024, 0)` against the symlink target — an un-fetched
  // pointer would ENOENT and crash the rule. Sidecars + small text
  // files are stored as regular files by default (the dataset's
  // `.gitattributes` excludes JSON/TSV/bvec/bval from annex), so
  // those still validate.
  const candidates: FileNode[] = []
  let pointerSkipped = 0
  for (const node of dataset.index.byPath.values()) {
    if (node.kind !== 'file') continue
    if (!isInValidatorScope(node.flags)) continue
    if (
      node.flags.pointer !== undefined &&
      node.flags.pointer.contentPresent === false
    ) {
      pointerSkipped++
      continue
    }
    candidates.push(node)
  }
  if (pointerSkipped > 0) {
    console.info(
      `[validator] skipped ${pointerSkipped} un-fetched DataLad / git-annex pointer file(s) (run \`datalad get\` to include them)`,
    )
  }
  const total = candidates.length
  const startedAt = performance.now()
  let built = 0
  let skipped = 0

  const bidsFiles: ValidatorBIDSFile[] = []
  for (const node of candidates) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const rel = relativizeFromRoot(dataset.root, node.path)
    if (rel === null) continue

    // Capture size up-front; some validator rules read it (e.g.
    // json.ts: `readBytes(file, file.size)`). Stat failure is the
    // common "Tauri fs:read scope forbids this deep dotpath" case;
    // skip silently with a console.warn, same as the old code did
    // for readFile failures.
    //
    // Fetched DataLad / git-annex pointer files need two
    // adjustments here:
    //   1. Their on-disk path is a symlink. plugin-fs's `stat()`
    //      runs through Tauri's `try_resolve_symlink_and_canonicalize`
    //      which returns relative `read_link()` targets verbatim
    //      and ultimately rejects the path. Result: every fetched
    //      pointer file was silently dropped from the validator
    //      tree, surfacing as `SIDECAR_WITHOUT_DATAFILE` errors on
    //      the companion sidecars (which DID validate).
    //   2. The annexed size is already recorded on the PointerInfo
    //      so we don't need to stat at all for these.
    // For non-pointer files we keep the existing stat() path.
    let fileSize: number
    let openerPath = node.path
    const pointer = node.flags.pointer
    if (pointer !== undefined && pointer.contentPresent === true) {
      fileSize = pointer.size
      // Resolve the symlink target to absolute so plugin-fs's
      // open/read inside `TauriFileOpener` operates on the
      // canonical annex-object path (which our open-dataset
      // `apply_widen_dataset` carve-out widens) instead of the
      // symlink path that scope canonicalization rejects. Shares
      // the helper with `tauriMutateFs` + NiivueViewer so the
      // workaround lives in one place.
      openerPath = await resolveSymlinkIfPresent(node.path)
    } else {
      try {
        const info = await stat(node.path)
        fileSize = info.size
      } catch (err) {
        skipped++
        if (skipped <= 5) {
          console.warn(`[validator] skipping unstattable ${node.path}:`, err)
        }
        continue
      }
    }

    const opener = new TauriFileOpener(openerPath, fileSize)
    // BIDSFile's `path` MUST start with `/` — the validator's
    // `filesToTree` does `parts.dir.split('/').slice(1)` to walk the
    // tree, which only works when the first segment is the empty
    // string from a leading slash. The previous `BIDSFileBrowser`
    // adapter got this for free via webkitRelativePath substring;
    // we have to add it explicitly. Without the slash, `sub-04/anat/
    // foo.json` becomes `anat/foo.json` in the validator's view and
    // every file collapses to `NOT_INCLUDED` (no subject scope).
    const bidsFile = new BIDSFile(
      `/${rel}`,
      opener,
      ignore,
    ) as ValidatorBIDSFile
    bidsFiles.push(bidsFile)
    built++
    if (built % 5000 === 0) {
      const elapsed = (performance.now() - startedAt) / 1000
      console.info(
        `[validator] built ${built}/${total} (${elapsed.toFixed(1)}s)`,
      )
    }
  }

  // Inject .bidsignore from disk when the scanner filtered it (dotfile
  // hidden by default). The lazy adapter still benefits from the
  // ignore patterns even though the opener-per-file model means the
  // validator's tree-walk decides what's actually read.
  const bidsignoreAbs = `${dataset.root}${sep}.bidsignore`
  if (
    !dataset.index.byPath.has(bidsignoreAbs) &&
    (await exists(bidsignoreAbs).catch(() => false))
  ) {
    try {
      const info = await stat(bidsignoreAbs)
      const opener = new TauriFileOpener(bidsignoreAbs, info.size)
      // Same leading-slash requirement as the candidate-file BIDSFile
      // construction above.
      const bidsFile = new BIDSFile(
        '/.bidsignore',
        opener,
        ignore,
      ) as ValidatorBIDSFile
      bidsFiles.push(bidsFile)
    } catch (err) {
      console.warn('[validator] could not inject .bidsignore:', err)
    }
  }

  if (skipped > 0) {
    console.info(
      `[validator] skipped ${skipped} unstattable file(s) (see warnings above)`,
    )
  }
  // Tree-build timing is captured by the wider validator timer in
  // actions.ts and surfaced in the end-of-cycle summary; intermediate
  // info logs were trimmed back so back-to-back rescans (defacing
  // triggers one in `withOpenDatasetAndRescan` finally) don't flood
  // the console.

  const tree = filesToTree(bidsFiles, ignore) as FileTree
  // Apply .bidsignore patterns to the rules so subsequent validator
  // walks honour the user's per-dataset out-of-scope list. Mirrors
  // the upstream `fileListToTree`'s post-build step.
  const treeWithGet = tree as { get(p: string): unknown }
  const bidsignoreNode = treeWithGet.get('.bidsignore') as
    | ValidatorBIDSFile
    | undefined
  if (bidsignoreNode !== undefined) {
    try {
      ignore.add(await readBidsIgnore(bidsignoreNode))
    } catch (err) {
      console.warn('[validator] could not read .bidsignore patterns:', err)
    }
  }
  return { tree, pointerSkippedCount: pointerSkipped }
}

/**
 * Run the validator against a Dataset and return its raw result plus
 * BIDSvue-side bookkeeping (un-fetched pointer skip count). Does not
 * touch any global state; the caller (actions.ts) decides what to do
 * with the result.
 *
 * The validator is lazy-imported from a self-contained esbuild bundle
 * (src/lib/validation/_validator.bundle.js, generated by
 * scripts/bundle-validator.ts; gitignored).
 */
export async function runValidatorJs(
  dataset: Dataset,
  options: RunValidatorOptions = {},
): Promise<BidsvueValidationResult> {
  const validatorModule = await import('./_validator.bundle.js')
  const { tree, pointerSkippedCount } = await datasetToBidsTree(
    dataset,
    validatorModule,
    options.signal,
  )
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  // ValidatorOptions has a lot of CLI-shaped fields we don't care about.
  // The library accepts a minimal object; only datasetPath, debug,
  // datasetTypes, and blacklistModalities appear to be load-bearing.
  //
  // Abort propagation (M3-audit row partial-fix, 2026-05-15):
  // upstream `validate()` doesn't accept an AbortSignal. The IO-heavy
  // paths abort cleanly because the signal threads through
  // datasetToBidsTree + the BIDSFile readers — when readBytes throws
  // AbortError, the validator's per-context check propagates it up.
  // The gap: pure-CPU checks between IO points keep running until
  // they naturally complete. `raceWithAbort` makes the OUTER await
  // return immediately on signal abort so the caller's UI flag
  // (`diagnosticsStore.isValidating`) clears without waiting; the
  // underlying CPU work finishes in the background but its result
  // is discarded. Real hard-cancel needs a Web Worker (v0.2 — see
  // LIMITATIONS.md "Validator caveats" + ROADMAP.md's v0.2 priorities).
  const result = await raceWithAbort(
    validatorModule.validate(tree, {
      datasetPath: dataset.root,
      debug: 'ERROR',
      datasetTypes: ['raw', 'derivative'],
      blacklistModalities: [],
    }),
    options.signal,
  )
  // Audit-round-29 follow-up: when we filter un-fetched DataLad
  // pointer files out of the candidate list (above), any sidecar
  // whose companion is one of those pointers fires as a
  // `SIDECAR_WITHOUT_DATAFILE` error. The data file IS in the
  // dataset — it just hasn't been fetched — so emitting an ERROR is
  // misleading. Transform those specific errors into warnings with
  // a dedicated `POINTER_NOT_FETCHED_SIBLING` code. Real
  // SIDECAR_WITHOUT_DATAFILE errors (sidecar truly orphaned, no
  // companion at any state) pass through unchanged.
  //
  // `result.issues` is a `DatasetIssues` (Map-shaped) container; the
  // actual array lives at `result.issues.issues`.
  if (pointerSkippedCount > 0) {
    result.issues.issues = transformPointerIssues(result.issues.issues, dataset)
  }
  // BIDSvue privacy lint: flag date-like sub-/ses- labels + real (unshifted)
  // acq_time dates in scans.tsv (review before sharing). Rebuild the whole
  // `DatasetIssues` container so `issues` / `size` / `entries()` stay mutually
  // consistent — appending to `.issues` alone leaves the upstream container's
  // `.size` + `.entries()` stale (audit 2026-06-27 P3).
  const finalIssues = await appendDateLintIssues(
    result.issues.issues,
    dataset,
    readTextFileWithRustFallback,
  )
  result.issues = {
    issues: finalIssues,
    size: finalIssues.length,
    codeMessages: result.issues.codeMessages,
    entries: () => finalIssues.map((i, idx) => [String(idx), i] as const),
  }
  return { result, pointerSkippedCount }
}
