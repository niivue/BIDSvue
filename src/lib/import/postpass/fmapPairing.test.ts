import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { nodeFsPostPassAdapter } from './__testFs'
import {
  b0Identifier,
  findFmapGroups,
  planB0FieldEdits,
  stripFmapSuffix,
} from './fmapPairing'
import { buildSyntheticNiftiHeader } from './niftiHeader'

describe('stripFmapSuffix', () => {
  test('strips _dir-XX for EPI pairs', () => {
    expect(stripFmapSuffix('sub-01_dir-AP_epi')).toBe('sub-01_epi')
    expect(stripFmapSuffix('sub-01_dir-PA_epi')).toBe('sub-01_epi')
  })

  test('strips _magnitude1 / _phasediff for SE pairs', () => {
    expect(stripFmapSuffix('sub-01_magnitude1')).toBe('sub-01')
    expect(stripFmapSuffix('sub-01_magnitude2')).toBe('sub-01')
    expect(stripFmapSuffix('sub-01_phasediff')).toBe('sub-01')
  })

  test('leaves non-fmap names alone', () => {
    expect(stripFmapSuffix('sub-01_task-rest_bold')).toBe(
      'sub-01_task-rest_bold',
    )
  })
})

describe('findFmapGroups', () => {
  test('groups magnitude1/2 + phasediff under one prefix', () => {
    const g = findFmapGroups([
      'sub-01_magnitude1',
      'sub-01_magnitude2',
      'sub-01_phasediff',
    ])
    expect(g.size).toBe(1)
    expect([...g.keys()][0]).toBe('sub-01')
    expect([...g.values()][0]).toEqual([
      'sub-01_magnitude1',
      'sub-01_magnitude2',
      'sub-01_phasediff',
    ])
  })

  test('AP + PA epi land in the same group', () => {
    const g = findFmapGroups(['sub-01_dir-AP_epi', 'sub-01_dir-PA_epi'])
    expect(g.size).toBe(1)
    expect([...g.values()][0]).toEqual([
      'sub-01_dir-AP_epi',
      'sub-01_dir-PA_epi',
    ])
  })

  test('two distinct group prefixes (epi + phasediff) stay separate', () => {
    const g = findFmapGroups([
      'sub-01_dir-AP_epi',
      'sub-01_dir-PA_epi',
      'sub-01_magnitude1',
      'sub-01_phasediff',
    ])
    expect(g.size).toBe(2)
  })
})

describe('b0Identifier', () => {
  test('strips leading sub- and ses- entities', () => {
    expect(b0Identifier('sub-01_ses-baseline_dir-AP_epi')).toBe('dir-AP_epi')
    expect(b0Identifier('sub-01_phasediff')).toBe('phasediff')
  })

  test('falls back to raw prefix when stripping yields empty', () => {
    expect(b0Identifier('sub-01')).toBe('sub-01')
  })
})

// ----- end-to-end fixture tests --------------------------------------------

interface FixtureSidecar {
  AcquisitionTime?: string
  ShimSetting?: ReadonlyArray<unknown>
  [key: string]: unknown
}

async function writeFmapFixture(
  dir: string,
  stem: string,
  sidecar: FixtureSidecar,
  affineSrowX: readonly [number, number, number, number] = [2, 0, 0, 0],
): Promise<void> {
  await writeFile(`${dir}/${stem}.json`, JSON.stringify(sidecar))
  const hdr = buildSyntheticNiftiHeader({
    sformCode: 2,
    srowX: affineSrowX,
    srowY: [0, 2, 0, 0],
    srowZ: [0, 0, 2, 0],
    dim: [3, 64, 64, 30, 1, 1, 1, 1],
  })
  await writeFile(`${dir}/${stem}.nii.gz`, gzipSync(Buffer.from(hdr)))
}

describe('planB0FieldEdits', () => {
  test('happy path: one compatible group, target picks it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bidsvue-postpass-pair-'))
    try {
      const ses = join(root, 'sub-01', 'ses-baseline')
      const fmap = join(ses, 'fmap')
      const func = join(ses, 'func')
      await mkdir(fmap, { recursive: true })
      await mkdir(func, { recursive: true })

      const shims = ['100', '0', '0', '0', '0', '0', '0', '0']
      await writeFmapFixture(fmap, 'sub-01_ses-baseline_dir-AP_epi', {
        AcquisitionTime: '10:00:00',
        ShimSetting: shims,
      })
      await writeFmapFixture(fmap, 'sub-01_ses-baseline_dir-PA_epi', {
        AcquisitionTime: '10:00:10',
        ShimSetting: shims,
      })
      await writeFmapFixture(func, 'sub-01_ses-baseline_task-rest_bold', {
        AcquisitionTime: '10:00:30',
        ShimSetting: shims,
      })

      const edits = await planB0FieldEdits(ses, nodeFsPostPassAdapter)
      // 2 fmap members + 1 target = 3 edits.
      expect(edits.length).toBe(3)
      const editedPaths = edits.map((e) => e.path).sort()
      expect(editedPaths).toContain(
        `${fmap}/sub-01_ses-baseline_dir-AP_epi.json`,
      )
      expect(editedPaths).toContain(
        `${fmap}/sub-01_ses-baseline_dir-PA_epi.json`,
      )
      expect(editedPaths).toContain(
        `${func}/sub-01_ses-baseline_task-rest_bold.json`,
      )
      // The group prefix is `sub-01_ses-baseline_epi` after stripping the
      // _dir-AP/_dir-PA suffix, so the stable identifier (after stripping
      // sub- and ses-) is just "epi". B0FieldSource on the target and
      // B0FieldIdentifier on every fmap member share that one string.
      const targetEdit = edits.find((e) => e.path.endsWith('_bold.json'))
      expect(targetEdit?.content).toContain('"B0FieldSource": "epi"')
      const fmapEdit = edits.find((e) => e.path.endsWith('_dir-AP_epi.json'))
      expect(fmapEdit?.content).toContain('"B0FieldIdentifier": "epi"')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('non-matching ShimSetting leaves target unpaired', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bidsvue-postpass-pair-no-'))
    try {
      const ses = join(root, 'sub-01')
      const fmap = join(ses, 'fmap')
      const func = join(ses, 'func')
      await mkdir(fmap, { recursive: true })
      await mkdir(func, { recursive: true })

      await writeFmapFixture(fmap, 'sub-01_dir-AP_epi', {
        AcquisitionTime: '10:00:00',
        ShimSetting: ['100', '0', '0', '0', '0', '0', '0', '0'],
      })
      await writeFmapFixture(fmap, 'sub-01_dir-PA_epi', {
        AcquisitionTime: '10:00:10',
        ShimSetting: ['100', '0', '0', '0', '0', '0', '0', '0'],
      })
      // Target has a different ShimSetting -- no match.
      await writeFmapFixture(func, 'sub-01_task-rest_bold', {
        AcquisitionTime: '10:00:30',
        ShimSetting: ['999', '0', '0', '0', '0', '0', '0', '0'],
      })

      const edits = await planB0FieldEdits(ses, nodeFsPostPassAdapter)
      // No usedGroups => no fmap edits and no target edits.
      expect(edits).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('two compatible groups: closest-in-time wins', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bidsvue-postpass-closest-'))
    try {
      const ses = join(root, 'sub-01')
      const fmap = join(ses, 'fmap')
      const func = join(ses, 'func')
      await mkdir(fmap, { recursive: true })
      await mkdir(func, { recursive: true })

      const shims = ['100', '0', '0', '0', '0', '0', '0', '0']
      // Group 1 at 09:00 (epi pair).
      await writeFmapFixture(fmap, 'sub-01_run-1_dir-AP_epi', {
        AcquisitionTime: '09:00:00',
        ShimSetting: shims,
      })
      await writeFmapFixture(fmap, 'sub-01_run-1_dir-PA_epi', {
        AcquisitionTime: '09:00:10',
        ShimSetting: shims,
      })
      // Group 2 at 11:00 (phasediff/magnitude).
      await writeFmapFixture(fmap, 'sub-01_run-2_magnitude1', {
        AcquisitionTime: '11:00:00',
        ShimSetting: shims,
      })
      await writeFmapFixture(fmap, 'sub-01_run-2_magnitude2', {
        AcquisitionTime: '11:00:05',
        ShimSetting: shims,
      })
      await writeFmapFixture(fmap, 'sub-01_run-2_phasediff', {
        AcquisitionTime: '11:00:10',
        ShimSetting: shims,
      })
      // Target at 10:45 -- closer to group 2 (mean ~11:00:05) than
      // group 1 (mean ~09:00:05).
      await writeFmapFixture(func, 'sub-01_task-rest_bold', {
        AcquisitionTime: '10:45:00',
        ShimSetting: shims,
      })

      const edits = await planB0FieldEdits(ses, nodeFsPostPassAdapter)
      const targetEdit = edits.find((e) => e.path.endsWith('_bold.json'))
      expect(targetEdit?.content).toContain('"B0FieldSource"')
      // The identifier comes from the stripped prefix -- group 2's
      // prefix is "sub-01_run-2" so the id is "run-2".
      expect(targetEdit?.content).toContain('"run-2"')
      expect(targetEdit?.content).not.toContain('"run-1"')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('sbref sidecars ARE valid fmap targets', async () => {
    // An sbref shares its bold's readout, hence the same B0 distortion, so
    // it must reference the fieldmap too (BIDScoin parity). reproinx.py
    // dropped the old `_is_target_for_fmaps` sbref exclusion.
    const root = mkdtempSync(join(tmpdir(), 'bidsvue-postpass-sbref-'))
    try {
      const ses = join(root, 'sub-01')
      const fmap = join(ses, 'fmap')
      const func = join(ses, 'func')
      await mkdir(fmap, { recursive: true })
      await mkdir(func, { recursive: true })

      const shims = ['100', '0', '0', '0', '0', '0', '0', '0']
      await writeFmapFixture(fmap, 'sub-01_dir-AP_epi', {
        AcquisitionTime: '10:00:00',
        ShimSetting: shims,
      })
      await writeFmapFixture(fmap, 'sub-01_dir-PA_epi', {
        AcquisitionTime: '10:00:10',
        ShimSetting: shims,
      })
      await writeFmapFixture(func, 'sub-01_task-rest_sbref', {
        AcquisitionTime: '10:00:30',
        ShimSetting: shims,
      })

      const edits = await planB0FieldEdits(ses, nodeFsPostPassAdapter)
      const sbrefEdit = edits.find((e) => e.path.endsWith('_sbref.json'))
      expect(sbrefEdit?.content).toContain('"B0FieldSource"')
      // The epi pair is one group -> both members carry the identifier.
      const fmapEdits = edits.filter((e) => e.path.includes('/fmap/'))
      expect(fmapEdits.length).toBe(2)
      for (const e of fmapEdits)
        expect(e.content).toContain('"B0FieldIdentifier"')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('sbref shares its bold sibling fmap selection (no diverging pair)', async () => {
    // Two shim-compatible fmap groups at different times: independent
    // closest-in-time selection would let the bold and its sbref pick
    // DIFFERENT groups (their AcquisitionTimes differ). The sbref pass forces
    // the sbref onto the bold's choice. Mirrors `_populate_b0_fields`.
    const root = mkdtempSync(join(tmpdir(), 'bidsvue-postpass-sbpair-'))
    try {
      const ses = join(root, 'sub-01')
      const fmap = join(ses, 'fmap')
      const func = join(ses, 'func')
      await mkdir(fmap, { recursive: true })
      await mkdir(func, { recursive: true })

      const shims = ['100', '0', '0', '0', '0', '0', '0', '0']
      // Two separate single-magnitude fmap groups (distinct acq- entity ->
      // distinct group prefix -> distinct identifier), same shims.
      await writeFmapFixture(fmap, 'sub-01_acq-early_magnitude1', {
        AcquisitionTime: '10:00:00',
        ShimSetting: shims,
      })
      await writeFmapFixture(fmap, 'sub-01_acq-late_magnitude1', {
        AcquisitionTime: '10:10:00',
        ShimSetting: shims,
      })
      // bold near the EARLY fmap; its sbref near the LATE fmap.
      await writeFmapFixture(func, 'sub-01_task-rest_bold', {
        AcquisitionTime: '10:00:30',
        ShimSetting: shims,
      })
      await writeFmapFixture(func, 'sub-01_task-rest_sbref', {
        AcquisitionTime: '10:09:30',
        ShimSetting: shims,
      })

      const edits = await planB0FieldEdits(ses, nodeFsPostPassAdapter)
      const boldEdit = edits.find((e) => e.path.endsWith('_bold.json'))
      const sbrefEdit = edits.find((e) => e.path.endsWith('_sbref.json'))
      const idOf = (content: string | undefined): string => {
        const m = /"B0FieldSource":\s*"([^"]+)"/.exec(content ?? '')
        return m?.[1] ?? ''
      }
      // bold is timed -> its closest pick (acq-early) wins; sbref shares it
      // despite the sbref's own closest-in-time being acq-late.
      expect(idOf(boldEdit?.content)).toBe(idOf(sbrefEdit?.content))
      expect(idOf(boldEdit?.content)).toContain('early')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('missing fmap directory yields no edits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bidsvue-postpass-no-fmap-'))
    try {
      const ses = join(root, 'sub-01')
      await mkdir(join(ses, 'anat'), { recursive: true })
      const edits = await planB0FieldEdits(ses, nodeFsPostPassAdapter)
      expect(edits).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
