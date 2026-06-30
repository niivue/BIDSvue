// End-to-end test of the CTF MEG import orchestrator. Builds a
// synthetic .ds directory in a tmp dir, runs the orchestrator
// against `nodeMutateFs`, asserts the output tree shape and sidecar
// contents.
//
// The synthetic .res4 + .hc come from the same helpers used by the
// header / channels / coordsystem tests, so a regression in any of
// those parsers shows up here as well.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOperationsLog } from '$lib/mutate/operationsLog'
import { nodeMutateFs } from '$lib/mutate/testFs'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { buildEntityStem, runMegImport } from './runMegImport'

const tempDirs: string[] = []

function makeTmp(prefix = 'bidsvue-meg-import-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeStatePaths(): DatasetStatePaths {
  const stateDir = mkdtempSync(join(tmpdir(), 'bidsvue-meg-import-state-'))
  tempDirs.push(stateDir)
  return {
    stateDir,
    prefsPath: join(stateDir, 'prefs.json'),
    operationsLogPath: join(stateDir, 'operations.log'),
    originalsDir: join(stateDir, 'originals'),
    metaPath: join(stateDir, 'meta.json'),
  }
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

// ---------------------------------------------------------------------------
// Synthetic .res4 / .hc fixture builders. Same byte layout as the
// production parsers expect; the .res4 builder is a trimmed
// adaptation of the one used in header.test.ts.
// ---------------------------------------------------------------------------

interface SyntheticChannel {
  name: string
  sensorTypeIndex: number
  coilType: number
  gradOrder: number
}

interface SyntheticRes4 {
  sfreq: number
  nsamp: number
  noTrials: number
  channels: SyntheticChannel[]
}

function buildRes4(opts: SyntheticRes4): Uint8Array {
  const nchan = opts.channels.length
  const CH_DT_SIZE = 1328
  const total = 1844 + 2 + nchan * 32 + nchan * CH_DT_SIZE
  const buf = new Uint8Array(total)
  const view = new DataView(buf.buffer)
  let off = 0
  const enc = new TextEncoder()
  const writeFixed = (str: string, n: number): void => {
    const bytes = enc.encode(str)
    if (bytes.length >= n) buf.set(bytes.subarray(0, n - 1), off)
    else buf.set(bytes, off)
    off += n
  }
  const writeI16 = (v: number) => {
    view.setInt16(off, v, false)
    off += 2
  }
  const writeI32 = (v: number) => {
    view.setInt32(off, v, false)
    off += 4
  }
  const writeF64 = (v: number) => {
    view.setFloat64(off, v, false)
    off += 8
  }
  const alignTo = (b: number) => {
    const rem = off % b
    if (rem !== 0) off += b - rem
  }
  writeFixed('MEG41RS', 8)
  off += 256 + 256 + 256
  writeI16(0)
  writeFixed('09:54:32', 255)
  writeFixed('24-Nov-2008', 255)
  writeI32(opts.nsamp)
  writeI16(nchan)
  alignTo(8)
  writeF64(opts.sfreq)
  writeF64(0)
  writeI16(opts.noTrials)
  off = 1844
  writeI16(0) // nfilt
  for (const ch of opts.channels) writeFixed(ch.name, 32)
  for (const ch of opts.channels) {
    const start = off
    writeI16(ch.sensorTypeIndex)
    writeI16(0)
    writeI32(ch.coilType)
    writeF64(0)
    writeF64(0)
    writeF64(0)
    writeF64(0)
    writeI16(0)
    writeI16(ch.gradOrder)
    writeI32(0)
    off = start + CH_DT_SIZE
  }
  return buf
}

const SAMPLE_HC = `\
measured nasion coil position relative to head (cm):
\tx = 9.83045
\ty = 0
\tz = 0
measured left ear coil position relative to head (cm):
\tx = -0.0899511
\ty = 7.20121
\tz = 0
measured right ear coil position relative to head (cm):
\tx = 0.0899511
\ty = -7.20121
\tz = 0
`

/**
 * Lay down a synthetic CTF `.ds` directory at `dsPath`. The stem is
 * the basename of `dsPath` minus the `.ds` suffix. Returns the list
 * of files created (basenames).
 */
async function writeSyntheticCtfDs(dsPath: string): Promise<string[]> {
  await mkdir(dsPath, { recursive: true })
  const stem = dsPath.split('/').pop()?.replace(/\.ds$/, '') ?? ''
  const res4 = buildRes4({
    sfreq: 480,
    nsamp: 1000,
    noTrials: 1,
    channels: [
      { name: 'UPPT001', sensorTypeIndex: 11, coilType: 0, gradOrder: 0 },
      { name: 'BG1-2908', sensorTypeIndex: 0, coilType: 5004, gradOrder: 0 },
      { name: 'MLC11-2904', sensorTypeIndex: 5, coilType: 5004, gradOrder: 3 },
    ],
  })
  const files: Array<{ name: string; bytes: Uint8Array }> = [
    { name: `${stem}.res4`, bytes: res4 },
    { name: `${stem}.hc`, bytes: new TextEncoder().encode(SAMPLE_HC) },
    {
      name: `${stem}.meg4`,
      bytes: new Uint8Array(Array.from({ length: 64 }, (_, i) => i)),
    },
    {
      name: `${stem}.acq`,
      bytes: new TextEncoder().encode('synthetic .acq\n'),
    },
    {
      name: 'BadChannels',
      bytes: new TextEncoder().encode(''),
    },
    {
      name: 'ClassFile.cls',
      bytes: new TextEncoder().encode('synthetic class file\n'),
    },
  ]
  for (const f of files) await writeFile(join(dsPath, f.name), f.bytes)
  return files.map((f) => f.name)
}

// ---------------------------------------------------------------------------

describe('buildEntityStem', () => {
  test('produces sub_task with no session/run/acq', () => {
    expect(buildEntityStem({ subject: '01', task: 'faces' })).toBe(
      'sub-01_task-faces',
    )
  })

  test('inserts ses, acq, run in canonical BIDS order', () => {
    expect(
      buildEntityStem({
        subject: '01',
        session: '02',
        task: 'faces',
        acquisition: 'meg',
        run: '03',
      }),
    ).toBe('sub-01_ses-02_task-faces_acq-meg_run-03')
  })

  test('treats empty strings the same as undefined', () => {
    expect(
      buildEntityStem({
        subject: '01',
        session: '',
        task: 'faces',
        acquisition: '',
        run: '',
      }),
    ).toBe('sub-01_task-faces')
  })
})

describe('runMegImport', () => {
  test('lays down the BIDS layout, copies the .ds, and writes sidecars', async () => {
    const srcRoot = makeTmp('bidsvue-meg-src-')
    const srcPath = join(srcRoot, 'SPM_CTF_synthetic.ds')
    const srcFiles = await writeSyntheticCtfDs(srcPath)
    const destDir = makeTmp('bidsvue-meg-dest-')
    const statePaths = makeStatePaths()

    const result = await runMegImport({
      statePaths,
      srcPath,
      destDir,
      vendor: 'CTF',
      subject: '01',
      task: 'faces',
      run: '01',
      bidsVersion: '1.9.0',
      fs: nodeMutateFs,
    })

    // Output paths.
    expect(result.importedDataPath).toBe(
      join(destDir, 'sub-01', 'meg', 'sub-01_task-faces_run-01_meg.ds'),
    )
    expect(result.sidecarsWritten).toEqual([
      join(destDir, 'sub-01', 'meg', 'sub-01_task-faces_run-01_meg.json'),
      join(
        destDir,
        'sub-01',
        'meg',
        'sub-01_task-faces_run-01_meg_channels.tsv',
      ),
      join(destDir, 'sub-01', 'meg', 'sub-01_coordsystem.json'),
      join(destDir, 'dataset_description.json'),
    ])

    // Imported .ds contents: stem-bearing files renamed; non-stem
    // files kept as-is.
    const dsContents = (await readdir(result.importedDataPath)).sort()
    expect(dsContents).toEqual(
      [
        'BadChannels',
        'ClassFile.cls',
        'sub-01_task-faces_run-01_meg.acq',
        'sub-01_task-faces_run-01_meg.hc',
        'sub-01_task-faces_run-01_meg.meg4',
        'sub-01_task-faces_run-01_meg.res4',
      ].sort(),
    )

    // Raw bytes round-trip byte-for-byte (verify with the .meg4).
    const srcMeg4 = await readFile(join(srcPath, 'SPM_CTF_synthetic.meg4'))
    const dstMeg4 = await readFile(
      join(result.importedDataPath, 'sub-01_task-faces_run-01_meg.meg4'),
    )
    expect(dstMeg4.equals(srcMeg4)).toBe(true)
    expect(result.rawBytesCopied).toBe(
      (
        await Promise.all(
          srcFiles.map((name) =>
            readFile(join(srcPath, name)).then((b) => b.byteLength),
          ),
        )
      ).reduce((a, b) => a + b, 0),
    )

    // Sidecars produce parseable JSON / TSV.
    const megJson = JSON.parse(
      await readFile(result.sidecarsWritten[0], 'utf8'),
    ) as Record<string, unknown>
    expect(megJson.TaskName).toBe('faces')
    expect(megJson.Manufacturer).toBe('CTF')
    expect(megJson.SamplingFrequency).toBe(480)
    expect(megJson.MEGChannelCount).toBe(1)
    expect(megJson.MEGREFChannelCount).toBe(1)
    expect(megJson.TriggerChannelCount).toBe(1)

    const channelsTsv = await readFile(result.sidecarsWritten[1], 'utf8')
    // BOM + header row.
    expect(channelsTsv.charCodeAt(0)).toBe(0xfeff)
    expect(channelsTsv).toContain('name\ttype\tunits')

    const coords = JSON.parse(
      await readFile(result.sidecarsWritten[2], 'utf8'),
    ) as Record<string, unknown>
    expect(coords.MEGCoordinateSystem).toBe('CTF')
    expect(coords.MEGCoordinateUnits).toBe('cm')
    expect(
      (coords.HeadCoilCoordinates as { NAS?: number[] } | undefined)?.NAS,
    ).toEqual([9.83045, 0, 0])

    const desc = JSON.parse(
      await readFile(result.sidecarsWritten[3], 'utf8'),
    ) as Record<string, unknown>
    // Name always equals the destDir basename (the projectName field
    // was retired M10-F).
    expect(desc.Name).toBe(destDir.split('/').pop())
    expect(desc.BIDSVersion).toBe('1.9.0')
    expect(desc.DatasetType).toBe('raw')

    // Operations log: one 'import' entry with the 'created-tree' marker.
    const entries = await readOperationsLog(
      statePaths.operationsLogPath,
      nodeMutateFs,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].opType).toBe('import')
    const createdTree = entries[0].children.find(
      (c) => c.kind === 'created-tree',
    )
    expect(createdTree).toBeDefined()
    expect(createdTree?.target).toBe('') // destDir IS the root
    expect(entries[0].details?.toolId).toBe('ezbids-meg')
    expect(entries[0].details?.vendor).toBe('CTF')
    expect(entries[0].details?.subject).toBe('01')
    expect(entries[0].details?.task).toBe('faces')
  })

  test('writes sub-/ses-/meg/ layout when a session is provided', async () => {
    const srcRoot = makeTmp()
    const srcPath = join(srcRoot, 'src.ds')
    await writeSyntheticCtfDs(srcPath)
    const destDir = makeTmp()
    const statePaths = makeStatePaths()

    const result = await runMegImport({
      statePaths,
      srcPath,
      destDir,
      vendor: 'CTF',
      subject: '01',
      session: '02',
      task: 'rest',
      bidsVersion: '1.9.0',
      fs: nodeMutateFs,
    })
    expect(result.importedDataPath).toBe(
      join(
        destDir,
        'sub-01',
        'ses-02',
        'meg',
        'sub-01_ses-02_task-rest_meg.ds',
      ),
    )
    // _coordsystem.json gets the session in its basename.
    expect(result.sidecarsWritten[2]).toBe(
      join(
        destDir,
        'sub-01',
        'ses-02',
        'meg',
        'sub-01_ses-02_coordsystem.json',
      ),
    )
  })

  test('writes AssociatedEmptyRoom when provided', async () => {
    const srcRoot = makeTmp()
    const srcPath = join(srcRoot, 'src.ds')
    await writeSyntheticCtfDs(srcPath)
    const destDir = makeTmp()
    const statePaths = makeStatePaths()

    const result = await runMegImport({
      statePaths,
      srcPath,
      destDir,
      vendor: 'CTF',
      subject: '01',
      task: 'faces',
      associatedEmptyRoom:
        'sub-emptyroom/ses-20081124/meg/sub-emptyroom_ses-20081124_task-noise_meg.ds',
      bidsVersion: '1.9.0',
      fs: nodeMutateFs,
    })

    const json = JSON.parse(
      await readFile(result.sidecarsWritten[0], 'utf8'),
    ) as Record<string, unknown>
    expect(json.AssociatedEmptyRoom).toBe(
      'sub-emptyroom/ses-20081124/meg/sub-emptyroom_ses-20081124_task-noise_meg.ds',
    )
  })

  test('rejects a source with no recognised MEG suffix', async () => {
    const srcPath = makeTmp('bidsvue-meg-src-')
    const destDir = makeTmp()
    const statePaths = makeStatePaths()
    await expect(
      runMegImport({
        statePaths,
        srcPath, // makeTmp returns a plain dir, no .ds / .fif suffix
        destDir,
        subject: '01',
        task: 'faces',
        bidsVersion: '1.9.0',
        fs: nodeMutateFs,
      }),
    ).rejects.toThrow(/cannot determine MEG vendor/)
  })

  test('refuses a non-.ds srcPath for CTF', async () => {
    const srcPath = makeTmp('bidsvue-meg-src-')
    const destDir = makeTmp()
    const statePaths = makeStatePaths()
    await expect(
      runMegImport({
        statePaths,
        srcPath,
        destDir,
        vendor: 'CTF',
        subject: '01',
        task: 'faces',
        bidsVersion: '1.9.0',
        fs: nodeMutateFs,
      }),
    ).rejects.toThrow(/\.ds directory/)
  })

  test('refuses a non-empty destDir', async () => {
    const srcRoot = makeTmp()
    const srcPath = join(srcRoot, 'src.ds')
    await writeSyntheticCtfDs(srcPath)
    const destDir = makeTmp()
    await writeFile(join(destDir, 'existing.txt'), 'hi')
    const statePaths = makeStatePaths()
    await expect(
      runMegImport({
        statePaths,
        srcPath,
        destDir,
        vendor: 'CTF',
        subject: '01',
        task: 'faces',
        bidsVersion: '1.9.0',
        fs: nodeMutateFs,
      }),
    ).rejects.toThrow(/non-empty/)
  })

  test('rejects an invalid BIDS subject label (catches flag-injection vectors)', async () => {
    const srcRoot = makeTmp()
    const srcPath = join(srcRoot, 'src.ds')
    await writeSyntheticCtfDs(srcPath)
    const destDir = makeTmp()
    const statePaths = makeStatePaths()
    await expect(
      runMegImport({
        statePaths,
        srcPath,
        destDir,
        vendor: 'CTF',
        subject: 'has-dash',
        task: 'faces',
        bidsVersion: '1.9.0',
        fs: nodeMutateFs,
      }),
    ).rejects.toThrow(/\[a-zA-Z0-9\]\+/)
  })

  test('rejects a srcPath starting with "-" (flag-injection mitigation)', async () => {
    // We don't shell out, but the validator is defence-in-depth so
    // a future refactor that does shell out doesn't have to chase
    // it back down.
    const destDir = makeTmp()
    const statePaths = makeStatePaths()
    await expect(
      runMegImport({
        statePaths,
        srcPath: '-some.ds',
        destDir,
        vendor: 'CTF',
        subject: '01',
        task: 'faces',
        bidsVersion: '1.9.0',
        fs: nodeMutateFs,
      }),
    ).rejects.toThrow(/must not start with "-"/)
  })
})

// ---------------------------------------------------------------------------
// FIF (Elekta) path -- M10-C.
// ---------------------------------------------------------------------------

/**
 * Minimal synthetic FIF buffer with sfreq + nchan + one MEG channel +
 * one stim channel + dig points for NAS / LPA / RPA + a FIRST/LAST
 * sample pair. Mirrors the layout `parseFif` expects; reuses the
 * tag-emission style from `formats/fif/header.test.ts`.
 */
function buildMinimalFif(): Uint8Array {
  const i32 = (v: number): Uint8Array => {
    const a = new Uint8Array(4)
    new DataView(a.buffer).setInt32(0, v, false)
    return a
  }
  const u32 = (v: number): Uint8Array => {
    const a = new Uint8Array(4)
    new DataView(a.buffer).setUint32(0, v, false)
    return a
  }
  const f32 = (v: number): Uint8Array => {
    const a = new Uint8Array(4)
    new DataView(a.buffer).setFloat32(0, v, false)
    return a
  }
  const chunks: Uint8Array[] = []
  const tag = (
    kind: number,
    type: number,
    payload: Uint8Array,
    last = false,
  ): void => {
    chunks.push(i32(kind))
    chunks.push(u32(type))
    chunks.push(i32(payload.byteLength))
    chunks.push(i32(last ? -1 : 0))
    chunks.push(payload)
  }
  // NCHAN = 2.
  tag(200, 3, i32(2))
  // SFREQ = 1000.
  tag(201, 4, f32(1000))
  // CH_INFO #1: MEG magnetometer (kind=1, coil=3022, unit=107 = T).
  {
    const p = new Uint8Array(96)
    const v = new DataView(p.buffer)
    v.setInt32(0, 1, false) // scanno
    v.setInt32(4, 1, false) // logno
    v.setInt32(8, 1, false) // kind = MEG
    v.setFloat32(12, 1, false) // range
    v.setFloat32(16, 1, false) // cal
    v.setInt32(20, 3022, false) // coil_type
    v.setInt32(72, 107, false) // unit = T
    p.set(new TextEncoder().encode('MEG0111'), 80)
    tag(203, 30, p)
  }
  // CH_INFO #2: stim (kind=3, unit=112 = V).
  {
    const p = new Uint8Array(96)
    const v = new DataView(p.buffer)
    v.setInt32(0, 2, false)
    v.setInt32(4, 2, false)
    v.setInt32(8, 3, false) // STIM
    v.setFloat32(12, 1, false)
    v.setFloat32(16, 1, false)
    v.setInt32(20, 0, false)
    v.setInt32(72, 112, false) // V
    p.set(new TextEncoder().encode('STI 001'), 80)
    tag(203, 30, p)
  }
  // DIG points: NAS / LPA / RPA, kind=CARDINAL (1).
  const dig = (kind: number, ident: number, r: [number, number, number]) => {
    const p = new Uint8Array(20)
    const v = new DataView(p.buffer)
    v.setInt32(0, kind, false)
    v.setInt32(4, ident, false)
    v.setFloat32(8, r[0], false)
    v.setFloat32(12, r[1], false)
    v.setFloat32(16, r[2], false)
    tag(213, 33, p)
  }
  dig(1, 1, [-0.08, 0, 0]) // LPA
  dig(1, 2, [0, 0.1, 0]) // NAS
  dig(1, 3, [0.08, 0, 0]) // RPA
  // FIRST_SAMPLE = 0
  tag(208, 3, i32(0))
  // LAST_SAMPLE = 9999 (10000 samples / 1000 Hz = 10 s); terminator.
  tag(209, 3, i32(9999), true)

  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

describe('runMegImport (FIF path)', () => {
  test('auto-detects vendor from the .fif suffix and writes the BIDS layout', async () => {
    const srcRoot = makeTmp('bidsvue-meg-src-')
    const srcPath = join(srcRoot, 'sample_raw.fif')
    await writeFile(srcPath, buildMinimalFif())
    const destDir = makeTmp('bidsvue-meg-dest-')
    const statePaths = makeStatePaths()

    const result = await runMegImport({
      statePaths,
      srcPath,
      destDir,
      // vendor omitted -- auto-detect from suffix
      subject: '01',
      session: '02',
      task: 'rest',
      run: '01',
      bidsVersion: '1.9.0',
      fs: nodeMutateFs,
    })

    expect(result.vendor).toBe('Elekta')
    expect(result.importedDataPath).toBe(
      join(
        destDir,
        'sub-01',
        'ses-02',
        'meg',
        'sub-01_ses-02_task-rest_run-01_meg.fif',
      ),
    )
    // FIF single-file copy is byte-identical.
    const srcBytes = await readFile(srcPath)
    const dstBytes = await readFile(result.importedDataPath)
    expect(dstBytes.equals(srcBytes)).toBe(true)

    // _meg.json with the FIF-derived field values.
    const sidecar = JSON.parse(
      await readFile(result.sidecarsWritten[0], 'utf8'),
    ) as Record<string, unknown>
    expect(sidecar.TaskName).toBe('rest')
    expect(sidecar.Manufacturer).toBe('Elekta')
    expect(sidecar.SamplingFrequency).toBe(1000)
    // FIRST_SAMPLE=0, LAST_SAMPLE=9999 -> 10000 / 1000 = 10s.
    expect(sidecar.RecordingDuration).toBe(10)
    expect(sidecar.RecordingType).toBe('continuous')
    expect(sidecar.MEGChannelCount).toBe(1)
    expect(sidecar.TriggerChannelCount).toBe(1)
    expect(sidecar.DigitizedLandmarks).toBe(true)

    // _coordsystem.json picks up the dig-point cardinals in METERS.
    const coordPath = result.sidecarsWritten.find((p) =>
      p.endsWith('_coordsystem.json'),
    )
    expect(coordPath).toBeDefined()
    if (coordPath === undefined) return
    const coords = JSON.parse(await readFile(coordPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(coords.MEGCoordinateSystem).toBe('ElektaNeuromag')
    expect(coords.MEGCoordinateUnits).toBe('m')
    const nas = (coords.HeadCoilCoordinates as { NAS?: number[] } | undefined)
      ?.NAS
    expect(nas?.[1]).toBeCloseTo(0.1, 5)

    // Operations log: one 'import' entry, vendor=Elekta.
    const entries = await readOperationsLog(
      statePaths.operationsLogPath,
      nodeMutateFs,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].opType).toBe('import')
    expect(entries[0].details?.vendor).toBe('Elekta')
    expect(entries[0].details?.toolId).toBe('ezbids-meg')
  })

  test('refuses a non-.fif srcPath when vendor=Elekta is explicit', async () => {
    const srcRoot = makeTmp('bidsvue-meg-src-')
    const srcPath = join(srcRoot, 'not-a-fif.dat')
    await writeFile(srcPath, new Uint8Array([0, 0]))
    const destDir = makeTmp()
    const statePaths = makeStatePaths()
    await expect(
      runMegImport({
        statePaths,
        srcPath,
        destDir,
        vendor: 'Elekta',
        subject: '01',
        task: 'rest',
        bidsVersion: '1.9.0',
        fs: nodeMutateFs,
      }),
    ).rejects.toThrow(/\.fif file/)
  })
})

// ---------------------------------------------------------------------------
// KIT (Yokogawa / Ricoh) path -- M10-D.
// ---------------------------------------------------------------------------

/**
 * Minimal synthetic KIT `.con` buffer for orchestrator tests. The
 * full directory-of-directories layout (30 entries, 16 bytes each)
 * goes at offset 0; only SYSTEM (1), CHANNELS (4), ACQ_COND (8),
 * and DIG_POINTS (26) point to populated sub-blocks. Mirrors the
 * `buildKit` helper in `formats/kit/header.test.ts` but trimmed to
 * the minimum the orchestrator needs.
 */
function buildMinimalKitCon(): Uint8Array {
  const DIR_COUNT = 30
  const DIR_TABLE = DIR_COUNT * 16

  // SYSTEM: version(i32) + revision(i32) + sysId(i32) + name(128) + model(128) + nchan(i32) = 272 bytes.
  // (12 i32s = 12, + 128 + 128 + 4 = 272.)
  const sys = new Uint8Array(272)
  {
    const v = new DataView(sys.buffer)
    v.setInt32(0, 2, true) // version
    v.setInt32(4, 3, true) // revision
    v.setInt32(8, 53, true) // sysId
    sys.set(new TextEncoder().encode('TEST-KIT'), 12)
    // nchan = 2; offset 12 (i32s) + 128 (systemName) + 128 (modelName) = 268.
    v.setInt32(268, 2, true)
  }

  // ACQ_COND: 28 bytes (max-shape covers continuous + epoched).
  const acq = new Uint8Array(28)
  {
    const v = new DataView(acq.buffer)
    v.setInt32(0, 1, true) // continuous
    v.setFloat64(4, 1000, true) // sfreq
    v.setInt32(12, 0, true) // pad
    v.setInt32(16, 5000, true) // nSamples
  }

  // CHANNELS: two channels (AXIAL_GRADIOMETER + TRIGGER), 96 bytes each.
  const RECORD = 96
  const chan = new Uint8Array(RECORD * 2)
  {
    const v0 = new DataView(chan.buffer, 0, RECORD)
    v0.setInt32(0, 2, true) // AXIAL_GRADIOMETER
    chan.set(new TextEncoder().encode('AG001'), 60) // name at offset 60, NCHAR=6
    const v1 = new DataView(chan.buffer, RECORD, RECORD)
    v1.setInt32(0, -1, true) // TRIGGER
    chan.set(new TextEncoder().encode('STI 001'), RECORD + 12) // name at offset +12, NCHAR=32
  }

  // DIG_POINTS: NAS / LPA / RPA, 32 bytes each.
  const DIG = 32
  const dig = new Uint8Array(DIG * 3)
  {
    const writePoint = (
      i: number,
      name: string,
      r: [number, number, number],
    ): void => {
      dig.set(new TextEncoder().encode(name), i * DIG)
      const v = new DataView(dig.buffer, i * DIG + 8, 24)
      v.setFloat64(0, r[0], true)
      v.setFloat64(8, r[1], true)
      v.setFloat64(16, r[2], true)
    }
    writePoint(0, 'fidnz', [0, 0.1, 0])
    writePoint(1, 'fidt9', [-0.08, 0, 0])
    writePoint(2, 'fidt10', [0.08, 0, 0])
  }

  const totalSize =
    DIR_TABLE +
    sys.byteLength +
    chan.byteLength +
    acq.byteLength +
    dig.byteLength
  const out = new Uint8Array(totalSize)
  const view = new DataView(out.buffer)

  // dirs[0]: self-describing.
  view.setUint32(0, 0, true)
  view.setInt32(4, 16, true) // size
  view.setInt32(8, DIR_COUNT, true) // max_count
  view.setInt32(12, DIR_COUNT, true) // count

  // Zero-fill other dirs (already zero-initialised), then write the ones we need.
  const writeDir = (
    idx: number,
    offset: number,
    size: number,
    count: number,
  ): void => {
    const base = idx * 16
    view.setUint32(base, offset, true)
    view.setInt32(base + 4, size, true)
    view.setInt32(base + 8, count, true) // max_count
    view.setInt32(base + 12, count, true) // count
  }

  let cursor = DIR_TABLE
  out.set(sys, cursor)
  writeDir(1, cursor, sys.byteLength, 1) // SYSTEM
  cursor += sys.byteLength
  out.set(chan, cursor)
  writeDir(4, cursor, RECORD, 2) // CHANNELS (size = per-record, count = nchan)
  cursor += chan.byteLength
  out.set(acq, cursor)
  writeDir(8, cursor, acq.byteLength, 1) // ACQ_COND
  cursor += acq.byteLength
  out.set(dig, cursor)
  writeDir(26, cursor, DIG, 3) // DIG_POINTS

  return out
}

describe('runMegImport (KIT path)', () => {
  test('auto-detects vendor from the .con suffix and writes BIDS layout', async () => {
    const srcRoot = makeTmp('bidsvue-meg-src-')
    const srcPath = join(srcRoot, 'data.con')
    await writeFile(srcPath, buildMinimalKitCon())
    const destDir = makeTmp('bidsvue-meg-dest-')
    const statePaths = makeStatePaths()

    const result = await runMegImport({
      statePaths,
      srcPath,
      destDir,
      // vendor omitted -- detected from .con suffix
      subject: '01',
      task: 'rest',
      run: '01',
      bidsVersion: '1.9.0',
      fs: nodeMutateFs,
    })

    expect(result.vendor).toBe('KIT')
    expect(result.importedDataPath).toBe(
      join(destDir, 'sub-01', 'meg', 'sub-01_task-rest_run-01_meg.con'),
    )
    // Byte-identical passthrough.
    const srcBytes = await readFile(srcPath)
    const dstBytes = await readFile(result.importedDataPath)
    expect(dstBytes.equals(srcBytes)).toBe(true)

    // _meg.json picks up the KIT-derived values.
    const sidecar = JSON.parse(
      await readFile(result.sidecarsWritten[0], 'utf8'),
    ) as Record<string, unknown>
    expect(sidecar.TaskName).toBe('rest')
    expect(sidecar.Manufacturer).toBe('KIT/Yokogawa')
    expect(sidecar.SamplingFrequency).toBe(1000)
    expect(sidecar.RecordingDuration).toBe(5) // 5000 / 1000
    expect(sidecar.MEGChannelCount).toBe(1)
    expect(sidecar.TriggerChannelCount).toBe(1)
    expect(sidecar.DigitizedLandmarks).toBe(true)

    // _coordsystem.json comes from the in-file DIG_POINTS block.
    const coordPath = result.sidecarsWritten.find((p) =>
      p.endsWith('_coordsystem.json'),
    )
    expect(coordPath).toBeDefined()
    if (coordPath === undefined) return
    const coords = JSON.parse(await readFile(coordPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(coords.MEGCoordinateSystem).toBe('KIT/Yokogawa')
    expect(coords.MEGCoordinateUnits).toBe('m')
    const nas = (coords.HeadCoilCoordinates as { NAS?: number[] } | undefined)
      ?.NAS
    expect(nas?.[1]).toBeCloseTo(0.1, 5)

    // Operations log records the vendor.
    const entries = await readOperationsLog(
      statePaths.operationsLogPath,
      nodeMutateFs,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].details?.vendor).toBe('KIT')
  })

  test('accepts .sqd as well as .con, preserves the extension on output', async () => {
    const srcRoot = makeTmp()
    const srcPath = join(srcRoot, 'legacy.sqd')
    await writeFile(srcPath, buildMinimalKitCon())
    const destDir = makeTmp()
    const statePaths = makeStatePaths()
    const result = await runMegImport({
      statePaths,
      srcPath,
      destDir,
      subject: '01',
      task: 'rest',
      bidsVersion: '1.9.0',
      fs: nodeMutateFs,
    })
    expect(result.vendor).toBe('KIT')
    expect(result.importedDataPath.endsWith('.sqd')).toBe(true)
  })

  test('refuses a non-KIT srcPath when vendor=KIT is explicit', async () => {
    const srcRoot = makeTmp('bidsvue-meg-src-')
    const srcPath = join(srcRoot, 'not-a-kit.dat')
    await writeFile(srcPath, new Uint8Array([0, 0]))
    const destDir = makeTmp()
    const statePaths = makeStatePaths()
    await expect(
      runMegImport({
        statePaths,
        srcPath,
        destDir,
        vendor: 'KIT',
        subject: '01',
        task: 'rest',
        bidsVersion: '1.9.0',
        fs: nodeMutateFs,
      }),
    ).rejects.toThrow(/\.con or \.sqd/)
  })
})

// ---------------------------------------------------------------------------
// BTi / 4D Neuroimaging path -- M10-E.
// ---------------------------------------------------------------------------

/**
 * Build a minimal synthetic BTi config-file (big-endian) carrying
 * a `supply_freq` of 60 Hz, `total_chans` of 3, and the site name
 * "TestSite". Only the fixed prefix is meaningful -- the rest of
 * the file is zero-padded.
 */
function buildMinimalBtiConfig(): Uint8Array {
  const out = new Uint8Array(200)
  const v = new DataView(out.buffer)
  v.setInt16(0, 1, false) // version
  // site_name @ 2 (32 bytes)
  out.set(new TextEncoder().encode('TestSite'), 2)
  // dap_hostname @ 34 (16 bytes) - leave zero
  v.setInt16(50, 7, false) // sys_type
  v.setInt32(52, 0, false) // sys_options
  v.setInt16(56, 60, false) // supply_freq = 60 Hz
  v.setInt16(58, 3, false) // total_chans = 3
  v.setFloat32(60, 1.0, false) // system_fixed_gain
  v.setFloat32(64, 1.0, false) // volts_per_bit
  v.setInt16(68, 3, false) // total_sensors
  v.setInt16(70, 0, false) // total_user_blocks (none — we don't walk them)
  return out
}

/**
 * Build a minimal synthetic BTi PDF data file (`c,rfDC`). Layout:
 *   1. Zero-padded "sample payload" (24 bytes -- ignored by parser).
 *   2. Header struct starting at offset 24 (aligned to 8).
 *   3. Epoch record (56 bytes).
 *   4. 3 channel records (102 bytes each).
 *   5. Trailer: 8 bytes ending with i64 BE = 24 (header_position).
 */
function buildMinimalBtiPdf(): Uint8Array {
  // Sample payload region.
  const samplePayload = new Uint8Array(24)
  // Header struct (size: 2 + 5 + 1 + 2 + 2 + 4 + 4 + 4 + 4 + 4 + 16 + 4 + 2 + 2 + 4 + 4 + 2 + 2 + 4 + 20 = 90 bytes, +6 align = 96).
  const head = new Uint8Array(96)
  const hv = new DataView(head.buffer)
  hv.setInt16(0, 1, false) // version
  // file_type[5] @ 2 - leave zero
  // padding @ 7 (1 byte)
  hv.setInt16(8, 3, false) // data_format = 3 (float32)
  hv.setInt16(10, 0, false) // acq_mode
  hv.setInt32(12, 1, false) // total_epochs = 1
  hv.setInt32(16, 0, false) // input_epochs
  hv.setInt32(20, 0, false) // total_events
  hv.setInt32(24, 0, false) // total_fixed_events
  hv.setFloat32(28, 1 / 678.17, false) // sample_period -> sfreq = 678.17
  // xaxis_label[16] @ 32 - leave zero
  hv.setInt32(48, 0, false) // total_processes
  hv.setInt16(52, 3, false) // total_chans = 3
  // alignment @ 54 (2 bytes)
  hv.setInt32(56, 0, false) // checksum
  hv.setInt32(60, 0, false) // total_ed_classes
  hv.setInt16(64, 0, false) // total_associated_files
  hv.setInt16(66, 0, false) // last_file_index
  hv.setInt32(68, 1_700_000_000, false) // timestamp (UNIX seconds, mid-2023)
  // reserved[20] @ 72
  // Padding to 8-byte align (head len 90 -> 96 with 6 zero bytes).

  // Epoch record: pts_in_epoch=10000, then 52 zeros.
  const epoch = new Uint8Array(56)
  new DataView(epoch.buffer).setInt32(0, 10000, false)

  // Channel records: 102 bytes each. First 16 = name.
  const mkChannel = (name: string): Uint8Array => {
    const buf = new Uint8Array(102)
    buf.set(new TextEncoder().encode(name), 0)
    return buf
  }
  const ch1 = mkChannel('A1')
  const ch2 = mkChannel('A2')
  const ch3 = mkChannel('TRIGGER')

  // Trailer (last 8 bytes): i64 BE pointing to header start (offset 24).
  const trailer = new Uint8Array(8)
  new DataView(trailer.buffer).setBigUint64(0, BigInt(24), false)

  const total =
    samplePayload.byteLength +
    head.byteLength +
    epoch.byteLength +
    ch1.byteLength +
    ch2.byteLength +
    ch3.byteLength +
    trailer.byteLength
  const out = new Uint8Array(total)
  let off = 0
  for (const chunk of [samplePayload, head, epoch, ch1, ch2, ch3, trailer]) {
    out.set(chunk, off)
    off += chunk.byteLength
  }
  return out
}

/**
 * Build a minimal synthetic `hs_file` with cardinal landmarks (LPA
 * first, then RPA, then NAS, per MNE's ordering). Units METERS.
 */
function buildMinimalBtiHsFile(): Uint8Array {
  const out = new Uint8Array(12 + 4 + 5 * 3 * 8)
  const v = new DataView(out.buffer)
  // version / timestamp / checksum stay zero (offsets 0/4/8)
  v.setInt32(12, 0, false) // n_dig_points = 0 (no head-shape, just landmarks)
  // idx_points: 5 points (LPA, RPA, NAS, HPI1, HPI2), each 3 doubles
  // BTi/4D ordering: LPA, RPA, NAS, HPI1, HPI2 per
  // mne/io/bti/bti.py::_read_head_shape.
  let off = 16
  for (const [x, y, z] of [
    [-0.075, 0, 0], // LPA
    [0.075, 0, 0], // RPA
    [0, 0.095, 0], // NAS
    [0, 0, 0], // HPI1 (zero)
    [0, 0, 0], // HPI2 (zero)
  ]) {
    v.setFloat64(off, x, false)
    v.setFloat64(off + 8, y, false)
    v.setFloat64(off + 16, z, false)
    off += 24
  }
  return out
}

describe('runMegImport (BTi path)', () => {
  test('auto-detects vendor by directory contents and writes BIDS layout', async () => {
    const srcPath = makeTmp('bidsvue-meg-src-')
    await writeFile(join(srcPath, 'config'), buildMinimalBtiConfig())
    await writeFile(join(srcPath, 'c,rfDC'), buildMinimalBtiPdf())
    await writeFile(join(srcPath, 'hs_file'), buildMinimalBtiHsFile())
    const destDir = makeTmp('bidsvue-meg-dest-')
    const statePaths = makeStatePaths()

    const result = await runMegImport({
      statePaths,
      srcPath,
      destDir,
      // vendor omitted -- detected from directory contents
      subject: '01',
      task: 'rest',
      bidsVersion: '1.9.0',
      digitizedLandmarks: true,
      fs: nodeMutateFs,
    })

    expect(result.vendor).toBe('BTi')
    expect(result.importedDataPath).toBe(
      join(destDir, 'sub-01', 'meg', 'sub-01_task-rest_meg'),
    )

    // All three source files copied verbatim (no renaming) inside
    // the `<entityStem>_meg/` directory.
    const copied = await readdir(result.importedDataPath)
    expect(copied.sort()).toEqual(['c,rfDC', 'config', 'hs_file'])

    // _meg.json picks up the BTi-derived values.
    const sidecar = JSON.parse(
      await readFile(result.sidecarsWritten[0], 'utf8'),
    ) as Record<string, unknown>
    expect(sidecar.TaskName).toBe('rest')
    expect(sidecar.Manufacturer).toBe('4D/BTi')
    expect(sidecar.PowerLineFrequency).toBe(60) // from config supply_freq
    expect(typeof sidecar.SamplingFrequency).toBe('number')
    expect(sidecar.SamplingFrequency).toBeCloseTo(678.17, 1)
    expect(sidecar.RecordingDuration).toBeCloseTo(10000 / 678.17, 2)
    expect(sidecar.MEGChannelCount).toBe(2) // A1 + A2
    expect(sidecar.TriggerChannelCount).toBe(1) // TRIGGER
    expect(sidecar.InstitutionName).toBe('TestSite')
    expect(sidecar.DigitizedLandmarks).toBe(true)

    // _coordsystem.json picks up the hs_file landmarks.
    const coordPath = result.sidecarsWritten.find((p) =>
      p.endsWith('_coordsystem.json'),
    )
    expect(coordPath).toBeDefined()
    if (coordPath === undefined) return
    const coords = JSON.parse(await readFile(coordPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(coords.MEGCoordinateSystem).toBe('Other')
    expect(coords.MEGCoordinateUnits).toBe('m')
    const nas = (coords.HeadCoilCoordinates as { NAS?: number[] } | undefined)
      ?.NAS
    expect(nas?.[1]).toBeCloseTo(0.095, 5)
    const lpa = (coords.HeadCoilCoordinates as { LPA?: number[] } | undefined)
      ?.LPA
    expect(lpa?.[0]).toBeCloseTo(-0.075, 5)

    // Operations log records the vendor.
    const entries = await readOperationsLog(
      statePaths.operationsLogPath,
      nodeMutateFs,
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].details?.vendor).toBe('BTi')
  })

  test('accepts an explicit vendor=BTi when the directory has the right shape', async () => {
    const srcPath = makeTmp()
    await writeFile(join(srcPath, 'config'), buildMinimalBtiConfig())
    await writeFile(join(srcPath, 'c,rfDC'), buildMinimalBtiPdf())
    const destDir = makeTmp()
    const statePaths = makeStatePaths()
    const result = await runMegImport({
      statePaths,
      srcPath,
      destDir,
      vendor: 'BTi',
      subject: '01',
      task: 'rest',
      bidsVersion: '1.9.0',
      fs: nodeMutateFs,
    })
    expect(result.vendor).toBe('BTi')
    expect(result.importedDataPath.endsWith('_meg')).toBe(true)
  })

  test('refuses a directory missing `config` or `c,*` when vendor=BTi is explicit', async () => {
    const srcPath = makeTmp()
    // Has config but no c,* data file.
    await writeFile(join(srcPath, 'config'), buildMinimalBtiConfig())
    await writeFile(join(srcPath, 'README'), 'no data')
    const destDir = makeTmp()
    const statePaths = makeStatePaths()
    await expect(
      runMegImport({
        statePaths,
        srcPath,
        destDir,
        vendor: 'BTi',
        subject: '01',
        task: 'rest',
        bidsVersion: '1.9.0',
        fs: nodeMutateFs,
      }),
    ).rejects.toThrow(/must be a directory containing "config"/)
  })

  test('emits RecordingType "epoched" when the PDF carries multiple epochs (round-10 audit M4)', async () => {
    // Patch the canned PDF buffer to set total_epochs=3, then append
    // two more 56-byte epoch records and bump the trailer pointer
    // accordingly. The canned helper produces a 1-epoch fixture; the
    // simplest way to test epoched is to build a fresh buffer with
    // total_epochs=3 (the test asserts the recordingType discriminant
    // flows through to _meg.json).
    const samplePayload = new Uint8Array(24)
    const head = new Uint8Array(96)
    const hv = new DataView(head.buffer)
    hv.setInt16(0, 1, false)
    hv.setInt16(8, 3, false)
    hv.setInt16(10, 0, false)
    hv.setInt32(12, 3, false) // total_epochs = 3 -> epoched
    hv.setInt32(16, 0, false)
    hv.setInt32(20, 0, false)
    hv.setInt32(24, 0, false)
    hv.setFloat32(28, 1 / 678.17, false)
    hv.setInt32(48, 0, false)
    hv.setInt16(52, 3, false)
    hv.setInt32(56, 0, false)
    hv.setInt32(60, 0, false)
    hv.setInt16(64, 0, false)
    hv.setInt16(66, 0, false)
    hv.setInt32(68, 1_700_000_000, false)

    // Three epoch records, each 56 bytes, with pts_in_epoch=4000.
    const epochs = new Uint8Array(3 * 56)
    for (let i = 0; i < 3; i++) {
      new DataView(epochs.buffer).setInt32(i * 56, 4000, false)
    }

    const mkChannel = (name: string): Uint8Array => {
      const buf = new Uint8Array(102)
      buf.set(new TextEncoder().encode(name), 0)
      return buf
    }
    const ch1 = mkChannel('A1')
    const ch2 = mkChannel('A2')
    const ch3 = mkChannel('TRIGGER')

    const trailer = new Uint8Array(8)
    new DataView(trailer.buffer).setBigUint64(0, BigInt(24), false)

    const total =
      samplePayload.byteLength +
      head.byteLength +
      epochs.byteLength +
      ch1.byteLength +
      ch2.byteLength +
      ch3.byteLength +
      trailer.byteLength
    const epochedPdf = new Uint8Array(total)
    let off = 0
    for (const c of [samplePayload, head, epochs, ch1, ch2, ch3, trailer]) {
      epochedPdf.set(c, off)
      off += c.byteLength
    }

    const srcPath = makeTmp()
    await writeFile(join(srcPath, 'config'), buildMinimalBtiConfig())
    await writeFile(join(srcPath, 'c,rfDC'), epochedPdf)
    const destDir = makeTmp()
    const statePaths = makeStatePaths()
    const result = await runMegImport({
      statePaths,
      srcPath,
      destDir,
      subject: '01',
      task: 'rest',
      bidsVersion: '1.9.0',
      fs: nodeMutateFs,
    })
    const sidecar = JSON.parse(
      await readFile(result.sidecarsWritten[0], 'utf8'),
    ) as Record<string, unknown>
    expect(sidecar.RecordingType).toBe('epoched')
    // RecordingDuration = totalSlices(3*4000=12000) / sfreq(678.17) ~= 17.7 s
    expect(sidecar.RecordingDuration).toBeCloseTo(12000 / 678.17, 2)
  })

  test('rejects a corrupt PDF whose trailer points to byte 0 (round-10 security audit low)', async () => {
    const samplePayload = new Uint8Array(24)
    const head = new Uint8Array(96)
    // No header values written -- we don't care, the trailer pointer
    // check fires before any header read.
    const trailer = new Uint8Array(8)
    // Trailer points to 0 (byte 0 of file = inside sample payload).
    new DataView(trailer.buffer).setBigUint64(0, BigInt(0), false)
    const total =
      samplePayload.byteLength + head.byteLength + trailer.byteLength
    const corrupt = new Uint8Array(total)
    corrupt.set(samplePayload, 0)
    corrupt.set(head, samplePayload.byteLength)
    corrupt.set(trailer, samplePayload.byteLength + head.byteLength)

    const srcPath = makeTmp()
    await writeFile(join(srcPath, 'config'), buildMinimalBtiConfig())
    await writeFile(join(srcPath, 'c,rfDC'), corrupt)
    // destDir must NOT pre-exist for the cleanup path to fire; use a
    // child of a fresh tmp dir so runMegImport creates it itself.
    const destParent = makeTmp()
    const destDir = join(destParent, 'fresh')
    const statePaths = makeStatePaths()
    await expect(
      runMegImport({
        statePaths,
        srcPath,
        destDir,
        subject: '01',
        task: 'rest',
        bidsVersion: '1.9.0',
        fs: nodeMutateFs,
      }),
    ).rejects.toThrow(/below plausible minimum/)
    // destDir cleanup from the parse-failure path also exercised.
    expect(existsSync(destDir)).toBe(false)
  })

  test('hs_file with degenerate landmarks suppresses the coordsystem sidecar', async () => {
    const srcPath = makeTmp()
    await writeFile(join(srcPath, 'config'), buildMinimalBtiConfig())
    await writeFile(join(srcPath, 'c,rfDC'), buildMinimalBtiPdf())
    // hs_file with all-zero landmarks (LPA == RPA == NAS == origin).
    // parseBtiHeadShape itself accepts the values (they're within
    // the +/- 0.5m bound); buildCoordinates emits them. Just make
    // sure the wizard's explicit `digitizedLandmarks: false` opt-out
    // suppresses the sidecar even when an hs_file is present.
    await writeFile(join(srcPath, 'hs_file'), buildMinimalBtiHsFile())
    const destDir = makeTmp()
    const statePaths = makeStatePaths()
    const result = await runMegImport({
      statePaths,
      srcPath,
      destDir,
      subject: '01',
      task: 'rest',
      digitizedLandmarks: false,
      bidsVersion: '1.9.0',
      fs: nodeMutateFs,
    })
    const hasCoordsystem = result.sidecarsWritten.some((p) =>
      p.endsWith('_coordsystem.json'),
    )
    expect(hasCoordsystem).toBe(false)
  })
})
