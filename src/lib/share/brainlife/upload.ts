/**
 * Brainlife upload orchestrator (M4).
 *
 * Mirrors the CLI's `bl-bids-upload.js` step list:
 *
 *   1. (caller) walk BIDSvue's Dataset into [BrainlifeUploadCandidate]s
 *   2. createBrainlifeProject(name, desc, readme)
 *   3. loadDatatypeCatalog(jwt) — cached after one call
 *   4. findOrCreateBrainlifeInstance(`upload.<group_id>`, project)
 *   5. for each candidate:
 *        a. submitBrainlifeNoopTask(...)
 *        b. pollUntilTaskReadyForUpload(taskId)
 *        c. read+build tar of files, gzip, uploadBrainlifeArchive
 *        d. registerBrainlifeDataset(...)
 *   6. write share.json with link + manifest entries
 *
 * Progress is per-dataset (the CLI does the same) because brainlife's
 * upload API expects one tar per dataset and gives no within-tar
 * progress signal. Cancellation flips an [AbortSignal] that every
 * fetch + the inter-call delay honour; the modal renders a single
 * Cancel chip per the spec ("same UX as DataLad fetch").
 *
 * In-memory tar.gz is the conservative choice for M4. The v0.2
 * wishlist tracks a streaming variant; the goal explicitly defers
 * the 10GB+ case until measured.
 */

import type { Dataset } from '$lib/bids/types'

import { type ManifestIo, defaultManifestIo, walkManifest } from '../manifest'
import {
  type PendingIo,
  type ShareUploadIntent,
  defaultPendingIo,
  openIntent,
  updateIntentRecovery,
} from '../pending'
import type { ManifestEntry } from '../types'
import type { ShareLink, UploadProgress } from '../types'

import {
  type BrainlifeCreatedProject,
  type FetchLike,
  createBrainlifeProject,
  findOrCreateBrainlifeInstance,
  getBrainlifeProjectById,
  pollUntilTaskReadyForUpload,
  refreshJwt,
  registerBrainlifeDataset,
  scrubJwtLike,
  submitBrainlifeNoopTask,
  uploadBrainlifeArchive,
  waitForBrainlifeDatasetStored,
} from './api'
import { type BrainlifeUploadCandidate, walkForUpload } from './bidsWalker'
import { brainlifeProjectUrl, loadDatatypeCatalog } from './query'
import { type TarEntry, buildTar, gzip } from './tar'

/**
 * Per-candidate byte cap for brainlife uploads. The current tar +
 * gzip path holds in WebView memory: read buffer (input bytes) +
 * tar buffer (~input + overhead) + gzip buffer (compressed; for
 * incompressible NIfTI bytes ~= input) + fetch/request buffering.
 * Peak memory for an incompressible near-cap candidate can reach
 * 3-4× the input, so a 1 GiB cap could still drive the renderer
 * past 4 GiB and OOM on 32-bit-V8 configurations or memory-pressured
 * macOS WebViews.
 *
 * Audit 2026-06-12 P2 lowered the cap from 1 GiB to 256 MiB. The
 * value is an ARITHMETIC ESTIMATE (input + tar + gzip + fetch ≈ 4×
 * input ≈ 1 GiB worst case) sized to leave headroom inside the
 * WebView's default heap on memory-pressured 64-bit macOS — NOT a
 * measured ceiling. Empirical headroom measurement is queued as a
 * v0.2 beta-tester smoke. Audit 2026-06-11 P2 established the gate;
 * the 2026-06-12 round tightened the value after the auditor
 * pointed out the 3-4× peak math; 2026-06-12 internal P3 follow-up
 * relabelled the rationale as estimated not measured.
 *
 * The cap lifts when the Rust streaming tar builder lands (ROADMAP
 * "Cloud share — brainlife"). Until then, the user-facing refusal
 * message is load-bearing UX (testers will encounter it).
 */
const MAX_BRAINLIFE_CANDIDATE_BYTES = 256 * 1024 * 1024

export interface UploadOrchestrationDeps {
  fetcher: FetchLike
  manifestIo: ManifestIo
  /** Pending-intent IO seam — when omitted defaults to `defaultPendingIo`. */
  pendingIo?: PendingIo
  /** Optional clock injection for tests. */
  now(): Date
  /**
   * Optional hook to persist a refreshed JWT to the trust store so
   * follow-up modal interactions use the new token. brainlife's group
   * membership for a freshly-created project only lands in the JWT after
   * a refresh; without persisting the refreshed value, the next session
   * starts from the stale pre-project token. Best-effort: a persistence
   * failure is logged but does not abort the upload.
   */
  tokenPersist?: (jwt: string) => Promise<void>
}

export const defaultUploadDeps: UploadOrchestrationDeps = {
  fetcher: fetch,
  manifestIo: defaultManifestIo,
  pendingIo: defaultPendingIo,
  now: () => new Date(),
}

export interface OrchestratorInputs {
  dataset: Dataset
  /** Absolute dataset root — used to key the per-dataset pending intent
   * file. (`dataset.root` carries the same value; we accept it as an
   * explicit parameter so the orchestrator stays decoupled from the
   * Dataset type's evolution.) */
  datasetRoot: string
  jwt: string
  /** Display name for the new brainlife project. */
  projectName: string
  /** Optional human description. */
  description?: string
  /** README contents (we ship the BIDSvue scanner's dataset README
   * when available — caller pre-reads it). */
  readme?: string
  signal: AbortSignal
  progress(p: UploadProgress): void
  /** When pushing an update to an existing brainlife project, pass
   * the project's `_id` here so the orchestrator skips
   * `createBrainlifeProject`. M5's incremental push uses this. */
  existingProjectId?: string
  /** When set, only the supplied candidates are uploaded. Used by
   * `pushUpdate` to send just the changed scans rather than the
   * whole dataset. */
  candidatesOverride?: BrainlifeUploadCandidate[]
}

export interface OrchestratorResult {
  link: ShareLink
  entries: ManifestEntry[]
  /** Pending-intent record still on disk at exit. The backend's
   * `upload()` / `pushUpdate()` clears it AFTER `share.json` lands.
   * Null when no intent was opened (the existingProjectId path: an
   * incremental push that reuses an existing share.json). */
  pendingIntent: ShareUploadIntent | null
}

/**
 * Run the full upload pipeline. Returns the persistent link + the
 * manifest entries the backend writes into share.json. Errors are
 * thrown — the caller's `try/finally` is responsible for
 * surfacing them in the modal.
 */
export async function orchestrateBrainlifeUpload(
  input: OrchestratorInputs,
  deps: UploadOrchestrationDeps = defaultUploadDeps,
): Promise<OrchestratorResult> {
  const { dataset, signal, progress } = input
  // `jwt` becomes mutable so we can swap in a refreshed token after
  // creating a brainlife project — brainlife encodes the user's group
  // memberships into the JWT, and the freshly-allocated project's
  // group isn't reflected until the next refresh. Without this swap
  // the very next call (`findOrCreateBrainlifeInstance`) gets a 500
  // with "not member of the group you have specified" (matches the
  // CLI's known workaround in `bl-bids-upload.js` line ~50).
  let jwt = input.jwt
  const candidates =
    input.candidatesOverride ?? walkForUpload(dataset).candidates
  if (candidates.length === 0) {
    throw new Error(
      'No uploadable scans (M4 supports anat / func / dwi / fmap / pet / meg / eeg).',
    )
  }

  // 1. Resolve datatype ids by name. Cached at the catalog layer so
  // repeated upload runs don't re-fetch.
  progress({
    bytesUploaded: 0,
    bytesTotal: null,
    filesUploaded: 0,
    filesTotal: candidates.length,
    message: 'Loading brainlife datatype catalog…',
  })
  const datatypes = await loadDatatypeCatalog(jwt, {
    signal,
    fetcher: deps.fetcher,
  })
  const datatypeIdByName = new Map<string, string>()
  for (const d of datatypes) datatypeIdByName.set(d.name, d._id)
  const missing = new Set<string>()
  for (const c of candidates) {
    if (!datatypeIdByName.has(c.datatype)) missing.add(c.datatype)
  }
  if (missing.size > 0) {
    throw new Error(
      `Brainlife is missing the following datatypes that BIDSvue mapped to: ${[...missing].join(', ')}. Please contact the brainlife admins.`,
    )
  }

  // 2. Create the project, OR look up an existing one if pushing an
  // update. For first-uploads, open a pending intent BEFORE the
  // remote mutation so a subsequent crash / cancel / network drop
  // leaves a recovery pointer at share.pending.json (closes the
  // remote-orphan show-stopper from CLAUDE.md's beta-readiness scope).
  const pendingIo = deps.pendingIo ?? defaultPendingIo
  let pendingIntent: ShareUploadIntent | null = null
  let project: BrainlifeCreatedProject
  if (input.existingProjectId !== undefined) {
    progress({
      bytesUploaded: 0,
      bytesTotal: null,
      filesUploaded: 0,
      filesTotal: candidates.length,
      message: 'Resolving existing brainlife project…',
    })
    project = await getBrainlifeProjectById(
      jwt,
      input.existingProjectId,
      signal,
      deps.fetcher,
    )
  } else {
    progress({
      bytesUploaded: 0,
      bytesTotal: null,
      filesUploaded: 0,
      filesTotal: candidates.length,
      message: `Creating brainlife project "${input.projectName}"…`,
    })
    pendingIntent = await openIntent(
      input.datasetRoot,
      'brainlife',
      {},
      pendingIo,
      deps.now,
    )
    project = await createBrainlifeProject(
      jwt,
      {
        name: input.projectName,
        desc: input.description ?? '',
        readme: input.readme,
      },
      signal,
      deps.fetcher,
    )
    pendingIntent = await updateIntentRecovery(
      pendingIntent,
      { brainlifeProjectId: project._id },
      pendingIo,
    )
    // Brainlife caches group memberships in the JWT. The new project
    // just allocated a group, but the user's current JWT predates
    // it — so the very next amaretti call fails with "not member of
    // the group you have specified". A refresh re-issues a JWT that
    // includes the new membership. The CLI does this verbatim in
    // bl-bids-upload.js between createProject and findOrCreateInstance.
    progress({
      bytesUploaded: 0,
      bytesTotal: null,
      filesUploaded: 0,
      filesTotal: candidates.length,
      message: 'Refreshing brainlife token for the new project…',
    })
    try {
      jwt = await refreshJwt(jwt, 7, signal, deps.fetcher)
    } catch (err) {
      // If refresh fails, surface a clean message rather than letting
      // the next step throw a confusing "not member of the group"
      // 500. Users with limited token scopes can fix this by signing
      // out + re-pasting a fresh JWT from brainlife.io.
      throw new Error(
        `Couldn't refresh the brainlife token after creating the project. Sign out, paste a fresh token from brainlife.io, and try again. (${err instanceof Error ? err.message : String(err)})`,
      )
    }
    // Persist the refreshed JWT so a follow-up modal session (e.g. user
    // closes + reopens the panel after upload, or any subsequent
    // backend call that re-reads the stored token) sees the new group
    // membership. Best-effort: a persistence failure is logged but does
    // not abort the upload itself (the new JWT is already loaded into
    // the local `jwt` variable and will reach the rest of this pass).
    if (deps.tokenPersist) {
      try {
        await deps.tokenPersist(jwt)
      } catch (persistErr) {
        console.warn(
          '[brainlife] refreshed JWT was not persisted to the trust store:',
          persistErr instanceof Error ? persistErr.message : String(persistErr),
        )
      }
    }
  }

  // 3. Resolve / create the amaretti upload instance.
  const instance = await findOrCreateBrainlifeInstance(
    jwt,
    `upload.${project.group_id}`,
    project,
    signal,
    deps.fetcher,
  )
  if (pendingIntent !== null) {
    pendingIntent = await updateIntentRecovery(
      pendingIntent,
      { brainlifeInstanceId: instance._id },
      pendingIo,
    )
  }

  // 4. Stat-pass: sum total bytes across every candidate's files so
  // the progress bar has a denominator. The walk itself doesn't
  // touch the filesystem; the scanner's in-memory index doesn't
  // carry file sizes either. One stat() per file is cheap (no
  // bytes read).
  let bytesTotal = 0
  for (const c of candidates) {
    for (const f of c.files) {
      const stat = await deps.manifestIo.stat(f.absolutePath)
      f.sizeBytes = stat.size
      bytesTotal += stat.size
    }
  }
  // Audit 2026-06-11 P1 (internal follow-up): hoist the per-candidate
  // byte cap into the stat-pass so an over-cap candidate is refused
  // BEFORE any remote noop task is created. The earlier shape ran the
  // cap inside the per-candidate upload loop AFTER
  // `submitBrainlifeNoopTask` + `pollUntilTaskReadyForUpload`, which
  // left an orphaned brainlife task on the user's project plus ~10 s
  // of wasted polling for every over-cap candidate. Refuse the whole
  // upload here so no remote state changes hands.
  for (const c of candidates) {
    const candidateBytes = c.files.reduce(
      (sum, f) => sum + (f.sizeBytes ?? 0),
      0,
    )
    if (candidateBytes > MAX_BRAINLIFE_CANDIDATE_BYTES) {
      throw new Error(
        `brainlife candidate "${c.desc}" is ${formatBytes(candidateBytes)} — BIDSvue currently builds the tar archive in WebView memory and caps per-candidate uploads at ${formatBytes(MAX_BRAINLIFE_CANDIDATE_BYTES)} to avoid an OOM crash. Upload via brainlife's web UI for now; a Rust streaming tar builder is on the v0.2 roadmap.`,
      )
    }
  }
  let bytesUploaded = 0

  // 5. Per-candidate upload loop. Each candidate becomes one
  // brainlife dataset record.
  //
  // Per-candidate failures are NON-FATAL only when at least one
  // candidate succeeds — we collect them in `failedCandidates` and
  // surface a summary at the end. Brainlife's archive worker can
  // flake intermittently (FileNotFoundError on
  // `/prod-archive/.../<id>.tar` for ~5% of uploads in our testing);
  // letting the rest of the dataset land is more useful than
  // throwing the whole transaction away. If every candidate fails,
  // the all-failed guard below throws before a false link is written.
  const manifestEntries: ManifestEntry[] = []
  const failedCandidates: Array<{
    desc: string
    datatype: string
    error: string
  }> = []
  const registeredDatasetIds: string[] = []
  for (let i = 0; i < candidates.length; i++) {
    if (signal.aborted) {
      throw new DOMException('upload cancelled', 'AbortError')
    }
    const c = candidates[i]
    const taskName = `BIDSvue: ${c.desc}`
    progress({
      bytesUploaded,
      bytesTotal,
      filesUploaded: i,
      filesTotal: candidates.length,
      message: `Submitting upload task (${i + 1} / ${candidates.length}): ${c.desc}`,
    })
    const datatypeId = datatypeIdByName.get(c.datatype)
    if (datatypeId === undefined) {
      // Shouldn't happen — we pre-validated above.
      failedCandidates.push({
        desc: c.desc,
        datatype: c.datatype,
        error: 'internal: missing datatype id',
      })
      continue
    }
    try {
      // Brainlife wants the BIDS .json sidecar's contents in `meta`,
      // not in the archive (see `bids-walker.js` for the verbatim
      // pattern). Read + parse + merge once per candidate before the
      // noop task submit so the task's _outputs.meta is complete.
      let mergedMeta = c.meta
      if (c.sidecarPath !== null) {
        try {
          const bytes = await deps.manifestIo.readFile(c.sidecarPath)
          const json = new TextDecoder('utf-8').decode(bytes)
          const sidecarMeta = JSON.parse(json) as Record<string, unknown>
          // Entity-derived meta (subject/session/task/run) wins over
          // the sidecar — matches the CLI's `Object.assign(sidecar,
          // get_meta(fileinfo))` order.
          mergedMeta = { ...sidecarMeta, ...c.meta }
        } catch {
          // Malformed / unreadable sidecar: ship without it. The
          // entity-derived meta on its own is enough for brainlife to
          // accept the upload; the sidecar fields just make the
          // dataset record richer.
        }
      }
      const task = await submitBrainlifeNoopTask(
        jwt,
        {
          instance_id: instance._id,
          name: taskName,
          datatype_id: datatypeId,
          datatype_tags: c.datatypeTags,
          meta: mergedMeta,
          desc: c.desc,
          tags: c.tags,
        },
        signal,
        deps.fetcher,
      )

      progress({
        bytesUploaded,
        bytesTotal,
        filesUploaded: i,
        filesTotal: candidates.length,
        message: 'Waiting for brainlife to ready the upload slot…',
      })
      await pollUntilTaskReadyForUpload(
        jwt,
        task._id,
        signal,
        deps.fetcher,
        2000,
        (status) => {
          progress({
            bytesUploaded,
            bytesTotal,
            filesUploaded: i,
            filesTotal: candidates.length,
            message: `Waiting for brainlife noop task to finish (current status: ${status})…`,
          })
        },
      )

      const candidateBytes = c.files.reduce(
        (sum, f) => sum + (f.sizeBytes ?? 0),
        0,
      )
      // Per-candidate byte cap was enforced in the pre-loop pass
      // above (audit 2026-06-11 P1 internal follow-up). By this
      // point every candidate is ≤ MAX_BRAINLIFE_CANDIDATE_BYTES.
      progress({
        bytesUploaded,
        bytesTotal,
        filesUploaded: i,
        filesTotal: candidates.length,
        message: `Reading ${c.files.length} file(s) for ${c.desc} (${formatBytes(candidateBytes)})…`,
      })
      const tarEntries: TarEntry[] = []
      for (const f of c.files) {
        if (signal.aborted) {
          throw new DOMException('upload cancelled', 'AbortError')
        }
        const bytes = await deps.manifestIo.readFile(f.absolutePath)
        f.sizeBytes = bytes.length
        tarEntries.push({ path: f.archivePath, contents: bytes })
      }
      const tarBytes = buildTar(tarEntries)
      progress({
        bytesUploaded,
        bytesTotal,
        filesUploaded: i,
        filesTotal: candidates.length,
        message: `Compressing ${formatBytes(tarBytes.length)}…`,
      })
      const gzippedBytes = await gzip(tarBytes)

      progress({
        bytesUploaded,
        bytesTotal,
        filesUploaded: i,
        filesTotal: candidates.length,
        message: `Uploading ${formatBytes(gzippedBytes.length)} to brainlife…`,
      })
      await uploadBrainlifeArchive(
        jwt,
        task._id,
        gzippedBytes,
        signal,
        deps.fetcher,
      )
      bytesUploaded += candidateBytes

      progress({
        bytesUploaded,
        bytesTotal,
        filesUploaded: i + 1,
        filesTotal: candidates.length,
        message: `Registering ${c.desc}…`,
      })
      const dataset = await registerBrainlifeDataset(
        jwt,
        {
          project_id: project._id,
          task_id: task._id,
          output_id: 'output',
          meta: mergedMeta,
          desc: c.desc,
          tags: c.tags,
        },
        signal,
        deps.fetcher,
      )
      registeredDatasetIds.push(dataset._id)
      if (pendingIntent !== null) {
        pendingIntent = await updateIntentRecovery(
          pendingIntent,
          { brainlifeDatasetIds: [...registeredDatasetIds] },
          pendingIo,
        )
      }

      // Wait for brainlife's archive worker to flip the dataset to
      // status="stored" before moving on. Skipping this is what caused
      // the "FileNotFoundError: ...prod-archive/.../<task>.tar" failures
      // — submitting the next candidate's noop while the previous
      // archive worker was still scanning the noop output directory
      // raced the cleanup.
      progress({
        bytesUploaded,
        bytesTotal,
        filesUploaded: i + 1,
        filesTotal: candidates.length,
        message: 'Waiting for brainlife archive worker (status: requested)…',
      })
      await waitForBrainlifeDatasetStored(
        jwt,
        dataset._id,
        signal,
        deps.fetcher,
        2000,
        (archiveStatus) => {
          progress({
            bytesUploaded,
            bytesTotal,
            filesUploaded: i + 1,
            filesTotal: candidates.length,
            message: `Waiting for brainlife archive worker (status: ${archiveStatus})…`,
          })
        },
      )

      // Hash these files for the manifest. SHA-256 is on the upload
      // bytes — same byte-truth as M5's diff comparison. We could
      // reuse the bytes already in memory; calling walkManifest keeps
      // the code path identical between first upload and incremental
      // push.
      const rows = await walkManifest(
        c.files.map((f) => ({
          absolutePath: f.absolutePath,
          relativePath: f.archivePath,
          remoteId: dataset._id,
        })),
        signal,
        deps.manifestIo,
      )
      manifestEntries.push(...rows)
    } catch (err) {
      // Cancellation propagates verbatim; anything else is recorded
      // and we continue with the next candidate.
      if (
        signal.aborted ||
        (err instanceof DOMException && err.name === 'AbortError')
      ) {
        throw err
      }
      const msg = err instanceof Error ? err.message : String(err)
      // Audit P1 (security): don't write the full error message
      // to console — brainlife's response body is attacker-influenced
      // (it can include reflected request headers or other
      // server-side echoes that may leak token-adjacent strings).
      // The structured failure goes into `failedCandidates` for the
      // in-panel summary; the console gets only the candidate id +
      // HTTP status when we can extract one.
      const consoleHint =
        err instanceof Error && 'status' in err && err.status !== null
          ? `HTTP ${String((err as { status: number }).status)}`
          : 'error'
      console.warn(`[brainlife] candidate "${c.desc}" failed: ${consoleHint}`)
      // Audit security P1 (2026-05-25): the console line above is
      // already scrubbed, but the message we persist into
      // `failedCandidates` (which lands in `share.json` and renders
      // in the panel) was raw. Re-scrub before persisting so a
      // brainlife 5xx that echoes the inbound `Authorization` header
      // can't leak the bearer to disk / UI.
      failedCandidates.push({
        desc: c.desc,
        datatype: c.datatype,
        error: scrubJwtLike(msg),
      })
      // Roll the cumulative byte counter forward as if this
      // candidate had uploaded, so the progress bar doesn't get
      // stuck. Helpful when 1/20 fails and 19/20 succeed.
      bytesUploaded += c.files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0)
    }
  }

  if (manifestEntries.length === 0 && failedCandidates.length > 0) {
    const first = failedCandidates[0]
    throw new Error(
      `Brainlife upload failed for all ${failedCandidates.length} candidate(s). ` +
        `No local share link was written. First failure: ${first.desc} ` +
        `(${first.datatype}) — ${first.error}`,
    )
  }

  progress({
    bytesUploaded,
    bytesTotal,
    filesUploaded: candidates.length,
    filesTotal: candidates.length,
    message:
      failedCandidates.length === 0
        ? 'Finalising…'
        : `Finalising… (${failedCandidates.length} of ${candidates.length} scan(s) failed on brainlife — the panel shows each failure below)`,
  })
  const link: ShareLink = {
    backend: 'brainlife',
    remoteId: project._id,
    remoteLabel: project.name,
    remoteUrl: brainlifeProjectUrl(project._id),
    lastUploadedAt: deps.now().toISOString(),
    backendMeta: {
      groupId: project.group_id,
      instanceId: instance._id,
      failedCandidates,
    },
  }
  return { link, entries: manifestEntries, pendingIntent }
}

/** Map upload candidates to the `walkManifest` input shape. Exported
 * so the backend's `diff` + `pushUpdate` can hash the same set of
 * files the upload would have sent. */
export function candidatesToManifestInputs(
  candidates: BrainlifeUploadCandidate[],
): Array<{ absolutePath: string; relativePath: string }> {
  const inputs: Array<{ absolutePath: string; relativePath: string }> = []
  for (const c of candidates) {
    for (const f of c.files) {
      inputs.push({
        absolutePath: f.absolutePath,
        relativePath: f.archivePath,
      })
    }
  }
  return inputs
}

/** Return only those candidates whose archive paths intersect
 * `changedArchivePaths`. M5's `pushUpdate` calls this to skip
 * scans whose files are all unchanged. */
export function filterCandidatesByPaths(
  candidates: BrainlifeUploadCandidate[],
  changedArchivePaths: Set<string>,
): BrainlifeUploadCandidate[] {
  return candidates.filter((c) =>
    c.files.some((f) => changedArchivePaths.has(f.archivePath)),
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
