// Headless NeuroFlow ingest: settings resolution and a full run against a
// temp directory with a stub converter (the real dcm2niix is not needed).

import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodePostPassFs } from '$lib/import/postpass/nodeFs'
import type { ImportExecutor } from '$lib/import/runImport'
import { nodeMutateFs } from '$lib/mutate/nodeFs'
import {
  HEADLESS_AGENT,
  IngestUsageError,
  launchFromContext,
  resolveSettings,
  runHeadlessIngest,
  stepFromWorkflow,
} from './headless'
import {
  createNodeImportExecutor,
  hostTargetTriple,
  resolveDcm2niix,
} from './nodeExecutor'

const tempDirs: string[] = []
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bidsvue-headless-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

/** Writes what dcm2niix -f reproin would: a BIDS root under a study locator. */
function stubConverter(
  argvSeen: string[][],
  partial: string | null = null,
): ImportExecutor {
  return {
    async resolveBinary(tool) {
      return { kind: 'sidecar', identifier: 'dcm2niix', toolId: tool.id }
    },
    async run(_resolved, argv, cwd) {
      argvSeen.push([...argv])
      const anat = join(cwd, 'Study', 'sub-01', 'anat')
      await mkdir(anat, { recursive: true })
      await writeFile(
        join(anat, 'sub-01_T1w.nii.gz'),
        new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
      )
      await writeFile(join(anat, 'sub-01_T1w.json'), '{}')
      return { stdout: '', stderr: '', partialFailureWarning: partial }
    },
    async listFiles(dir) {
      return createNodeImportExecutor({
        dcm2niix: 'dcm2niix',
        shimDir: dir,
      }).listFiles(dir)
    },
  }
}

function session(): {
  dicom: string
  out: string
  sessionDir: string
  state: string
} {
  const root = makeTmp()
  const dicom = join(root, 'dicom')
  mkdirSync(dicom)
  return {
    dicom,
    out: join(root, 'outputs', 'ingest'),
    sessionDir: root,
    state: join(root, 'work', 'state'),
  }
}

describe('resolveSettings', () => {
  test('defaults to dcm2niix-reproin with every option off', () => {
    expect(resolveSettings({})).toEqual({
      importer: 'dcm2niix-reproin',
      subject: undefined,
      session: undefined,
      anonymize: false,
      shiftDates: false,
      saveDerivatives: false,
      heuristic: undefined,
      config: undefined,
    })
  })

  test('reads snake_case tool inputs; flags win', () => {
    const s = resolveSettings(
      { subject: '01', session: 'pre', shift_dates: true, anonymize: 'true' },
      { session: 'post', anonymize: false },
    )
    expect(s.subject).toBe('01')
    expect(s.session).toBe('post')
    expect(s.shiftDates).toBe(true)
    expect(s.anonymize).toBe(false)
  })

  test('refuses importers that cannot run headless', () => {
    expect(() => resolveSettings({ importer: 'ezbids-meg' })).toThrow(
      IngestUsageError,
    )
    expect(() => resolveSettings({ anonymize: 'yes' })).toThrow('true or false')
  })
})

describe('launchFromContext', () => {
  test('takes dicom_dir, outputDir, step, tool, workDir', () => {
    const launch = launchFromContext({
      step: 'ingest',
      tool: 'neuroflow.gallery.tools/bidsvue-ingest',
      inputs: { dicom_dir: '/data/dicom', subject: '01' },
      outputDir: '/s/outputs/ingest',
      workDir: '/s/work',
    })
    expect(launch).toEqual({
      dicomDir: '/data/dicom',
      outputDir: '/s/outputs/ingest',
      step: 'ingest',
      tool: 'neuroflow.gallery.tools/bidsvue-ingest',
      workDir: '/s/work',
      inputs: { dicom_dir: '/data/dicom', subject: '01' },
    })
  })

  test('requires dicom_dir and outputDir', () => {
    expect(() => launchFromContext({ outputDir: '/o' })).toThrow(
      'inputs.dicom_dir',
    )
    expect(() => launchFromContext({ inputs: { dicom_dir: '/d' } })).toThrow(
      'outputDir',
    )
  })
})

describe('stepFromWorkflow', () => {
  const workflow = {
    neuroflow: '0.1.0',
    kind: 'workflow',
    id: 'x/ingest-qa',
    inputs: { dicom_dir: { type: 'neuro:dicom-folder' } },
    steps: {
      ingest: {
        tool: 'neuroflow.gallery.tools/bidsvue',
        inputs: {
          dicom_dir: { ref: 'inputs.dicom_dir' },
          subject: { constant: '07' },
        },
      },
      qa: {
        tool: 'x/qa',
        inputs: { bids_dir: { ref: 'steps.ingest.outputs.bids_dir' } },
      },
    },
  }

  test('finds the only BIDSvue step and resolves its bindings', () => {
    expect(stepFromWorkflow(workflow, { dicom_dir: '/data/dicom' })).toEqual({
      step: 'ingest',
      inputs: { dicom_dir: '/data/dicom', subject: '07' },
    })
  })

  test('refuses a step fed by another step', () => {
    expect(() => stepFromWorkflow(workflow, {}, 'qa')).toThrow(
      'steps.ingest.outputs.bids_dir',
    )
  })

  test('refuses documents that are not workflows', () => {
    expect(() => stepFromWorkflow({ kind: 'tool' }, {})).toThrow(
      'not a NeuroFlow workflow',
    )
  })
})

describe('runHeadlessIngest', () => {
  test('imports into <out>/bids and writes the handoff and provenance', async () => {
    const s = session()
    const argv: string[][] = []
    const now = new Date('2026-10-13T12:00:00Z')
    const result = await runHeadlessIngest(
      {
        dicomDir: s.dicom,
        outputDir: s.out,
        sessionDir: s.sessionDir,
        step: 'ingest',
        stateDir: s.state,
        settings: resolveSettings({ subject: '01' }),
      },
      {
        executor: stubConverter(argv),
        fs: nodeMutateFs,
        postPassFs: nodePostPassFs,
        bidsVersion: '1.10.0',
        now: () => now,
      },
    )

    expect(result.bidsDir).toBe(join(s.out, 'bids'))
    expect(
      existsSync(join(s.out, 'bids', 'sub-01', 'anat', 'sub-01_T1w.nii.gz')),
    ).toBe(true)
    expect(existsSync(join(s.out, 'bids', 'dataset_description.json'))).toBe(
      true,
    )
    expect(existsSync(join(s.out, 'bidsvue-import'))).toBe(false)
    expect(argv[0]).toContain('-bi')
    expect(argv[0]).toContain('01')

    const handoff = JSON.parse(
      readFileSync(join(s.out, 'neuroflow.handoff.json'), 'utf8'),
    )
    expect(handoff).toMatchObject({
      kind: 'neuroflow/handoff',
      step: 'ingest',
      tool: 'dcm2niix-reproin',
      ts: now.toISOString(),
      outputs: { bids_dir: join(s.out, 'bids') },
      agent: HEADLESS_AGENT,
    })
    expect(handoff.warnings).toBeUndefined()

    const lines = readFileSync(join(s.sessionDir, 'provenance.jsonl'), 'utf8')
      .trim()
      .split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual({
      ts: now.toISOString(),
      step: 'ingest',
      tool: 'neuroflow.gallery.tools/bidsvue',
      action: 'import',
      outputs: { bids_dir: join(s.out, 'bids') },
      agent: HEADLESS_AGENT,
    })
  })

  test('carries a partial conversion into warnings and the handoff', async () => {
    const s = session()
    const result = await runHeadlessIngest(
      {
        dicomDir: s.dicom,
        outputDir: s.out,
        stateDir: s.state,
        settings: resolveSettings({}),
      },
      {
        executor: stubConverter([], 'dcm2niix exited with code 8'),
        fs: nodeMutateFs,
        postPassFs: nodePostPassFs,
        bidsVersion: '1.10.0',
      },
    )
    expect(result.warnings).toContain('dcm2niix exited with code 8')
    expect(result.provenancePath).toBeNull()
    const handoff = JSON.parse(readFileSync(result.handoffPath, 'utf8'))
    expect(handoff.warnings).toContain('dcm2niix exited with code 8')
  })

  test('refuses before converting when <out>/bids exists', async () => {
    const s = session()
    mkdirSync(join(s.out, 'bids'), { recursive: true })
    const argv: string[][] = []
    await expect(
      runHeadlessIngest(
        {
          dicomDir: s.dicom,
          outputDir: s.out,
          stateDir: s.state,
          settings: resolveSettings({}),
        },
        {
          executor: stubConverter(argv),
          fs: nodeMutateFs,
          postPassFs: nodePostPassFs,
          bidsVersion: '1.10.0',
        },
      ),
    ).rejects.toThrow('already exists')
    expect(argv).toHaveLength(0)
  })

  test('requires an absolute output directory', async () => {
    await expect(
      runHeadlessIngest(
        {
          dicomDir: '/d',
          outputDir: 'relative/out',
          stateDir: '/s',
          settings: resolveSettings({}),
        },
        {
          executor: stubConverter([]),
          fs: nodeMutateFs,
          postPassFs: nodePostPassFs,
          bidsVersion: '1.10.0',
        },
      ),
    ).rejects.toThrow('absolute')
  })
})

describe('node executor', () => {
  test('names sidecar triples the way src-tauri/binaries does', () => {
    expect(hostTargetTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin')
    expect(hostTargetTriple('linux', 'x64')).toBe('x86_64-unknown-linux-gnu')
    expect(hostTargetTriple('freebsd', 'x64')).toBeNull()
  })

  test('prefers an explicit dcm2niix, then the bundled one, then PATH', () => {
    const repo = makeTmp()
    expect(resolveDcm2niix({ explicit: '/opt/dcm2niix', repoRoot: repo })).toBe(
      '/opt/dcm2niix',
    )
    expect(
      resolveDcm2niix({ repoRoot: repo, triple: 'aarch64-apple-darwin' }),
    ).toBe('dcm2niix')
    mkdirSync(join(repo, 'src-tauri', 'binaries'), { recursive: true })
    const bundled = join(
      repo,
      'src-tauri',
      'binaries',
      'dcm2niix-aarch64-apple-darwin',
    )
    Bun.write(bundled, '')
    expect(
      resolveDcm2niix({ repoRoot: repo, triple: 'aarch64-apple-darwin' }),
    ).toBe(bundled)
  })

  test('treats dcm2niix exit 8 as a partial success and other codes as failure', async () => {
    const dir = makeTmp()
    const exe = join(dir, 'fake-dcm2niix')
    await writeFile(exe, '#!/bin/sh\necho "series 3 failed" >&2\nexit "$1"\n', {
      mode: 0o755,
    })
    const executor = createNodeImportExecutor({
      dcm2niix: exe,
      shimDir: join(dir, 'bin'),
    })
    const resolved = {
      kind: 'sidecar' as const,
      identifier: exe,
      toolId: 'dcm2niix-reproin' as const,
    }
    const partial = await executor.run(resolved, ['8'], dir)
    expect(partial.partialFailureWarning).toContain('code 8')
    expect(partial.partialFailureWarning).toContain('series 3 failed')
    await expect(executor.run(resolved, ['2'], dir)).rejects.toThrow(
      'exited with code 2: series 3 failed',
    )
    expect(
      (await executor.run(resolved, ['0'], dir)).partialFailureWarning,
    ).toBeNull()
  })
})
