// Integration tests for the M8-A1 import orchestrator. Spins up a tmp
// "DICOM dir" + dest, drives runImport against node:fs MutateFs, stubs
// the executor with a fake that writes a canned BIDS-shaped output.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOperationsLog } from '$lib/mutate/operationsLog'
import { nodeMutateFs } from '$lib/mutate/testFs'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { nodeFsPostPassAdapter } from './postpass/__testFs'
import {
  type ImportExecutor,
  buildDcm2bidsArgv,
  buildHeudiconvArgv,
  buildPet2bidsArgv,
  buildReproinArgv,
  dcm2niixAnonymizeFlag,
  runImport,
} from './runImport'

const tempDirs: string[] = []

function makeTmp(prefix = 'bidsvue-import-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeStatePaths(): DatasetStatePaths {
  const stateDir = mkdtempSync(join(tmpdir(), 'bidsvue-import-state-'))
  tempDirs.push(stateDir)
  return {
    stateDir,
    prefsPath: join(stateDir, 'prefs.json'),
    operationsLogPath: join(stateDir, 'operations.log'),
    originalsDir: join(stateDir, 'originals'),
    metaPath: join(stateDir, 'meta.json'),
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

/**
 * Stub executor that captures argv + writes a canned BIDS layout
 * into `destDir`. Mimics what dcm2niix would produce in reproin mode
 * for a single-subject single-session input.
 */
function makeStubExecutor(opts: {
  recordedArgv: string[]
  files?: ReadonlyArray<{ rel: string; contents?: string }>
  /** When set, run() rejects with this error instead of writing files (round-9 audit H1). */
  runThrows?: Error
  /**
   * When set, `run()` resolves with this string in `partialFailureWarning`,
   * simulating a dcm2niix exit-8 partial conversion. The canned files
   * still land on disk so the orchestrator's post-pass runs normally.
   */
  runPartialFailureWarning?: string
}): ImportExecutor {
  const files = opts.files ?? [
    { rel: 'sub-M123/ses-42/anat/sub-M123_ses-42_T1w.nii.gz' },
    { rel: 'sub-M123/ses-42/anat/sub-M123_ses-42_T1w.json', contents: '{}' },
  ]
  return {
    async resolveBinary(tool) {
      // Tests don't care which kind; the orchestrator's dispatch is
      // identical from the stub's POV. Mirror production's shape so
      // a future check (e.g. "did we pick the right kind") has data
      // to assert against.
      return tool.kind === 'sidecar'
        ? { kind: 'sidecar', identifier: `binaries/${tool.binaryBasename}` }
        : { kind: 'external', command: tool.binaryBasename }
    },
    async run(_resolved, argv, cwd) {
      opts.recordedArgv.push(...argv)
      if (opts.runThrows) {
        throw opts.runThrows
      }
      // Write the canned layout under cwd (which the orchestrator
      // sets to destDir).
      for (const f of files) {
        const abs = join(cwd, f.rel)
        await mkdir(join(abs, '..'), { recursive: true })
        await writeFile(
          abs,
          f.contents ?? new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
        )
      }
      return {
        stdout: 'stub ok',
        stderr: '',
        partialFailureWarning: opts.runPartialFailureWarning ?? null,
      }
    },
    async listFiles(dir) {
      const out: string[] = []
      const walk = async (d: string): Promise<void> => {
        let names: string[] = []
        try {
          names = await readdir(d)
        } catch {
          return
        }
        for (const name of names) {
          const child = join(d, name)
          const s = await stat(child)
          if (s.isDirectory()) await walk(child)
          else if (s.isFile()) out.push(child)
        }
      }
      await walk(dir)
      return out
    },
  }
}

describe('buildReproinArgv', () => {
  test('produces the expected argv shape with subject + session (-ba o when anonymize=false)', () => {
    const argv = buildReproinArgv({
      srcDir: '/dicom/sub-xa60',
      destDir: '/bids',
      subject: 'M123',
      session: '42',
      anonymize: false,
    })
    expect(argv).toEqual([
      '-f',
      '%H',
      '-z',
      'y',
      '-ba',
      'o',
      '-o',
      '/bids',
      '-bi',
      'M123',
      '-bv',
      '42',
      '/dicom/sub-xa60',
    ])
  })

  test('emits -ba y when anonymize=true (full strip including dates)', () => {
    const argv = buildReproinArgv({
      srcDir: '/dicom/sub-xa60',
      destDir: '/bids',
      anonymize: true,
    })
    // The reproin importer defaults to anonymize=off (`-ba o`) to
    // match reproinx.py's participants.tsv demographics, but users can
    // opt into full date stripping (`-ba y`).
    // `-ba n` (the pre-v1.0.20260520 off mapping) is no longer emitted.
    const baIndex = argv.indexOf('-ba')
    expect(baIndex).toBeGreaterThanOrEqual(0)
    expect(argv[baIndex + 1]).toBe('y')
  })

  test('does not include -br or -w (dropped post-v1.0.20260513)', () => {
    const argv = buildReproinArgv({
      srcDir: '/dicom/sub-xa60',
      destDir: '/bids',
      anonymize: false,
    })
    expect(argv).not.toContain('-br')
    expect(argv).not.toContain('-w')
  })

  test('omits -bi / -bv when subject / session are undefined or empty', () => {
    const argv = buildReproinArgv({
      srcDir: '/dicom/sub-xa60',
      destDir: '/bids',
      anonymize: false,
    })
    expect(argv).toContain('-o')
    expect(argv).not.toContain('-bi')
    expect(argv).not.toContain('-bv')
  })

  test('omits -bv when only subject is supplied', () => {
    const argv = buildReproinArgv({
      srcDir: '/dicom/sub-xa60',
      destDir: '/bids',
      subject: 'M123',
      anonymize: false,
    })
    expect(argv).toContain('-bi')
    expect(argv).toContain('M123')
    expect(argv).not.toContain('-bv')
  })
})

describe('dcm2niixAnonymizeFlag', () => {
  test("on -> 'y' (full strip including AcquisitionDateTime)", () => {
    expect(dcm2niixAnonymizeFlag(true)).toBe('y')
  })
  test("off -> 'o' (omit PII, keep AcquisitionDateTime); never 'n'", () => {
    // The whole point of this helper is that the wizard's off state
    // can NEVER reach the leaky `-ba n` (which retains PatientName
    // et al). If this assertion ever falls back to 'n', a PHI leak
    // has been reintroduced into the wizard path.
    expect(dcm2niixAnonymizeFlag(false)).toBe('o')
    // @ts-expect-error — the return type forbids 'n' at the type level.
    const offMode: 'n' = dcm2niixAnonymizeFlag(false)
    expect(offMode).not.toBe('n')
  })
})

describe('buildPet2bidsArgv', () => {
  test('anonymize=true emits -ba y', () => {
    const argv = buildPet2bidsArgv({
      petDir: '/bids/sub-01/pet',
      srcDir: '/dicom/pet',
      subject: '01',
      anonymize: true,
    })
    const baIdx = argv.indexOf('-ba')
    expect(baIdx).toBeGreaterThanOrEqual(0)
    expect(argv[baIdx + 1]).toBe('y')
  })

  test('anonymize=false emits -ba o (NOT -ba n which would leak PatientName)', () => {
    const argv = buildPet2bidsArgv({
      petDir: '/bids/sub-01/pet',
      srcDir: '/dicom/pet',
      subject: '01',
      anonymize: false,
    })
    const baIdx = argv.indexOf('-ba')
    expect(baIdx).toBeGreaterThanOrEqual(0)
    expect(argv[baIdx + 1]).toBe('o')
    // Hard guarantee against future drift: `-ba n` is never present
    // anywhere in the wizard's PET argv.
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] === '-ba') expect(argv[i + 1]).not.toBe('n')
    }
  })

  test('full argv shape with session', () => {
    const argv = buildPet2bidsArgv({
      petDir: '/bids/sub-01/ses-A/pet',
      srcDir: '/dicom/pet',
      subject: '01',
      session: 'A',
      anonymize: true,
    })
    expect(argv).toEqual([
      '-f',
      'sub-01_ses-A_pet',
      '-z',
      'y',
      '-w',
      '1',
      '-ba',
      'y',
      '-o',
      '/bids/sub-01/ses-A/pet',
      '/dicom/pet',
    ])
  })
})

describe('buildHeudiconvArgv', () => {
  test('produces the expected heudiconv argv shape with subject + session', () => {
    const argv = buildHeudiconvArgv({
      srcDir: '/dicom/study',
      destDir: '/bids',
      subject: 'M123',
      session: '42',
    })
    expect(argv).toEqual([
      '-c',
      'dcm2niix',
      '--bids',
      '-o',
      '/bids',
      '-f',
      'reproin',
      '-s',
      'M123',
      '-ss',
      '42',
      '--files',
      '/dicom/study',
    ])
  })

  test('omits -s / -ss when subject / session are absent or empty', () => {
    const argv = buildHeudiconvArgv({
      srcDir: '/dicom/study',
      destDir: '/bids',
    })
    expect(argv).not.toContain('-s')
    expect(argv).not.toContain('-ss')
    expect(argv).toContain('--files')
    expect(argv[argv.length - 1]).toBe('/dicom/study')
  })

  test('omits anonymize entirely (heudiconv has no -ba flag)', () => {
    const argv = buildHeudiconvArgv({
      srcDir: '/dicom/study',
      destDir: '/bids',
    })
    expect(argv).not.toContain('-ba')
    expect(argv).not.toContain('y')
    expect(argv).not.toContain('n')
  })

  test('passes a custom heuristic through to -f', () => {
    const argv = buildHeudiconvArgv({
      srcDir: '/dicom/study',
      destDir: '/bids',
      heuristic: 'convertall',
    })
    const fIdx = argv.indexOf('-f')
    expect(fIdx).toBeGreaterThanOrEqual(0)
    expect(argv[fIdx + 1]).toBe('convertall')
  })

  test('accepts an absolute path to a custom .py heuristic', () => {
    const argv = buildHeudiconvArgv({
      srcDir: '/dicom/study',
      destDir: '/bids',
      heuristic: '/Users/me/my-heuristic.py',
    })
    const fIdx = argv.indexOf('-f')
    expect(argv[fIdx + 1]).toBe('/Users/me/my-heuristic.py')
  })

  test('falls back to "reproin" when heuristic is empty or whitespace', () => {
    const argv1 = buildHeudiconvArgv({
      srcDir: '/dicom/study',
      destDir: '/bids',
      heuristic: '',
    })
    expect(argv1[argv1.indexOf('-f') + 1]).toBe('reproin')

    const argv2 = buildHeudiconvArgv({
      srcDir: '/dicom/study',
      destDir: '/bids',
      heuristic: '   ',
    })
    expect(argv2[argv2.indexOf('-f') + 1]).toBe('reproin')
  })

  test('trims surrounding whitespace from the heuristic', () => {
    const argv = buildHeudiconvArgv({
      srcDir: '/dicom/study',
      destDir: '/bids',
      heuristic: '  /tmp/h.py  ',
    })
    expect(argv[argv.indexOf('-f') + 1]).toBe('/tmp/h.py')
  })
})

describe('buildDcm2bidsArgv', () => {
  test('produces the expected argv shape with all options set', () => {
    const argv = buildDcm2bidsArgv({
      srcDir: '/dicom/study',
      destDir: '/bids',
      subject: 'M123',
      session: '42',
      config: '/etc/dcm2bids/study.json',
    })
    expect(argv).toEqual([
      '-d',
      '/dicom/study',
      '-p',
      'M123',
      '-c',
      '/etc/dcm2bids/study.json',
      '-o',
      '/bids',
      '-s',
      '42',
    ])
  })

  test('omits -s when session is absent', () => {
    const argv = buildDcm2bidsArgv({
      srcDir: '/dicom/study',
      destDir: '/bids',
      subject: 'M123',
      config: '/etc/dcm2bids/study.json',
    })
    expect(argv).not.toContain('-s')
    // Required flags still land.
    expect(argv).toContain('-d')
    expect(argv).toContain('-p')
    expect(argv).toContain('-c')
    expect(argv).toContain('-o')
  })

  test('never includes --auto_extract_entities (intentionally not exposed)', () => {
    const argv = buildDcm2bidsArgv({
      srcDir: '/dicom/study',
      destDir: '/bids',
      subject: 'M123',
      config: '/etc/dcm2bids/study.json',
    })
    expect(argv).not.toContain('--auto_extract_entities')
  })
})

describe('runImport', () => {
  test('happy path: creates destDir, spawns dcm2niix, commits one log entry', async () => {
    const src = makeTmp('bidsvue-dicom-src-')
    // Source needs to exist; contents irrelevant for the stub.
    await writeFile(join(src, 'placeholder.dcm'), new Uint8Array([0]))
    const destParent = makeTmp('bidsvue-import-dest-parent-')
    const dest = join(destParent, 'fresh-bids')
    const sp = makeStatePaths()
    const recordedArgv: string[] = []

    const result = await runImport({
      statePaths: sp,
      srcDir: src,
      destDir: dest,
      subject: 'M123',
      session: '42',
      anonymize: false,
      bidsVersion: '1.10.0',
      toolId: 'dcm2niix-reproin',
      executor: makeStubExecutor({ recordedArgv }),
      fs: nodeMutateFs,
      postPassFs: nodeFsPostPassAdapter,
    })

    // dcm2niix wrote into dest.
    expect(await pathExists(dest)).toBe(true)
    expect(
      await pathExists(
        join(dest, 'sub-M123/ses-42/anat/sub-M123_ses-42_T1w.nii.gz'),
      ),
    ).toBe(true)

    // Argv shape passed to the binary.
    expect(recordedArgv).toContain('-bi')
    expect(recordedArgv).toContain('M123')
    expect(recordedArgv).toContain('-bv')
    expect(recordedArgv).toContain('42')

    // One log entry with the import opType. Children include:
    //   - one `'created-tree'` marker for destDir (M8 epilogue —
    //     makes the import undoable as one wholesale remove)
    //   - the post-pass writes from Pass 2 (per-session scans.tsv)
    //     and Pass 3 (per-root scaffolding: CHANGES / README /
    //     .bidsignore / scans.json / participants.tsv + json).
    //
    // The dataset_description.json stub is NO LONGER written by
    // runImport for the dcm2niix-reproin path: post-v1.0.20260515
    // dcm2niix writes its own at each `<StudyDescription>/` BIDS
    // root that `-f %H` produces. We let that stub stand. For
    // pet2bids, runImport still writes the stub because destDir
    // IS the BIDS root for that path.
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.opType).toBe('import')
    const createdTrees =
      entries[0]?.children.filter((c) => c.kind === 'created-tree') ?? []
    expect(createdTrees.length).toBe(1)
    // destDir IS the dataset root, so target collapses to "".
    expect((createdTrees[0] as { target: string }).target).toBe('')
    // Pass 2: scans.tsv (1). Pass 3: CHANGES / README / scans.json (3)
    // + participants.tsv + participants.json (2) = 5 + dataset_-
    // description.json upgrade (1, heudiconv template) = 7. No fmap →
    // no B0Field edits; no func → no events.tsv, no task-bold. Total
    // = 7 writes. (.bidsignore was dropped to avoid the Tauri dotfile
    // scope issue at nested BIDS roots.)
    const writes = entries[0]?.children.filter((c) => c.kind === 'write') ?? []
    expect(writes.length).toBe(7)
    expect(
      writes.some((c) =>
        (c as { target: string }).target.includes('sub-M123_ses-42_scans.tsv'),
      ),
    ).toBe(true)
    expect(
      writes.some((c) => (c as { target: string }).target.endsWith('CHANGES')),
    ).toBe(true)
    expect(
      writes.some((c) =>
        (c as { target: string }).target.endsWith('participants.tsv'),
      ),
    ).toBe(true)
    expect((entries[0]?.details as { srcDir: string }).srcDir).toBe(src)
    expect((entries[0]?.details as { destDir: string }).destDir).toBe(dest)
    expect((entries[0]?.details as { niftiCount: number }).niftiCount).toBe(1)

    // Result shape.
    expect(result.operationId).toBe(entries[0]?.id ?? '')
    expect(result.filesCreated).toBe(2)
    expect(result.postPass.sessionCount).toBe(1)
    expect(result.postPass.scansTsvWrites).toBe(1)
    expect(result.postPass.b0FieldEdits).toBe(0)
    expect(result.postPass.scaffoldingWrites).toBe(5)
    expect(result.postPass.datasetDescriptionUpgrades).toBe(1)
    expect(result.postPass.failures).toEqual([])
    expect(result.partialFailureWarning).toBeNull()
  })

  test('dcm2niix partial-success warning flows through to RunImportResult without aborting the post-pass', async () => {
    // Mirrors a real dcm2niix exit-8 (`kEXIT_SOME_OK_SOME_BAD`):
    // some series failed (typically a localizer slice-orientation
    // mismatch) but dcm2niix wrote at least one usable NIfTI. The
    // orchestrator must NOT crash — it should commit the operation,
    // run the post-pass against what landed, and surface the warning
    // on `result.partialFailureWarning` so the wizard can render it.
    // Reproinx.py's `PARTIAL_OK = (8, 10)` is the upstream reference.
    const src = makeTmp('bidsvue-runimport-partial-src-')
    const dest = join(makeTmp('bidsvue-runimport-partial-dest-'), 'cohort')
    const recordedArgv: string[] = []
    const warning =
      'dcm2niix-reproin exited with code 8 (some series failed (kEXIT_SOME_OK_SOME_BAD)); ' +
      'continuing with post-pass against what landed on disk.\n\n' +
      'Error: DICOM incompatible with NIfTI slice orientation varies'
    const executor = makeStubExecutor({
      recordedArgv,
      runPartialFailureWarning: warning,
    })
    const result = await runImport({
      statePaths: makeStatePaths(),
      srcDir: src,
      destDir: dest,
      subject: 'M123',
      session: '42',
      anonymize: false,
      saveDerivatives: false,
      bidsVersion: '1.10.0',
      toolId: 'dcm2niix-reproin',
      executor,
      fs: nodeMutateFs,
      postPassFs: nodeFsPostPassAdapter,
    })

    // The import landed on disk + the post-pass produced its usual
    // shape; the warning is preserved verbatim.
    expect(result.filesCreated).toBe(2)
    expect(result.partialFailureWarning).toBe(warning)
    expect(result.postPass.failures).toEqual([])
  })

  test('dataset_description.json is written by the post-pass when dcm2niix did not produce one', async () => {
    // Real dcm2niix's `-f %H` writes a dummy `dataset_description.json`
    // (Name = "dcm2niix dummy dataset") at each <StudyDescription>/
    // BIDS root. The v1.0.20260520 post-pass upgrades that dummy to
    // the heudiconv reproin template + `DatasetType: "raw"` +
    // GeneratedBy + SourceDatasets. When the stub executor in this
    // test produces NO sidecar at all, the upgrade plan creates the
    // file from scratch with the same template (file-missing branch).
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'placeholder.dcm'), new Uint8Array([0]))
    const destParent = makeTmp('bidsvue-import-dest-parent-')
    const dest = join(destParent, 'fancy-folder-name')
    const sp = makeStatePaths()

    await runImport({
      statePaths: sp,
      srcDir: src,
      destDir: dest,
      anonymize: true,
      bidsVersion: '1.11.1',
      toolId: 'dcm2niix-reproin',
      executor: makeStubExecutor({ recordedArgv: [] }),
      fs: nodeMutateFs,
      postPassFs: nodeFsPostPassAdapter,
    })

    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    const writes = entries[0]?.children.filter((c) => c.kind === 'write') ?? []
    const ddesc = writes.find((c) =>
      (c as { target: string }).target.endsWith('dataset_description.json'),
    )
    expect(ddesc).toBeDefined()
    // The upgrade plan logged a 'post-pass-dataset-description-upgrade'
    // child step (kind set by planDatasetDescriptionUpgrade).
    expect((ddesc as { kind: string }).kind).toBe('write')
  })

  test('refuses non-empty destDir for tools that write subjects directly under destDir', async () => {
    // Strict check still applies to tools whose destDir IS the BIDS
    // root: dcm2bids, pet2bids, ezbids-meg, and heudiconv with a
    // non-reproin heuristic. dcm2niix-reproin (always) and
    // heudiconv + reproin heuristic (covered by the test below)
    // are the ONLY combinations that tolerate pre-existing siblings.
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const dest = makeTmp('bidsvue-import-dest-')
    await writeFile(join(dest, 'existing.txt'), 'hi', 'utf8')
    const sp = makeStatePaths()

    await expect(
      runImport({
        statePaths: sp,
        srcDir: src,
        destDir: dest,
        anonymize: false,
        // A NON-reproin heuristic writes subjects directly under destDir →
        // strict check fires. (A blank heuristic defaults to reproin, which is
        // a locator-producer — see the next test.)
        heuristic: 'convertall',
        bidsVersion: '1.10.0',
        toolId: 'heudiconv',
        executor: makeStubExecutor({ recordedArgv: [] }),
        fs: nodeMutateFs,
        postPassFs: nodeFsPostPassAdapter,
      }),
    ).rejects.toThrow(/destDir already exists and is non-empty/)
  })

  test('heudiconv with a BLANK heuristic defaults to reproin → tolerates a non-empty destDir', async () => {
    // `buildHeudiconvArgv` defaults a blank heuristic to `-f reproin` (a
    // locator-producer), so the destDir guard must agree and NOT refuse a
    // shared destination (audit round 10 P3 — the two used to disagree).
    const src = makeTmp('bidsvue-import-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const dest = makeTmp('bidsvue-import-dest-')
    await writeFile(join(dest, 'existing.txt'), 'hi', 'utf8')
    const sp = makeStatePaths()
    // It must get PAST the destDir guard (the stub executor then no-ops); a
    // non-locator tool would have thrown above. We only assert it doesn't
    // throw the destDir-non-empty error.
    await runImport({
      statePaths: sp,
      srcDir: src,
      destDir: dest,
      anonymize: false,
      // heuristic omitted → defaults to reproin.
      bidsVersion: '1.10.0',
      toolId: 'heudiconv',
      executor: makeStubExecutor({ recordedArgv: [] }),
      fs: nodeMutateFs,
      postPassFs: nodeFsPostPassAdapter,
    }).catch((err) => {
      // Any error is fine EXCEPT the destDir-non-empty refusal we're testing
      // against (downstream stub/postpass may legitimately complain).
      if (/destDir already exists and is non-empty/.test(String(err))) throw err
    })
  })

  test('heudiconv-reproin: tolerates shared SaveIn; pre-existing siblings survive', async () => {
    // When the user hides the Dataset name (heudiconv with reproin
    // heuristic, `allowsEmptyDatasetName` → true), the wizard passes
    // SaveIn as destDir directly. That folder usually contains the
    // user's other BIDS datasets. heudiconv-reproin's locator
    // subfolder (`<destDir>/<study>/sub-XX/...`) protects against
    // collisions, mirroring dcm2niix-reproin's semantics.
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const dest = makeTmp('bidsvue-import-dest-')
    // Pre-populate destDir with a sibling dataset the user already had.
    await mkdir(join(dest, 'OtherDataset'), { recursive: true })
    await writeFile(
      join(dest, 'OtherDataset', 'README'),
      'pre-existing\n',
      'utf8',
    )
    const sp = makeStatePaths()

    const result = await runImport({
      statePaths: sp,
      srcDir: src,
      destDir: dest,
      anonymize: false,
      heuristic: 'reproin',
      bidsVersion: '1.10.0',
      toolId: 'heudiconv',
      executor: makeStubExecutor({
        recordedArgv: [],
        files: [
          {
            rel: 'crlab/AgingBrain/sub-crlab/anat/sub-crlab_T1w.nii.gz',
          },
          {
            rel: 'crlab/AgingBrain/sub-crlab/anat/sub-crlab_T1w.json',
            contents: '{}',
          },
        ],
      }),
      fs: nodeMutateFs,
      postPassFs: nodeFsPostPassAdapter,
    })

    // The other dataset survived untouched.
    expect(
      await nodeMutateFs.readTextFile(join(dest, 'OtherDataset', 'README')),
    ).toBe('pre-existing\n')
    // Our locator subfolder got scaffolded — dataset_description lands
    // at the discovered nested BIDS root, not at destDir.
    const nestedRoot = join(dest, 'crlab', 'AgingBrain')
    expect(
      await nodeMutateFs.exists(join(nestedRoot, 'dataset_description.json')),
    ).toBe(true)
    expect(
      await nodeMutateFs.exists(join(dest, 'dataset_description.json')),
    ).toBe(false)
    expect(result.postPass.bidsRoots).toEqual([nestedRoot])
    // Op-log records only the NEW top-level child (our locator), not
    // a wholesale destDir wipe — so undo wouldn't touch OtherDataset.
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    const kinds = (entries[0]?.children ?? []).map(
      (c) => (c.details as { kind?: string } | undefined)?.kind ?? c.kind,
    )
    expect(kinds).toContain('import-new-child')
    expect(kinds).not.toContain('import-destdir')
  })

  // Note: the locator-name-collision scenario (pre-existing `crlab/`
  // shell + new content nested under `crlab/AgingBrain/`) is unit-
  // tested at the helper level in `postpass/bidsRoots.test.ts`
  // (`discoverBidsRootsForProduced > regression`). At the orchestrator
  // level, a populated pre-existing `crlab/` correctly trips the
  // collision check earlier in the flow (that's a load-bearing
  // protection: mixing new files into a user dataset would corrupt
  // undo). The produced-based discovery's value here is that — given
  // the orchestrator DOES allow the conversion (fresh destDir or
  // populated-but-non-colliding) — the auto-open targets the new
  // BIDS root reliably even when other top-level trees exist.
  // Covered by the test above ("tolerates shared SaveIn").

  test('reproin allows non-empty destDir; user pre-existing siblings survive', async () => {
    // The dcm2niix-reproin tool creates `<destDir>/<StudyDescription>/`
    // subfolders via `-f %H`, so pre-existing siblings in destDir are
    // safe — they're never touched. Cleanup + undo target only what
    // this call's converter wrote.
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const dest = makeTmp('bidsvue-import-dest-')
    // Pre-populate dest with a sibling the user owns.
    await writeFile(join(dest, 'existing.txt'), 'hi', 'utf8')
    await mkdir(join(dest, 'existing-folder'), { recursive: true })
    await writeFile(join(dest, 'existing-folder', 'a.json'), '{}')
    const sp = makeStatePaths()

    // Stub writes a fresh sub-XX/... tree (NOT under the StudyDescription
    // intermediate — the stub doesn't model -f %H, but the runImport
    // logic only cares about top-level diffing).
    const result = await runImport({
      statePaths: sp,
      srcDir: src,
      destDir: dest,
      anonymize: false,
      bidsVersion: '1.10.0',
      toolId: 'dcm2niix-reproin',
      executor: makeStubExecutor({ recordedArgv: [] }),
      fs: nodeMutateFs,
      postPassFs: nodeFsPostPassAdapter,
    })
    // Pre-existing siblings are untouched on disk.
    expect(await pathExists(join(dest, 'existing.txt'))).toBe(true)
    expect(await pathExists(join(dest, 'existing-folder', 'a.json'))).toBe(true)
    // operations.log: created-tree children point at the NEW top-level
    // entries (sub-M123 from the stub), NOT at destDir itself.
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    const trees =
      entries[0]?.children.filter((c) => c.kind === 'created-tree') ?? []
    expect(trees.length).toBeGreaterThan(0)
    for (const t of trees) {
      const tgt = (t as { target: string }).target
      expect(tgt).not.toBe('') // not destDir wholesale
      expect(tgt.startsWith('existing')).toBe(false)
    }
    expect(result.postPass.failures).toEqual([])
  })

  test('reproin fails fast when dcm2niix writes into a pre-existing destDir folder', async () => {
    // Round-24 audit P2: if dcm2niix's `<StudyDescription>/` happens to
    // match a pre-existing folder name in destDir, dcm2niix writes
    // INTO it. Without collision detection the new files would be
    // silently filtered by the produced-under-pre-existing-child rule
    // and the operations.log would never know about them — partial
    // corruption with no undo path. The fix snapshots each pre-
    // existing top-level child's file set, then throws if new files
    // appear there post-conversion.
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const dest = makeTmp('bidsvue-import-dest-')
    // Pre-populate dest with a "MyStudy" folder the user already has.
    await mkdir(join(dest, 'MyStudy', 'sub-old', 'anat'), { recursive: true })
    await writeFile(
      join(dest, 'MyStudy', 'sub-old', 'anat', 'sub-old_T1w.nii.gz'),
      new Uint8Array([0]),
    )
    const sp = makeStatePaths()

    // Stub that mimics dcm2niix-reproin writing INTO MyStudy/, simulating
    // a same-StudyDescription collision.
    const colliderExecutor: ImportExecutor = {
      async resolveBinary(tool) {
        return tool.kind === 'sidecar'
          ? { kind: 'sidecar', identifier: `binaries/${tool.binaryBasename}` }
          : { kind: 'external', command: tool.binaryBasename }
      },
      async run(_resolved, _argv, cwd) {
        // dcm2niix-style: drop a new sub-NEW under the pre-existing
        // MyStudy/ — the collision case.
        const newFile = join(
          cwd,
          'MyStudy',
          'sub-NEW',
          'anat',
          'sub-NEW_T1w.nii.gz',
        )
        await mkdir(join(newFile, '..'), { recursive: true })
        await writeFile(newFile, new Uint8Array([0x1f, 0x8b]))
        return { stdout: 'ok', stderr: '' }
      },
      async listFiles(dir) {
        const out: string[] = []
        const walk = async (d: string) => {
          for (const e of await readdir(d, { withFileTypes: true })) {
            const p = join(d, e.name)
            if (e.isDirectory()) await walk(p)
            else if (e.isFile()) out.push(p)
          }
        }
        await walk(dir)
        return out
      },
    }

    await expect(
      runImport({
        statePaths: sp,
        srcDir: src,
        destDir: dest,
        anonymize: false,
        bidsVersion: '1.10.0',
        toolId: 'dcm2niix-reproin',
        executor: colliderExecutor,
        fs: nodeMutateFs,
        postPassFs: nodeFsPostPassAdapter,
      }),
    ).rejects.toThrow(/wrote into pre-existing destDir folder.*MyStudy/)

    // The user's pre-existing file is untouched.
    expect(
      await pathExists(
        join(dest, 'MyStudy', 'sub-old', 'anat', 'sub-old_T1w.nii.gz'),
      ),
    ).toBe(true)
    // No log entry committed.
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    expect(entries).toHaveLength(0)
  })

  test('reproin treats baseline-walk failures as collisions (round-25 P2-3)', async () => {
    // If `executor.listFiles` throws during the pre-conversion baseline
    // walk of a pre-existing top-level directory, the previous code
    // silently disabled collision detection for that child — dcm2niix
    // could merge into it without being flagged. The fix tracks
    // baseline-failed children separately and fails fast when any
    // produced path lives under one.
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const dest = makeTmp('bidsvue-import-dest-')
    await mkdir(join(dest, 'MyStudy'), { recursive: true })
    await writeFile(join(dest, 'MyStudy', 'old.txt'), 'pre-existing', 'utf8')
    const sp = makeStatePaths()

    const flakyExecutor: ImportExecutor = {
      async resolveBinary(tool) {
        return tool.kind === 'sidecar'
          ? { kind: 'sidecar', identifier: `binaries/${tool.binaryBasename}` }
          : { kind: 'external', command: tool.binaryBasename }
      },
      async run(_resolved, _argv, cwd) {
        const newFile = join(
          cwd,
          'MyStudy',
          'sub-NEW',
          'anat',
          'sub-NEW_T1w.nii.gz',
        )
        await mkdir(join(newFile, '..'), { recursive: true })
        await writeFile(newFile, new Uint8Array([0x1f, 0x8b]))
        return { stdout: 'ok', stderr: '' }
      },
      async listFiles(dir) {
        // Throw on the baseline walk (pre-conversion: dir === destDir/MyStudy);
        // succeed on the post-conversion walk (dir === destDir).
        if (dir === join(dest, 'MyStudy')) {
          throw new Error('simulated permission denied')
        }
        const out: string[] = []
        const walk = async (d: string) => {
          for (const e of await readdir(d, { withFileTypes: true })) {
            const p = join(d, e.name)
            if (e.isDirectory()) await walk(p)
            else if (e.isFile()) out.push(p)
          }
        }
        await walk(dir)
        return out
      },
    }

    await expect(
      runImport({
        statePaths: sp,
        srcDir: src,
        destDir: dest,
        anonymize: false,
        bidsVersion: '1.10.0',
        toolId: 'dcm2niix-reproin',
        executor: flakyExecutor,
        fs: nodeMutateFs,
        postPassFs: nodeFsPostPassAdapter,
      }),
    ).rejects.toThrow(/wrote into pre-existing destDir folder.*MyStudy/)
  })

  test('refuses when dcm2niix exits 0 but produces no NIfTI', async () => {
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const destParent = makeTmp('bidsvue-import-dest-parent-')
    const dest = join(destParent, 'fresh-bids')
    const sp = makeStatePaths()

    // Stub that "succeeds" but writes only a README — no NIfTI.
    const executor = makeStubExecutor({
      recordedArgv: [],
      files: [{ rel: 'README.md', contents: 'no dicoms here' }],
    })

    await expect(
      runImport({
        statePaths: sp,
        srcDir: src,
        destDir: dest,
        anonymize: false,
        bidsVersion: '1.10.0',
        toolId: 'dcm2niix-reproin',
        executor,
        fs: nodeMutateFs,
        postPassFs: nodeFsPostPassAdapter,
      }),
    ).rejects.toThrow(/produced no NIfTI files/)

    // No log entry committed.
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    expect(entries).toHaveLength(0)
    // Round-9 audit H1: the partial destDir must be cleaned up so the
    // wizard's failure path doesn't leave an untracked README on disk.
    expect(existsSync(dest)).toBe(false)
  })

  test('cleans up an empty destDir when the converter throws (round-9 audit H1)', async () => {
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const destParent = makeTmp('bidsvue-import-dest-parent-')
    const dest = join(destParent, 'fresh-bids')
    const sp = makeStatePaths()

    // Stub that throws on run() — same shape as a non-zero exit from
    // dcm2niix/heudiconv/dcm2bids.
    const executor = makeStubExecutor({
      recordedArgv: [],
      runThrows: new Error('dcm2niix: source not readable'),
    })

    await expect(
      runImport({
        statePaths: sp,
        srcDir: src,
        destDir: dest,
        anonymize: false,
        bidsVersion: '1.10.0',
        toolId: 'dcm2niix-reproin',
        executor,
        fs: nodeMutateFs,
        postPassFs: nodeFsPostPassAdapter,
      }),
    ).rejects.toThrow(/source not readable/)

    expect(existsSync(dest)).toBe(false)
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    expect(entries).toHaveLength(0)
  })

  test('leaves a pre-existing empty destDir in place on converter failure (round-9 audit H1)', async () => {
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const destParent = makeTmp('bidsvue-import-dest-parent-')
    const dest = join(destParent, 'pre-existing-empty')
    mkdirSync(dest, { recursive: true })
    const sp = makeStatePaths()

    const executor = makeStubExecutor({
      recordedArgv: [],
      runThrows: new Error('boom'),
    })

    await expect(
      runImport({
        statePaths: sp,
        srcDir: src,
        destDir: dest,
        anonymize: false,
        bidsVersion: '1.10.0',
        toolId: 'dcm2niix-reproin',
        executor,
        fs: nodeMutateFs,
        postPassFs: nodeFsPostPassAdapter,
      }),
    ).rejects.toThrow(/boom/)

    // The user created this empty directory before launching the
    // import; we must not delete it on failure even though the
    // converter never produced anything.
    expect(existsSync(dest)).toBe(true)
  })

  test('does not create destDir if binary resolution fails (round-10 audit H3)', async () => {
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const destParent = makeTmp('bidsvue-import-dest-parent-')
    const dest = join(destParent, 'never-created')
    const sp = makeStatePaths()

    // Stub whose resolveBinary throws -- mimics a missing sidecar
    // binary or a PATH-resolution failure for an external tool.
    const executor: ImportExecutor = {
      async resolveBinary() {
        throw new Error('binary not found')
      },
      async run() {
        throw new Error('unreachable')
      },
      async listFiles() {
        return []
      },
    }

    await expect(
      runImport({
        statePaths: sp,
        srcDir: src,
        destDir: dest,
        anonymize: false,
        bidsVersion: '1.10.0',
        toolId: 'dcm2niix-reproin',
        executor,
        fs: nodeMutateFs,
        postPassFs: nodeFsPostPassAdapter,
      }),
    ).rejects.toThrow(/binary not found/)

    // Resolve happens BEFORE the mkdir, so destDir never existed.
    expect(existsSync(dest)).toBe(false)
  })

  test('does not create destDir if argv builder fails (round-10 audit H3)', async () => {
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const destParent = makeTmp('bidsvue-import-dest-parent-')
    const dest = join(destParent, 'never-created')
    const sp = makeStatePaths()
    const executor = makeStubExecutor({ recordedArgv: [] })

    // dcm2bids requires `config`; omitting it makes buildDcm2bidsArgv
    // throw before destDir creation.
    await expect(
      runImport({
        statePaths: sp,
        srcDir: src,
        destDir: dest,
        anonymize: false,
        bidsVersion: '1.10.0',
        toolId: 'dcm2bids',
        subject: '01',
        // config: undefined -- intentional
        executor,
        fs: nodeMutateFs,
        postPassFs: nodeFsPostPassAdapter,
      }),
    ).rejects.toThrow()
    expect(existsSync(dest)).toBe(false)
  })

  test('rejects a non-BIDS subject label (TS-layer flag-injection mitigation)', async () => {
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const destParent = makeTmp('bidsvue-import-dest-parent-')
    const dest = join(destParent, 'fresh-bids')
    const sp = makeStatePaths()

    await expect(
      runImport({
        statePaths: sp,
        srcDir: src,
        destDir: dest,
        // `-deleteAll` would look like a flag to dcm2niix; the BIDS-
        // label regex on subject blocks it before argv is built.
        subject: '-deleteAll',
        anonymize: false,
        bidsVersion: '1.10.0',
        toolId: 'dcm2niix-reproin',
        executor: makeStubExecutor({ recordedArgv: [] }),
        fs: nodeMutateFs,
        postPassFs: nodeFsPostPassAdapter,
      }),
    ).rejects.toThrow(/subject must contain only letters and digits/)
  })

  test('rejects a srcDir that starts with a dash', async () => {
    const dest = makeTmp('bidsvue-import-dest-')
    const sp = makeStatePaths()

    await expect(
      runImport({
        statePaths: sp,
        srcDir: '/-evil/dicoms',
        destDir: dest,
        anonymize: false,
        bidsVersion: '1.10.0',
        toolId: 'dcm2niix-reproin',
        executor: makeStubExecutor({ recordedArgv: [] }),
        fs: nodeMutateFs,
        postPassFs: nodeFsPostPassAdapter,
      }),
    ).rejects.toThrow(/must not start with a dash/)
  })

  test('external tool (heudiconv) skips the M8-A2 post-pass', async () => {
    // heudiconv writes _scans.tsv + B0Field* cross-refs itself, so the
    // orchestrator's post-pass would double-up or overwrite that work.
    // Verify the post-pass result is empty AND the committed log entry
    // has no 'post-pass-scans-tsv' / 'post-pass-b0-field' children.
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const destParent = makeTmp('bidsvue-import-dest-parent-')
    const dest = join(destParent, 'fresh-bids')
    const sp = makeStatePaths()
    const recordedArgv: string[] = []

    const result = await runImport({
      statePaths: sp,
      srcDir: src,
      destDir: dest,
      subject: 'M123',
      session: '42',
      // anonymize is dcm2niix-specific; heudiconv ignores it, but the
      // orchestrator still requires the option for type-stability.
      anonymize: false,
      bidsVersion: '1.10.0',
      toolId: 'heudiconv',
      executor: makeStubExecutor({ recordedArgv }),
      fs: nodeMutateFs,
      postPassFs: nodeFsPostPassAdapter,
    })

    // Heudiconv argv reached the executor: `-f reproin`, `--files`, etc.
    expect(recordedArgv).toContain('-f')
    expect(recordedArgv).toContain('reproin')
    expect(recordedArgv).toContain('--files')
    expect(recordedArgv).toContain('-s')
    expect(recordedArgv).toContain('-ss')
    // dcm2niix-only flags must NOT appear.
    expect(recordedArgv).not.toContain('-bi')
    expect(recordedArgv).not.toContain('-bv')
    expect(recordedArgv).not.toContain('-ba')

    // Post-pass is skipped — sessionCount stays 0, no failures.
    expect(result.postPass.sessionCount).toBe(0)
    expect(result.postPass.scansTsvWrites).toBe(0)
    expect(result.postPass.b0FieldEdits).toBe(0)
    expect(result.postPass.failures).toEqual([])

    // Log entry: created-tree marker plus if-absent scaffolding stubs
    // (heudiconv normally writes its own dataset_description.json, so the
    // ifAbsent guard would skip these against a real heudiconv run; the
    // stub executor here writes nothing on disk so the orchestrator
    // rescues the open-dataset gate). No 'post-pass-*' kinds.
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.opType).toBe('import')
    const kinds = (entries[0]?.children ?? []).map(
      (c) => (c.details as { kind?: string } | undefined)?.kind ?? c.kind,
    )
    expect(kinds).toContain('import-destdir')
    expect(kinds).not.toContain('post-pass-scans-tsv')
    expect(kinds).not.toContain('post-pass-b0-field')
  })

  test('heudiconv: custom heuristic flows from caller to argv + log details', async () => {
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const destParent = makeTmp('bidsvue-import-dest-parent-')
    const dest = join(destParent, 'fresh-bids')
    const sp = makeStatePaths()
    const recordedArgv: string[] = []

    await runImport({
      statePaths: sp,
      srcDir: src,
      destDir: dest,
      anonymize: false,
      // Pretend the user picked a custom .py heuristic via Browse…
      heuristic: '/Users/me/heuristic.py',
      bidsVersion: '1.10.0',
      toolId: 'heudiconv',
      executor: makeStubExecutor({ recordedArgv }),
      fs: nodeMutateFs,
      postPassFs: nodeFsPostPassAdapter,
    })

    // The custom heuristic landed in -f.
    const fIdx = recordedArgv.indexOf('-f')
    expect(fIdx).toBeGreaterThanOrEqual(0)
    expect(recordedArgv[fIdx + 1]).toBe('/Users/me/heuristic.py')

    // …and was recorded in the op-log details for audit / undo UI.
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    expect(
      (entries[0]?.details as { heuristic: string | null } | undefined)
        ?.heuristic,
    ).toBe('/Users/me/heuristic.py')
  })

  test('dcm2bids: config flows to argv + log, post-pass skipped, scaffolding written', async () => {
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const destParent = makeTmp('bidsvue-import-dest-parent-')
    const dest = join(destParent, 'fresh-bids')
    const sp = makeStatePaths()
    const recordedArgv: string[] = []

    const result = await runImport({
      statePaths: sp,
      srcDir: src,
      destDir: dest,
      subject: 'M123',
      session: '42',
      anonymize: false,
      config: '/etc/dcm2bids/study.json',
      bidsVersion: '1.10.0',
      toolId: 'dcm2bids',
      executor: makeStubExecutor({ recordedArgv }),
      fs: nodeMutateFs,
      postPassFs: nodeFsPostPassAdapter,
    })

    // dcm2bids argv: -d / -p / -c / -o / -s, never --auto_extract_entities
    // (intentionally not exposed — see buildDcm2bidsArgv docstring).
    expect(recordedArgv).toContain('-d')
    expect(recordedArgv).toContain('-p')
    expect(recordedArgv).toContain('-c')
    expect(recordedArgv).toContain('/etc/dcm2bids/study.json')
    expect(recordedArgv).toContain('-s')
    expect(recordedArgv).not.toContain('--auto_extract_entities')
    // No flags from the other importers.
    expect(recordedArgv).not.toContain('-bi')
    expect(recordedArgv).not.toContain('-bv')
    expect(recordedArgv).not.toContain('-f')
    expect(recordedArgv).not.toContain('--files')

    // Post-pass skipped — dcm2bids writes its own sidecars + IntendedFor.
    expect(result.postPass.sessionCount).toBe(0)
    expect(result.postPass.scansTsvWrites).toBe(0)
    expect(result.postPass.b0FieldEdits).toBe(0)

    // Log entry records the config for audit / undo UI.
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    const details = entries[0]?.details as { config: string | null } | undefined
    expect(details?.config).toBe('/etc/dcm2bids/study.json')

    // Scaffolding written: dataset_description.json + README so the
    // freshly-imported tree opens in BIDSvue without no-dataset-description.
    const ddPath = join(dest, 'dataset_description.json')
    expect(await nodeMutateFs.exists(ddPath)).toBe(true)
    const dd = JSON.parse(await nodeMutateFs.readTextFile(ddPath)) as {
      Name: string
      BIDSVersion: string
      DatasetType: string
      GeneratedBy: { Name: string; CodeURL: string }[]
    }
    expect(dd.BIDSVersion).toBe('1.10.0')
    expect(dd.DatasetType).toBe('raw')
    expect(dd.Name).toBe('fresh-bids')
    expect(dd.GeneratedBy[0]?.CodeURL).toBe('dcm2bids')
    const readmePath = join(dest, 'README')
    expect(await nodeMutateFs.exists(readmePath)).toBe(true)
  })

  test('heudiconv-reproin: scaffolding lands at the discovered BIDS root, not destDir', async () => {
    // heudiconv with the reproin heuristic derives a locator from
    // StudyDescription and nests output as
    // `<destDir>/<locator>/sub-XX/...`. Before this fix, the
    // `'none'`-branch scaffolding wrote dataset_description.json +
    // README at destDir literally — one level above the actual BIDS
    // root — so BIDSvue's auto-open landed on a non-dataset folder
    // and the user saw the description at the wrong path.
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const destParent = makeTmp('bidsvue-import-dest-parent-')
    const dest = join(destParent, 'X')
    const sp = makeStatePaths()

    // Stub heudiconv-reproin output: subjects under a 2-level locator
    // derived from "crlab AgingBrain" → crlab/AgingBrain (mirrors the
    // user-reported case).
    const result = await runImport({
      statePaths: sp,
      srcDir: src,
      destDir: dest,
      anonymize: false,
      bidsVersion: '1.10.0',
      toolId: 'heudiconv',
      executor: makeStubExecutor({
        recordedArgv: [],
        files: [
          {
            rel: 'crlab/AgingBrain/sub-crlab/anat/sub-crlab_T1w.nii.gz',
          },
          {
            rel: 'crlab/AgingBrain/sub-crlab/anat/sub-crlab_T1w.json',
            contents: '{}',
          },
        ],
      }),
      fs: nodeMutateFs,
      postPassFs: nodeFsPostPassAdapter,
    })

    // Scaffolding lands at the NESTED root, not at destDir.
    const nestedRoot = join(dest, 'crlab', 'AgingBrain')
    expect(
      await nodeMutateFs.exists(join(nestedRoot, 'dataset_description.json')),
    ).toBe(true)
    expect(await nodeMutateFs.exists(join(nestedRoot, 'README'))).toBe(true)
    // destDir-level scaffolding MUST NOT exist — that's the bug.
    expect(
      await nodeMutateFs.exists(join(dest, 'dataset_description.json')),
    ).toBe(false)
    expect(await nodeMutateFs.exists(join(dest, 'README'))).toBe(false)
    // Discovered root flows through to the orchestrator's auto-open
    // target via postPass.bidsRoots.
    expect(result.postPass.bidsRoots).toEqual([nestedRoot])
    // Dataset name in the description tracks the BIDS root basename,
    // not destDir's basename (here 'X').
    const dd = JSON.parse(
      await nodeMutateFs.readTextFile(
        join(nestedRoot, 'dataset_description.json'),
      ),
    ) as { Name: string }
    expect(dd.Name).toBe('AgingBrain')
  })

  test('dcm2bids: tmp_dcm2bids/ working dir is wiped after a successful conversion', async () => {
    // dcm2bids creates `<destDir>/tmp_dcm2bids/` as the dcm2niix working
    // dir, then MOVES matched series into the BIDS layout and leaves
    // unmatched ones (scouts, derivatives, log/) behind. Without
    // cleanup the imported tree fails BIDS validation. The orchestrator
    // wipes the working dir after the post-pass.
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const destParent = makeTmp('bidsvue-import-dest-parent-')
    const dest = join(destParent, 'fresh-bids')
    const sp = makeStatePaths()
    const recordedArgv: string[] = []

    // Stub executor that writes BOTH a real BIDS file AND a leftover
    // tmp_dcm2bids/ dir matching dcm2bids' actual behavior.
    const executor = {
      async resolveBinary() {
        return { kind: 'external' as const, command: 'dcm2bids' }
      },
      async run(_resolved: unknown, _argv: readonly string[], _cwd: string) {
        await mkdir(join(dest, 'sub-M123', 'anat'), { recursive: true })
        await writeFile(
          join(dest, 'sub-M123', 'anat', 'sub-M123_T1w.nii.gz'),
          new Uint8Array([0]),
        )
        await mkdir(join(dest, 'tmp_dcm2bids', 'sub-M123'), { recursive: true })
        await mkdir(join(dest, 'tmp_dcm2bids', 'log'), { recursive: true })
        await writeFile(
          join(dest, 'tmp_dcm2bids', 'sub-M123', 'leftover.nii.gz'),
          new Uint8Array([0]),
        )
        await writeFile(
          join(dest, 'tmp_dcm2bids', 'log', 'sub-M123_run.log'),
          'log\n',
        )
        recordedArgv.push(..._argv)
        return { stdout: '', stderr: '' }
      },
      async listFiles(dir: string) {
        const out: string[] = []
        const walk = async (d: string) => {
          for (const e of await readdir(d, { withFileTypes: true })) {
            const p = join(d, e.name)
            if (e.isDirectory()) await walk(p)
            else if (e.isFile()) out.push(p)
          }
        }
        await walk(dir)
        return out
      },
    }

    await runImport({
      statePaths: sp,
      srcDir: src,
      destDir: dest,
      subject: 'M123',
      anonymize: false,
      config: '/etc/dcm2bids/study.json',
      bidsVersion: '1.10.0',
      toolId: 'dcm2bids',
      executor,
      fs: nodeMutateFs,
      postPassFs: nodeFsPostPassAdapter,
    })

    // BIDS layout intact.
    expect(
      await nodeMutateFs.exists(
        join(dest, 'sub-M123', 'anat', 'sub-M123_T1w.nii.gz'),
      ),
    ).toBe(true)
    // tmp_dcm2bids/ wiped.
    expect(await nodeMutateFs.exists(join(dest, 'tmp_dcm2bids'))).toBe(false)
    // Log entry recorded the cleanup as a child step for audit.
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    const kinds = (entries[0]?.children ?? []).map(
      (c) => (c.details as { kind?: string } | undefined)?.kind ?? c.kind,
    )
    expect(kinds).toContain('dcm2bids-tmp-cleanup')
  })

  test('dcm2bids: cleanupUnmatched=false keeps tmp_dcm2bids/ for debugging', async () => {
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const destParent = makeTmp('bidsvue-import-dest-parent-')
    const dest = join(destParent, 'fresh-bids')
    const sp = makeStatePaths()

    const executor = {
      async resolveBinary() {
        return { kind: 'external' as const, command: 'dcm2bids' }
      },
      async run(_resolved: unknown, _argv: readonly string[], _cwd: string) {
        await mkdir(join(dest, 'sub-M123', 'anat'), { recursive: true })
        await writeFile(
          join(dest, 'sub-M123', 'anat', 'sub-M123_T1w.nii.gz'),
          new Uint8Array([0]),
        )
        await mkdir(join(dest, 'tmp_dcm2bids', 'sub-M123'), { recursive: true })
        await writeFile(
          join(dest, 'tmp_dcm2bids', 'sub-M123', 'leftover.nii.gz'),
          new Uint8Array([0]),
        )
        return { stdout: '', stderr: '' }
      },
      async listFiles(dir: string) {
        const out: string[] = []
        const walk = async (d: string) => {
          for (const e of await readdir(d, { withFileTypes: true })) {
            const p = join(d, e.name)
            if (e.isDirectory()) await walk(p)
            else if (e.isFile()) out.push(p)
          }
        }
        await walk(dir)
        return out
      },
    }

    await runImport({
      statePaths: sp,
      srcDir: src,
      destDir: dest,
      subject: 'M123',
      anonymize: false,
      config: '/etc/dcm2bids/study.json',
      cleanupUnmatched: false,
      bidsVersion: '1.10.0',
      toolId: 'dcm2bids',
      executor,
      fs: nodeMutateFs,
      postPassFs: nodeFsPostPassAdapter,
    })

    expect(await nodeMutateFs.exists(join(dest, 'tmp_dcm2bids'))).toBe(true)
    const entries = await readOperationsLog(sp.operationsLogPath, nodeMutateFs)
    const kinds = (entries[0]?.children ?? []).map(
      (c) => (c.details as { kind?: string } | undefined)?.kind ?? c.kind,
    )
    expect(kinds).not.toContain('dcm2bids-tmp-cleanup')
  })

  test('dcm2bids: scaffolding is if-absent and never clobbers a pre-existing dataset_description.json', async () => {
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const destParent = makeTmp('bidsvue-import-dest-parent-')
    const dest = join(destParent, 'fresh-bids')
    const sp = makeStatePaths()
    const recordedArgv: string[] = []

    const customDescription = JSON.stringify(
      { Name: 'My Curated Dataset', BIDSVersion: '1.6.0' },
      null,
      2,
    )
    const customReadme = '# Curated\nHand-written README the user wrote.\n'
    // Stub executor writes a NIfTI AND pre-creates the user's curated
    // top-level files before the orchestrator's scaffolding step.
    const executor = {
      async resolveBinary() {
        return { kind: 'external' as const, command: 'dcm2bids' }
      },
      async run(_resolved: unknown, _argv: readonly string[], _cwd: string) {
        await mkdir(dest, { recursive: true })
        await writeFile(join(dest, 'sub-M123_T1w.nii.gz'), new Uint8Array([0]))
        await writeFile(
          join(dest, 'dataset_description.json'),
          customDescription,
        )
        await writeFile(join(dest, 'README'), customReadme)
        recordedArgv.push(..._argv)
        return { stdout: '', stderr: '' }
      },
      async listFiles(dir: string) {
        return [
          join(dir, 'sub-M123_T1w.nii.gz'),
          join(dir, 'dataset_description.json'),
          join(dir, 'README'),
        ]
      },
    }

    await runImport({
      statePaths: sp,
      srcDir: src,
      destDir: dest,
      subject: 'M123',
      anonymize: false,
      config: '/etc/dcm2bids/study.json',
      bidsVersion: '1.10.0',
      toolId: 'dcm2bids',
      executor,
      fs: nodeMutateFs,
      postPassFs: nodeFsPostPassAdapter,
    })

    // The pre-existing files survived intact — the if-absent guard
    // never overwrote them.
    const dd = await nodeMutateFs.readTextFile(
      join(dest, 'dataset_description.json'),
    )
    expect(dd).toBe(customDescription)
    const readme = await nodeMutateFs.readTextFile(join(dest, 'README'))
    expect(readme).toBe(customReadme)
  })

  test('dcm2bids: orchestrator rejects a missing config path', async () => {
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const destParent = makeTmp('bidsvue-import-dest-parent-')
    const dest = join(destParent, 'fresh-bids')
    const sp = makeStatePaths()

    await expect(
      runImport({
        statePaths: sp,
        srcDir: src,
        destDir: dest,
        subject: 'M123',
        anonymize: false,
        // No `config` — buildArgvForTool should refuse.
        bidsVersion: '1.10.0',
        toolId: 'dcm2bids',
        executor: makeStubExecutor({ recordedArgv: [] }),
        fs: nodeMutateFs,
        postPassFs: nodeFsPostPassAdapter,
      }),
    ).rejects.toThrow(/dcm2bids requires a config path/)
  })

  test('dcm2bids: orchestrator rejects a missing subject', async () => {
    const src = makeTmp('bidsvue-dicom-src-')
    await writeFile(join(src, 'a.dcm'), new Uint8Array([0]))
    const destParent = makeTmp('bidsvue-import-dest-parent-')
    const dest = join(destParent, 'fresh-bids')
    const sp = makeStatePaths()

    await expect(
      runImport({
        statePaths: sp,
        srcDir: src,
        destDir: dest,
        // No subject — buildArgvForTool should refuse (the wizard's
        // `required: true` should prevent this at the UI layer; the
        // orchestrator guard is defense in depth).
        config: '/etc/dcm2bids/study.json',
        anonymize: false,
        bidsVersion: '1.10.0',
        toolId: 'dcm2bids',
        executor: makeStubExecutor({ recordedArgv: [] }),
        fs: nodeMutateFs,
        postPassFs: nodeFsPostPassAdapter,
      }),
    ).rejects.toThrow(/dcm2bids requires a subject/)
  })
})

describe('runImport — pet2bids orchestrator integration (P2.1)', () => {
  // Round-14 Codex P2.1: the M12 PET orchestrator changes
  // (metadata pre-load, zero-sidecar abort, per-sidecar abort,
  // pre-existing-destDir cleanup) were under-covered. The PET
  // helper tests exercise `runPetPostPass` directly but never
  // drove `runImport` through the new fatality + cleanup paths.

  const RAW_PET_SIDECAR = {
    Modality: 'PT',
    Manufacturer: 'GE',
    TracerName: 'FDG',
    TracerRadionuclide: '18F',
    InjectedRadioactivity: 75.85,
    InjectedRadioactivityUnits: 'MBq',
    Units: 'Bq/mL',
    SeriesTime: '09:28:23',
  }

  /** Stub executor that writes a single `_pet.json` under sub-X/pet/. */
  function makePetStubExecutor(opts: {
    recordedArgv: string[]
    subject?: string
    petSidecar?: Record<string, unknown>
    nonPetFiles?: ReadonlyArray<{ rel: string }>
    runThrows?: Error
  }): ImportExecutor {
    const subject = opts.subject ?? 'phantom'
    const sidecar = opts.petSidecar ?? RAW_PET_SIDECAR
    const files = opts.nonPetFiles ?? []
    return {
      async resolveBinary(tool) {
        return {
          kind: 'sidecar',
          identifier: `binaries/${tool.binaryBasename}`,
        }
      },
      async run(_resolved, argv, cwd) {
        opts.recordedArgv.push(...argv)
        if (opts.runThrows) throw opts.runThrows
        const petDir = join(cwd, `sub-${subject}`, 'pet')
        await mkdir(petDir, { recursive: true })
        await writeFile(
          join(petDir, `sub-${subject}_pet.json`),
          JSON.stringify(sidecar),
        )
        await writeFile(
          join(petDir, `sub-${subject}_pet.nii.gz`),
          new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
        )
        for (const f of files) {
          const abs = join(cwd, f.rel)
          await mkdir(join(abs, '..'), { recursive: true })
          await writeFile(abs, '')
        }
        return { stdout: '', stderr: '' }
      },
      async listFiles(dir) {
        const out: string[] = []
        const walk = async (d: string): Promise<void> => {
          let names: string[] = []
          try {
            names = await readdir(d)
          } catch {
            return
          }
          for (const name of names) {
            const child = join(d, name)
            const s = await stat(child)
            if (s.isDirectory()) await walk(child)
            else if (s.isFile()) out.push(child)
          }
        }
        await walk(dir)
        return out
      },
    }
  }

  test('happy path enriches the _pet.json and returns petPostPass stats', async () => {
    const srcDir = makeTmp('bidsvue-pet-src-')
    await writeFile(join(srcDir, 'dummy.dcm'), '')
    const destDir = join(makeTmp('bidsvue-pet-dest-'), 'out')

    const recordedArgv: string[] = []
    const result = await runImport({
      statePaths: makeStatePaths(),
      srcDir,
      destDir,
      subject: 'phantom',
      anonymize: false,
      bidsVersion: '1.10.0',
      toolId: 'pet2bids',
      executor: makePetStubExecutor({ recordedArgv }),
      fs: nodeMutateFs,
      postPassFs: nodeFsPostPassAdapter,
    })

    expect(result.postPass.sessionCount).toBe(0)
    expect(result.petPostPass.sidecarsEnriched).toBe(1)
    expect(result.petPostPass.failures).toHaveLength(0)
    // Uses the pet2bids argv (explicit -f sub-<subject>_pet, no -br /
    // -bi). The output goes directly under sub-X/pet/ which the
    // orchestrator pre-creates and the argv builder points -o at.
    expect(recordedArgv).toContain('-f')
    expect(recordedArgv).toContain('sub-phantom_pet')
    expect(recordedArgv).not.toContain('-br')
    expect(recordedArgv).not.toContain('-bi')
    // -o lands at the BIDS-canonical pet/ subdir.
    const oIdx = recordedArgv.indexOf('-o')
    expect(oIdx).toBeGreaterThanOrEqual(0)
    expect(recordedArgv[oIdx + 1]).toContain('/sub-phantom/pet')
  })

  test('zero PET sidecars throws + removes destDir we created', async () => {
    const srcDir = makeTmp('bidsvue-pet-src-')
    await writeFile(join(srcDir, 'dummy.dcm'), '')
    const destDir = join(makeTmp('bidsvue-pet-dest-'), 'out')

    // Stub that writes only non-PET files -- post-pass finds zero
    // `_pet.json` and the orchestrator throws.
    const exec: ImportExecutor = {
      async resolveBinary(tool) {
        return {
          kind: 'sidecar',
          identifier: `binaries/${tool.binaryBasename}`,
        }
      },
      async run(_resolved, _argv, cwd) {
        const anatDir = join(cwd, 'sub-phantom', 'anat')
        await mkdir(anatDir, { recursive: true })
        await writeFile(join(anatDir, 'sub-phantom_T1w.json'), '{}')
        await writeFile(
          join(anatDir, 'sub-phantom_T1w.nii.gz'),
          new Uint8Array([0x1f, 0x8b, 0x08, 0x00]),
        )
        return { stdout: '', stderr: '' }
      },
      async listFiles(dir) {
        const out: string[] = []
        const walk = async (d: string): Promise<void> => {
          for (const name of await readdir(d)) {
            const child = join(d, name)
            const s = await stat(child)
            if (s.isDirectory()) await walk(child)
            else out.push(child)
          }
        }
        await walk(dir)
        return out
      },
    }

    await expect(
      runImport({
        statePaths: makeStatePaths(),
        srcDir,
        destDir,
        subject: 'phantom',
        anonymize: false,
        bidsVersion: '1.10.0',
        toolId: 'pet2bids',
        executor: exec,
        fs: nodeMutateFs,
        postPassFs: nodeFsPostPassAdapter,
      }),
    ).rejects.toThrow(/enriched 0 PET sidecars/)
    expect(await pathExists(destDir)).toBe(false)
  })

  test('zero sidecars + pre-existing empty destDir empties contents, leaves dir, error says "contents were cleaned"', async () => {
    const srcDir = makeTmp('bidsvue-pet-src-')
    await writeFile(join(srcDir, 'dummy.dcm'), '')
    // User pre-created an empty dest dir.
    const destParent = makeTmp('bidsvue-pet-dest-')
    const destDir = join(destParent, 'out')
    mkdirSync(destDir)

    const exec: ImportExecutor = {
      async resolveBinary(tool) {
        return {
          kind: 'sidecar',
          identifier: `binaries/${tool.binaryBasename}`,
        }
      },
      async run(_resolved, _argv, cwd) {
        // Write non-PET files only -- triggers the zero-sidecar
        // post-pass branch (must include a .nii.gz so the niftiCount
        // preflight passes and we reach the PET post-pass).
        const anatDir = join(cwd, 'sub-phantom', 'anat')
        await mkdir(anatDir, { recursive: true })
        await writeFile(join(anatDir, 'sub-phantom_T1w.json'), '{}')
        await writeFile(
          join(anatDir, 'sub-phantom_T1w.nii.gz'),
          new Uint8Array([0x1f, 0x8b]),
        )
        return { stdout: '', stderr: '' }
      },
      async listFiles(dir) {
        const out: string[] = []
        const walk = async (d: string): Promise<void> => {
          for (const name of await readdir(d)) {
            const child = join(d, name)
            const s = await stat(child)
            if (s.isDirectory()) await walk(child)
            else out.push(child)
          }
        }
        await walk(dir)
        return out
      },
    }

    await expect(
      runImport({
        statePaths: makeStatePaths(),
        srcDir,
        destDir,
        subject: 'phantom',
        anonymize: false,
        bidsVersion: '1.10.0',
        toolId: 'pet2bids',
        executor: exec,
        fs: nodeMutateFs,
        postPassFs: nodeFsPostPassAdapter,
      }),
    ).rejects.toThrow(/contents were cleaned/)

    // destDir still exists; the empty shell stays (user pre-created it).
    expect(await pathExists(destDir)).toBe(true)
    // Contents are gone -- no sub-phantom/ left behind.
    expect(await pathExists(join(destDir, 'sub-phantom'))).toBe(false)
  })

  test('per-sidecar failure aborts the import (any failure is fatal, even mixed with successes)', async () => {
    const srcDir = makeTmp('bidsvue-pet-src-')
    await writeFile(join(srcDir, 'dummy.dcm'), '')
    const destDir = join(makeTmp('bidsvue-pet-dest-'), 'out')

    // Write TWO sidecars: one valid, one malformed (array root).
    // sidecarsEnriched=1 + failures.length=1 -- the orchestrator
    // takes the "any-failure-is-fatal" branch (not the zero-sidecar
    // branch).
    await expect(
      runImport({
        statePaths: makeStatePaths(),
        srcDir,
        destDir,
        subject: 'phantom',
        anonymize: false,
        bidsVersion: '1.10.0',
        toolId: 'pet2bids',
        executor: {
          async resolveBinary(tool) {
            return {
              kind: 'sidecar',
              identifier: `binaries/${tool.binaryBasename}`,
            }
          },
          async run(_resolved, _argv, cwd) {
            // Good sidecar: sub-01/pet/sub-01_pet.json
            const good = join(cwd, 'sub-01', 'pet')
            await mkdir(good, { recursive: true })
            await writeFile(
              join(good, 'sub-01_pet.json'),
              JSON.stringify(RAW_PET_SIDECAR),
            )
            await writeFile(
              join(good, 'sub-01_pet.nii.gz'),
              new Uint8Array([0x1f, 0x8b]),
            )
            // Bad sidecar: sub-02/pet/sub-02_pet.json with array root.
            const bad = join(cwd, 'sub-02', 'pet')
            await mkdir(bad, { recursive: true })
            await writeFile(
              join(bad, 'sub-02_pet.json'),
              JSON.stringify([1, 2, 3]),
            )
            await writeFile(
              join(bad, 'sub-02_pet.nii.gz'),
              new Uint8Array([0x1f, 0x8b]),
            )
            return { stdout: '', stderr: '' }
          },
          async listFiles(dir) {
            const out: string[] = []
            const walk = async (d: string): Promise<void> => {
              for (const name of await readdir(d)) {
                const child = join(d, name)
                const s = await stat(child)
                if (s.isDirectory()) await walk(child)
                else out.push(child)
              }
            }
            await walk(dir)
            return out
          },
        },
        fs: nodeMutateFs,
        postPassFs: nodeFsPostPassAdapter,
      }),
    ).rejects.toThrow(/pet2bids post-pass failed on 1 sidecar/)
    expect(await pathExists(destDir)).toBe(false)
  })

  test('malformed metadata file aborts BEFORE converter mutates disk', async () => {
    const srcDir = makeTmp('bidsvue-pet-src-')
    await writeFile(join(srcDir, 'dummy.dcm'), '')
    const destDir = join(makeTmp('bidsvue-pet-dest-'), 'out')
    const metaPath = join(makeTmp('bidsvue-pet-meta-'), 'meta.json')
    await writeFile(metaPath, '{ not valid json')

    let converterCalled = false
    const recordedArgv: string[] = []

    await expect(
      runImport({
        statePaths: makeStatePaths(),
        srcDir,
        destDir,
        subject: 'phantom',
        anonymize: false,
        petMetadataPath: metaPath,
        bidsVersion: '1.10.0',
        toolId: 'pet2bids',
        executor: {
          async resolveBinary(tool) {
            return {
              kind: 'sidecar',
              identifier: `binaries/${tool.binaryBasename}`,
            }
          },
          async run(_resolved, _argv, _cwd) {
            converterCalled = true
            return { stdout: '', stderr: '' }
          },
          async listFiles(_dir) {
            return []
          },
        },
        fs: nodeMutateFs,
        postPassFs: nodeFsPostPassAdapter,
      }),
    ).rejects.toThrow(/PET metadata file .* is not valid JSON/)

    // The converter must NOT have run; destDir must NOT have been
    // created. Round-14 Codex P1.3 + audit-13 P1.3 guarantee.
    expect(converterCalled).toBe(false)
    expect(await pathExists(destDir)).toBe(false)
    void recordedArgv
  })

  test('pet2bids without a subject throws at argv-build time (pre-converter)', async () => {
    const srcDir = makeTmp('bidsvue-pet-src-')
    await writeFile(join(srcDir, 'dummy.dcm'), '')
    const destDir = join(makeTmp('bidsvue-pet-dest-'), 'out')

    await expect(
      runImport({
        statePaths: makeStatePaths(),
        srcDir,
        destDir,
        anonymize: false,
        bidsVersion: '1.10.0',
        toolId: 'pet2bids',
        executor: makePetStubExecutor({ recordedArgv: [] }),
        fs: nodeMutateFs,
        postPassFs: nodeFsPostPassAdapter,
      }),
    ).rejects.toThrow(/pet2bids requires a subject/)
  })
})
