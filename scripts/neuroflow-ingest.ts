#!/usr/bin/env bun
// Headless BIDSvue ingest: DICOM folder -> BIDS dataset, no window.
//
// Runs the same import the window runs when NeuroFlow launches it
// (`$lib/neuroflow/headless`), on node:fs and a directly spawned dcm2niix
// instead of the Tauri host. Two ways in:
//
//   As a NeuroFlow step (what the runtime and its MCP server call):
//     bun run neuroflow-ingest -- --neuroflow-session "$NEUROFLOW_SESSION"
//   reads <session>/context.json (inputs.dicom_dir, outputDir, step) and
//   writes <outputDir>/bids, <outputDir>/neuroflow.handoff.json and a line
//   of <session>/provenance.jsonl.
//
//   Standalone, from a workflow document's ingest step:
//     bun run neuroflow-ingest -- --workflow wf.json --input dicom_dir=/data/dicom --out /data/out
//
// Exit codes: 0 imported (warnings, e.g. a dcm2niix partial conversion, go
// to stderr and the handoff); 1 the import failed; 2 bad arguments.

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodePostPassFs } from '$lib/import/postpass/nodeFs'
import { nodeMutateFs } from '$lib/mutate/nodeFs'
import { CONTEXT_FILE, parseNeuroflowContext } from '$lib/neuroflow/contract'
import {
  HEADLESS_IMPORTERS,
  type IngestSettings,
  IngestUsageError,
  launchFromContext,
  resolveSettings,
  runHeadlessIngest,
  stepFromWorkflow,
} from '$lib/neuroflow/headless'
import {
  createNodeImportExecutor,
  resolveDcm2niix,
} from '$lib/neuroflow/nodeExecutor'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `usage:
  bun run neuroflow-ingest -- --neuroflow-session <dir>
  bun run neuroflow-ingest -- --workflow <file.json> [--step <id>] --input dicom_dir=<dir> --out <dir>
  bun run neuroflow-ingest -- --dicom <dir> --out <dir>

  --neuroflow-session <dir>  NeuroFlow session (default: $NEUROFLOW_SESSION)
  --workflow <file>          NeuroFlow workflow; its BIDSvue step supplies the settings
  --step <id>                the workflow step to run (default: its only BIDSvue step)
  --input <name>=<value>     a workflow input (repeatable)
  --dicom <dir>              DICOM folder (same as --input dicom_dir=<dir>)
  --out <dir>                output folder; the dataset lands in <dir>/bids
  --importer <id>            ${HEADLESS_IMPORTERS.join(' | ')} (default dcm2niix-reproin)
  --subject <label>          BIDS subject label (default: from PatientID)
  --session <label>          BIDS session label
  --anonymize                strip dates too (dcm2niix -ba y)
  --shift-dates              shift acquisition dates to 1925-01-01
  --save-derivatives         keep dcm2niix's derivatives/ subtree
  --heuristic <name|file>    heudiconv heuristic (default reproin)
  --config <file>            dcm2bids config
  --dcm2niix <path>          dcm2niix to run (default: $DCM2NIIX, the bundled sidecar, then PATH)
  --state-dir <dir>          where the import's operations.log goes (default: the session work dir)
  --json                     print the result as JSON on stdout
`

interface Flags {
  sessionDir?: string
  workflow?: string
  step?: string
  inputs: Record<string, string>
  out?: string
  dcm2niix?: string
  stateDir?: string
  json: boolean
  settings: Partial<IngestSettings>
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { inputs: {}, json: false, settings: {} }
  const value = (i: number, name: string): string => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--'))
      throw new IngestUsageError(`${name} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--':
        break
      case '-h':
      case '--help':
        process.stdout.write(USAGE)
        process.exit(0)
        break
      case '--neuroflow-session':
        flags.sessionDir = value(i++, arg)
        break
      case '--workflow':
        flags.workflow = value(i++, arg)
        break
      case '--step':
        flags.step = value(i++, arg)
        break
      case '--input': {
        const pair = value(i++, arg)
        const eq = pair.indexOf('=')
        if (eq <= 0)
          throw new IngestUsageError(
            `--input expects name=value, got "${pair}"`,
          )
        flags.inputs[pair.slice(0, eq)] = pair.slice(eq + 1)
        break
      }
      case '--dicom':
        flags.inputs.dicom_dir = value(i++, arg)
        break
      case '--out':
        flags.out = value(i++, arg)
        break
      case '--importer':
        flags.settings.importer = value(i++, arg) as IngestSettings['importer']
        break
      case '--subject':
        flags.settings.subject = value(i++, arg)
        break
      case '--session':
        flags.settings.session = value(i++, arg)
        break
      case '--heuristic':
        flags.settings.heuristic = value(i++, arg)
        break
      case '--config':
        flags.settings.config = value(i++, arg)
        break
      case '--anonymize':
        flags.settings.anonymize = true
        break
      case '--shift-dates':
        flags.settings.shiftDates = true
        break
      case '--save-derivatives':
        flags.settings.saveDerivatives = true
        break
      case '--dcm2niix':
        flags.dcm2niix = value(i++, arg)
        break
      case '--state-dir':
        flags.stateDir = value(i++, arg)
        break
      case '--json':
        flags.json = true
        break
      default:
        throw new IngestUsageError(`unknown argument "${arg}"`)
    }
  }
  return flags
}

function readJson(path: string, what: string): unknown {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new IngestUsageError(
      `cannot read ${what} ${path}: ${(err as Error).message}`,
    )
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new IngestUsageError(
      `${path} is not valid JSON: ${(err as Error).message}`,
    )
  }
}

function bidsVersion(): string {
  try {
    const schema = JSON.parse(
      readFileSync(join(repoRoot, 'static', '_validator.schema.json'), 'utf8'),
    )
    if (typeof schema.bids_version === 'string') return schema.bids_version
  } catch {
    // Same fallback as getBidsVersion() when the schema is unavailable.
  }
  return '1.10.0'
}

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2))
  const sessionDir =
    flags.workflow === undefined && flags.inputs.dicom_dir === undefined
      ? (flags.sessionDir ?? process.env.NEUROFLOW_SESSION)
      : flags.sessionDir

  let dicomDir: string
  let outputDir: string
  let step: string | undefined
  let tool: string | undefined
  let workDir: string | undefined
  let inputs: Record<string, unknown>

  if (sessionDir !== undefined && sessionDir !== '') {
    if (flags.workflow !== undefined) {
      throw new IngestUsageError(
        'use either --neuroflow-session or --workflow, not both',
      )
    }
    const contextPath = join(sessionDir, CONTEXT_FILE)
    let raw: string
    try {
      raw = readFileSync(contextPath, 'utf8')
    } catch (err) {
      throw new IngestUsageError(
        `cannot read ${contextPath}: ${(err as Error).message}`,
      )
    }
    const launch = launchFromContext(parseNeuroflowContext(raw))
    dicomDir = launch.dicomDir
    outputDir = flags.out ?? launch.outputDir
    step = launch.step ?? process.env.NEUROFLOW_STEP
    tool = launch.tool
    workDir = launch.workDir ?? process.env.NEUROFLOW_WORK_DIR
    inputs = launch.inputs
  } else {
    if (flags.workflow !== undefined) {
      const resolved = stepFromWorkflow(
        readJson(flags.workflow, 'workflow'),
        flags.inputs,
        flags.step,
      )
      step = resolved.step
      inputs = resolved.inputs
    } else {
      inputs = { ...flags.inputs }
    }
    const dicom = inputs.dicom_dir
    if (typeof dicom !== 'string' || dicom === '') {
      throw new IngestUsageError(
        'no DICOM folder: pass --dicom <dir> or --input dicom_dir=<dir>',
      )
    }
    if (flags.out === undefined)
      throw new IngestUsageError(
        '--out <dir> is required without a NeuroFlow session',
      )
    dicomDir = dicom
    outputDir = flags.out
  }

  const settings = resolveSettings(inputs, flags.settings)
  const stateDir =
    flags.stateDir ??
    (workDir !== undefined
      ? join(workDir, 'bidsvue-state')
      : mkdtempSync(join(tmpdir(), 'bidsvue-ingest-')))
  const dcm2niix = resolveDcm2niix({
    explicit: flags.dcm2niix ?? process.env.DCM2NIIX,
    repoRoot,
  })

  const log = (line: string): void => {
    process.stderr.write(`bidsvue-ingest: ${line}\n`)
  }
  log(
    `${settings.importer} ${resolve(dicomDir)} -> ${join(resolve(outputDir), 'bids')}`,
  )
  log(`dcm2niix: ${dcm2niix}`)

  const result = await runHeadlessIngest(
    {
      dicomDir: resolve(dicomDir),
      outputDir: resolve(outputDir),
      sessionDir:
        sessionDir === undefined || sessionDir === ''
          ? undefined
          : resolve(sessionDir),
      step,
      tool,
      stateDir: resolve(stateDir),
      settings,
    },
    {
      executor: createNodeImportExecutor({
        dcm2niix,
        shimDir: join(resolve(stateDir), 'bin'),
        onOutput: (chunk) => process.stderr.write(chunk),
      }),
      fs: nodeMutateFs,
      postPassFs: nodePostPassFs,
      bidsVersion: bidsVersion(),
    },
  )

  for (const warning of result.warnings) log(`warning: ${warning}`)
  log(
    `imported ${result.filesCreated} file(s) in ${(result.durationMs / 1000).toFixed(1)}s -> ${result.bidsDir}`,
  )
  if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`bidsvue-ingest: ${message}\n`)
    if (!(err instanceof IngestUsageError)) {
      // A non-usage failure after arguments parsed is an import failure.
      process.exit(1)
    }
    process.stderr.write(`\n${USAGE}`)
    process.exit(2)
  },
)
