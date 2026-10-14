#!/usr/bin/env bun
// Headless BIDSvue ingest: DICOM folder -> BIDS dataset, no window.
//
// Runs the same import as the app's Import dialog (`$lib/neuroflow/headless`),
// on node:fs and a directly spawned dcm2niix instead of the Tauri host. Two ways in:
//
//   As a NeuroFlow step (what the runtime and its MCP server call):
//     bun run neuroflow-ingest --neuroflow-session "$NEUROFLOW_SESSION"
//   reads <session>/context.json (inputs.dicom_dir, outputDir, step) and
//   writes <outputDir>/bids, <outputDir>/neuroflow.handoff.json and a line
//   of <session>/provenance.jsonl.
//
//   Standalone:
//     bun run neuroflow-ingest --dicom /data/dicom --out /data/out
//
// The package script runs `svelte-kit sync` first, so `$lib` resolves in a
// fresh clone. There is no undo (see `$lib/neuroflow/headless`): the import's
// state goes to a temp directory that is deleted on exit.
//
// Exit codes: 0 imported (warnings, e.g. a dcm2niix partial conversion, go
// to stderr and the handoff); 1 the import failed, or its output already
// exists; 2 bad arguments.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  isHeuristicFile,
  launchFromContext,
  resolveSettings,
  runHeadlessIngest,
} from '$lib/neuroflow/headless'
import {
  checkIngestReady,
  createNodeImportExecutor,
  resolveDcm2niix,
} from '$lib/neuroflow/nodeExecutor'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `usage:
  bun run neuroflow-ingest --neuroflow-session <dir>
  bun run neuroflow-ingest --dicom <dir> --out <dir>
  bun run neuroflow-ingest --check [--dcm2niix <path>]

  --neuroflow-session <dir>  NeuroFlow session (default: $NEUROFLOW_SESSION)
  --dicom <dir>              DICOM folder (without a session)
  --out <dir>                output folder; the dataset lands in <dir>/bids
  --importer <id>            ${HEADLESS_IMPORTERS.join(' | ')} (default dcm2niix-reproin)
  --subject <label>          BIDS subject label (default: from PatientID)
  --session <label>          BIDS session label
  --anonymize                strip dates too (dcm2niix -ba y)
  --shift-dates              shift acquisition dates to 1925-01-01
  --save-derivatives         keep dcm2niix's derivatives/ subtree
  --heuristic <name|file>    heudiconv heuristic (default reproin); a .py file
                             is Python that heudiconv runs
  --config <file>            dcm2bids config (JSON)
  --allow-heuristic-file     let a session's inputs.heuristic name a .py file
                             (off by default: context.json would choose code to run)
  --dcm2niix <path>          dcm2niix to run (default: $DCM2NIIX, the bundled sidecar, then PATH)
  --json                     print the result as JSON on stdout
  --check                    only check that an import can run here (dcm2niix
                             starts); prints one JSON line, exits 0 when ready
`

interface Flags {
  sessionDir?: string
  dicom?: string
  out?: string
  dcm2niix?: string
  json: boolean
  check: boolean
  allowHeuristicFile: boolean
  settings: Partial<IngestSettings>
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    json: false,
    check: false,
    allowHeuristicFile: false,
    settings: {},
  }
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
      case '--dicom':
        flags.dicom = value(i++, arg)
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
      case '--allow-heuristic-file':
        flags.allowHeuristicFile = true
        break
      case '--json':
        flags.json = true
        break
      case '--check':
        flags.check = true
        break
      default:
        throw new IngestUsageError(`unknown argument "${arg}"`)
    }
  }
  return flags
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
  if (flags.check) {
    // The preflight NeuroFlow's Environment panel runs (the tool document's
    // app-cli probe): no session, no import, one JSON line.
    const readiness = checkIngestReady(
      resolveDcm2niix({
        explicit: flags.dcm2niix ?? process.env.DCM2NIIX,
        repoRoot,
      }),
    )
    process.stdout.write(`${JSON.stringify(readiness)}\n`)
    return readiness.ready ? 0 : 1
  }
  const sessionDir =
    flags.dicom === undefined
      ? (flags.sessionDir ?? process.env.NEUROFLOW_SESSION)
      : flags.sessionDir

  let dicomDir: string
  let outputDir: string
  let step: string | undefined
  let tool: string | undefined
  let inputs: Record<string, unknown> = {}

  if (sessionDir !== undefined && sessionDir !== '') {
    if (flags.dicom !== undefined) {
      throw new IngestUsageError(
        'use either --neuroflow-session or --dicom, not both',
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
    inputs = launch.inputs
    // heudiconv runs a heuristic file as Python. A session's inputs come
    // from a workflow document, so a file there needs the caller's consent.
    if (
      flags.settings.heuristic === undefined &&
      typeof inputs.heuristic === 'string' &&
      isHeuristicFile(inputs.heuristic) &&
      !flags.allowHeuristicFile
    ) {
      throw new IngestUsageError(
        `inputs.heuristic is a file (${inputs.heuristic}), which heudiconv runs as Python; pass --allow-heuristic-file to accept it`,
      )
    }
  } else {
    if (flags.dicom === undefined || flags.dicom === '') {
      throw new IngestUsageError(
        'no input: pass --neuroflow-session <dir> (or set NEUROFLOW_SESSION), or --dicom <dir>',
      )
    }
    if (flags.out === undefined)
      throw new IngestUsageError(
        '--out <dir> is required without a NeuroFlow session',
      )
    dicomDir = flags.dicom
    outputDir = flags.out
  }

  const settings = resolveSettings(inputs, flags.settings)
  // Throwaway: the import's operations.log, backups and the dcm2niix shim.
  // There is no undo, so nothing here outlives the run.
  const stateDir = mkdtempSync(join(tmpdir(), 'bidsvue-ingest-'))
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    process.once(signal, () => {
      rmSync(stateDir, { recursive: true, force: true })
      process.exit(code)
    })
  }
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

  let result: Awaited<ReturnType<typeof runHeadlessIngest>>
  try {
    result = await runHeadlessIngest(
      {
        dicomDir: resolve(dicomDir),
        outputDir: resolve(outputDir),
        sessionDir:
          sessionDir === undefined || sessionDir === ''
            ? undefined
            : resolve(sessionDir),
        step,
        tool,
        stateDir,
        settings,
      },
      {
        executor: createNodeImportExecutor({
          dcm2niix,
          shimDir: join(stateDir, 'bin'),
          onOutput: (chunk) => process.stderr.write(chunk),
        }),
        fs: nodeMutateFs,
        postPassFs: nodePostPassFs,
        bidsVersion: bidsVersion(),
      },
    )
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }

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
