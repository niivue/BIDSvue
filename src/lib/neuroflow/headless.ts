// Headless NeuroFlow ingest: the import the window runs when launched with
// `NEUROFLOW_SESSION`, without the window.
//
// `scripts/neuroflow-ingest.ts` is the command line; this module holds the
// parts worth testing without a converter:
//
//   - where the settings come from: a session `context.json`, or one step
//     of a NeuroFlow workflow document run standalone, plus flags;
//   - the run itself: `runImport` into `<outputDir>/bidsvue-import`, the
//     BIDS root moved to `<outputDir>/bids`, then the handoff file and one
//     provenance line, exactly as the window writes them.
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

/** Tool ids whose workflow steps this ingest can stand in for. */
export const INGEST_TOOL_IDS: ReadonlyArray<string> = [
  BIDSVUE_TOOL_ID,
  `${BIDSVUE_TOOL_ID}-ingest`,
]

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

export class IngestUsageError extends Error {
  override name = 'IngestUsageError'
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

/** A workflow step's input binding (NeuroFlow 0.1). */
type Binding = { ref: string } | { constant: unknown }

/**
 * Resolve the ingest step of a NeuroFlow workflow document for a standalone
 * run. `stepId` picks the step; without it the workflow must have exactly
 * one BIDSvue step. Bindings to workflow inputs come from `workflowInputs`;
 * a binding to another step's output cannot be resolved outside the runtime.
 */
export function stepFromWorkflow(
  workflow: unknown,
  workflowInputs: Readonly<Record<string, unknown>>,
  stepId?: string,
): { step: string; inputs: Record<string, unknown> } {
  if (
    typeof workflow !== 'object' ||
    workflow === null ||
    (workflow as { kind?: unknown }).kind !== 'workflow'
  ) {
    throw new IngestUsageError(
      'not a NeuroFlow workflow document (kind "workflow")',
    )
  }
  const steps = (workflow as { steps?: unknown }).steps
  if (typeof steps !== 'object' || steps === null) {
    throw new IngestUsageError('the workflow has no steps')
  }
  const entries = Object.entries(
    steps as Record<string, { tool?: unknown; inputs?: unknown }>,
  )
  let id = stepId
  if (id === undefined) {
    const ingest = entries.filter(
      ([, s]) => typeof s.tool === 'string' && INGEST_TOOL_IDS.includes(s.tool),
    )
    if (ingest.length !== 1) {
      throw new IngestUsageError(
        ingest.length === 0
          ? 'the workflow has no BIDSvue step; name one with --step'
          : `the workflow has ${ingest.length} BIDSvue steps (${ingest.map(([k]) => k).join(', ')}); pick one with --step`,
      )
    }
    id = ingest[0][0]
  }
  const step = (steps as Record<string, { inputs?: unknown }>)[id]
  if (step === undefined)
    throw new IngestUsageError(`the workflow has no step "${id}"`)
  const bindings = (step.inputs ?? {}) as Record<string, Binding>
  const inputs: Record<string, unknown> = {}
  for (const [name, binding] of Object.entries(bindings)) {
    if ('constant' in binding) {
      inputs[name] = binding.constant
    } else if (
      typeof binding.ref === 'string' &&
      binding.ref.startsWith('inputs.')
    ) {
      const key = binding.ref.slice('inputs.'.length)
      if (key in workflowInputs) inputs[name] = workflowInputs[key]
    } else {
      throw new IngestUsageError(
        `step "${id}" input "${name}" comes from ${String((binding as { ref?: unknown }).ref)}; only workflow inputs and constants resolve outside the NeuroFlow runtime`,
      )
    }
  }
  return { step: id, inputs }
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
  /** Where the import's operations.log and backups go. */
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

/** Run one ingest. Rejects before converting if `<outputDir>/bids` exists. */
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
  if (await fs.exists(finalRoot)) {
    throw new IngestUsageError(
      `${finalRoot} already exists; refusing to overwrite it`,
    )
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

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[/\\]/.test(p)
}
