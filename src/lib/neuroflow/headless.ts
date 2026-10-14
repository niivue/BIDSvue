// Headless NeuroFlow ingest: the app's DICOM import (`runImport` and the
// post-pass) run as a NeuroFlow step, without the window.
//
// `scripts/neuroflow-ingest.ts` is the command line; this module holds the
// parts worth testing without a converter:
//
//   - where the settings come from: a session `context.json` or flags;
//   - the run itself: `runImport` into `<outputDir>/bidsvue-import`, the
//     BIDS root moved to `<outputDir>/bids`, then the handoff file and one
//     provenance line the session contract asks for.
//
// There is no undo. The window records an import in the dataset's
// operations.log so it can be reverted; the headless run is a one-shot step
// whose output directory belongs to the NeuroFlow session, so the caller
// gives `runImport` a throwaway state directory and deletes it afterwards.
// The relocation, handoff and provenance writes are not journaled either;
// to redo a step, delete its output directory and run it again.
//
// Every host dependency (process runner, file system) is injected.

import type { PostPassFs } from '$lib/import/postpass/fs'
import { type ImportExecutor, runImport } from '$lib/import/runImport'
import type { ImportToolId } from '$lib/import/tools'
import type { MutateFs } from '$lib/mutate/backup'
import { datasetStatePaths } from '$lib/state/appPaths'
import {
  BIDSVUE_TOOL_ID,
  HANDOFF_FILE,
  type NeuroflowContext,
  PROVENANCE_FILE,
  handoffJson,
  provenanceLine,
} from './contract'
import {
  NEUROFLOW_BIDS_DIR_NAME,
  NEUROFLOW_STAGING_NAME,
  relocateImportRoot,
} from './relocate'

/** Importers the headless ingest can run (process-backed ones). */
export const HEADLESS_IMPORTERS = [
  'dcm2niix-reproin',
  'pet2bids',
  'heudiconv',
  'dcm2bids',
] as const satisfies ReadonlyArray<ImportToolId>

export type HeadlessImporter = (typeof HEADLESS_IMPORTERS)[number]

/** Agent stamped on records the headless ingest writes. */
export const HEADLESS_AGENT = 'bidsvue-ingest@neuroflow-aware'

/** Import settings, named as the NeuroFlow tool document's inputs. */
export interface IngestSettings {
  importer: HeadlessImporter
  subject?: string
  session?: string
  anonymize: boolean
  shiftDates: boolean
  saveDerivatives: boolean
  heuristic?: string
  config?: string
}

/** Settings given as tool inputs (`context.inputs` or a step's bindings). */
const INPUT_KEYS = {
  importer: 'importer',
  subject: 'subject',
  session: 'session',
  anonymize: 'anonymize',
  shiftDates: 'shift_dates',
  saveDerivatives: 'save_derivatives',
  heuristic: 'heuristic',
  config: 'config',
} as const satisfies Record<keyof IngestSettings, string>

/** Bad arguments or inputs: the CLI prints usage and exits 2. */
export class IngestUsageError extends Error {
  override name = 'IngestUsageError'
}

/**
 * A heudiconv heuristic given as a file is Python that heudiconv runs. True
 * for anything but a built-in heuristic name (`reproin`, ...).
 */
export function isHeuristicFile(heuristic: string | undefined): boolean {
  return heuristic !== undefined && !/^[A-Za-z0-9_]+$/.test(heuristic)
}

/**
 * Merge settings: `overrides` (flags) win over `inputs` (the step's), which
 * win over the defaults (dcm2niix-reproin, everything off).
 */
export function resolveSettings(
  inputs: Readonly<Record<string, unknown>>,
  overrides: Partial<IngestSettings> = {},
): IngestSettings {
  const str = (key: keyof IngestSettings): string | undefined => {
    const fromFlag = overrides[key]
    if (typeof fromFlag === 'string')
      return fromFlag === '' ? undefined : fromFlag
    const v = inputs[INPUT_KEYS[key]]
    if (v === undefined || v === null || v === '') return undefined
    if (typeof v !== 'string') {
      throw new IngestUsageError(`input "${INPUT_KEYS[key]}" must be a string`)
    }
    return v
  }
  const bool = (key: keyof IngestSettings): boolean => {
    const fromFlag = overrides[key]
    if (typeof fromFlag === 'boolean') return fromFlag
    const v = inputs[INPUT_KEYS[key]]
    if (v === undefined || v === null) return false
    if (typeof v === 'boolean') return v
    if (v === 'true' || v === 'false') return v === 'true'
    throw new IngestUsageError(
      `input "${INPUT_KEYS[key]}" must be true or false`,
    )
  }
  const importer = str('importer') ?? 'dcm2niix-reproin'
  if (!(HEADLESS_IMPORTERS as ReadonlyArray<string>).includes(importer)) {
    throw new IngestUsageError(
      `importer "${importer}" cannot run headless; use one of ${HEADLESS_IMPORTERS.join(', ')}`,
    )
  }
  return {
    importer: importer as HeadlessImporter,
    subject: str('subject'),
    session: str('session'),
    anonymize: bool('anonymize'),
    shiftDates: bool('shiftDates'),
    saveDerivatives: bool('saveDerivatives'),
    heuristic: str('heuristic'),
    config: str('config'),
  }
}

/** What the ingest reads from a session `context.json`. */
export interface SessionLaunch {
  dicomDir: string
  outputDir: string
  step?: string
  tool?: string
  workDir?: string
  inputs: Record<string, unknown>
}

/** Pull the ingest's launch fields out of a parsed `context.json`. */
export function launchFromContext(context: NeuroflowContext): SessionLaunch {
  const inputs = context.inputs ?? {}
  const dicomDir = inputs.dicom_dir
  if (typeof dicomDir !== 'string' || dicomDir === '') {
    throw new IngestUsageError('context.json has no inputs.dicom_dir')
  }
  if (typeof context.outputDir !== 'string' || context.outputDir === '') {
    throw new IngestUsageError('context.json has no outputDir')
  }
  return {
    dicomDir,
    outputDir: context.outputDir,
    step: context.step,
    tool: context.tool,
    workDir:
      typeof context.workDir === 'string' && context.workDir !== ''
        ? context.workDir
        : undefined,
    inputs: { ...inputs },
  }
}

export interface HeadlessIngestRequest {
  dicomDir: string
  /** Absolute; the BIDS dataset lands at `<outputDir>/bids`. */
  outputDir: string
  /** `$NEUROFLOW_SESSION`; provenance is appended there when set. */
  sessionDir?: string
  step?: string
  /** Tool id recorded in provenance (the session's `tool`). */
  tool?: string
  /**
   * Scratch for the import's operations.log and backups. Nothing here is
   * needed after the run (there is no undo); the caller deletes it.
   */
  stateDir: string
  settings: IngestSettings
}

export interface HeadlessIngestDeps {
  executor: ImportExecutor
  fs: MutateFs
  postPassFs: PostPassFs
  bidsVersion: string
  now?: () => Date
}

export interface HeadlessIngestResult {
  bidsDir: string
  handoffPath: string
  provenancePath: string | null
  filesCreated: number
  durationMs: number
  operationId: string
  /** Converter partial failures and post-pass problems; the import still landed. */
  warnings: string[]
}

/**
 * Run one ingest. Rejects before converting if `<outputDir>/bids` or the
 * staging folder `<outputDir>/bidsvue-import` exists: a failed earlier run
 * can leave staging behind, and a rerun must not build on it.
 */
export async function runHeadlessIngest(
  req: HeadlessIngestRequest,
  deps: HeadlessIngestDeps,
): Promise<HeadlessIngestResult> {
  const { fs } = deps
  const { settings } = req
  const outputDir = req.outputDir.replace(/[/\\]+$/, '')
  if (!isAbsolute(outputDir) || outputDir === '') {
    throw new IngestUsageError(
      `outputDir "${req.outputDir}" must be an absolute directory path`,
    )
  }
  if (!isAbsolute(req.dicomDir)) {
    throw new IngestUsageError(
      `dicom_dir "${req.dicomDir}" must be an absolute path`,
    )
  }
  const stagingDir = `${outputDir}/${NEUROFLOW_STAGING_NAME}`
  const finalRoot = `${outputDir}/${NEUROFLOW_BIDS_DIR_NAME}`
  for (const existing of [finalRoot, stagingDir]) {
    if (await fs.exists(existing)) {
      throw new Error(
        `${existing} already exists (from an earlier run?); delete it or choose another output directory`,
      )
    }
  }
  await fs.mkdir(outputDir, { recursive: true })

  const imported = await runImport({
    statePaths: await datasetStatePaths(req.stateDir, stagingDir),
    srcDir: req.dicomDir,
    destDir: stagingDir,
    subject: settings.subject,
    session: settings.session,
    anonymize: settings.anonymize,
    heuristic: settings.heuristic,
    config: settings.config,
    saveDerivatives: settings.saveDerivatives,
    shiftDates: settings.shiftDates,
    bidsVersion: deps.bidsVersion,
    toolId: settings.importer,
    executor: deps.executor,
    fs,
    postPassFs: deps.postPassFs,
  })

  const bidsDir = await relocateImportRoot({
    fs,
    stagingDir,
    roots: imported.postPass.bidsRoots,
    finalRoot,
  })

  const warnings = [
    ...(imported.partialFailureWarning === null
      ? []
      : [imported.partialFailureWarning]),
    ...imported.postPass.failures.map((f) => `${f.sessionDir}: ${f.error}`),
    ...imported.petPostPass.failures.map((f) => `${f.sidecarPath}: ${f.error}`),
  ]
  const now = deps.now?.() ?? new Date()
  const handoffPath = `${outputDir}/${HANDOFF_FILE}`
  await fs.writeTextFile(
    handoffPath,
    handoffJson(
      {
        tool: settings.importer,
        step: req.step,
        bids_dir: bidsDir,
        producedNiftiCount: imported.filesCreated,
        warnings,
      },
      HEADLESS_AGENT,
      now,
    ),
  )
  let provenancePath: string | null = null
  if (req.sessionDir !== undefined && req.sessionDir !== '') {
    provenancePath = `${req.sessionDir.replace(/[/\\]+$/, '')}/${PROVENANCE_FILE}`
    await fs.appendLogLine(
      provenancePath,
      provenanceLine(
        {
          step: req.step,
          tool: req.tool ?? BIDSVUE_TOOL_ID,
          action: 'import',
          outputs: { bids_dir: bidsDir },
        },
        HEADLESS_AGENT,
        now,
      ),
    )
  }

  return {
    bidsDir,
    handoffPath,
    provenancePath,
    filesCreated: imported.filesCreated,
    durationMs: imported.durationMs,
    operationId: imported.operationId,
    warnings,
  }
}

/** POSIX, drive-letter (`C:\`) and UNC (`\\server\share`) absolute paths. */
function isAbsolute(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\\\') || /^[A-Za-z]:[/\\]/.test(p)
}
