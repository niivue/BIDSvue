import { describe, expect, test } from 'bun:test'
import { parseFilename } from '$lib/bids/entities'
import type {
  BidsLevel,
  Dataset,
  FileNode,
  FolderNode,
  TreeNode,
} from '$lib/bids/types'
import type { ReadOnlyFs } from '$lib/mutate/backup'
import {
  type RemoveOp,
  computeRemoveEntityPlan,
  detectRemovableEntities,
} from './removePlan'

function folderLevel(name: string): BidsLevel {
  if (/^sub-[A-Za-z0-9]+$/.test(name)) return 'subject'
  if (/^ses-[A-Za-z0-9]+$/.test(name)) return 'session'
  if (
    [
      'anat',
      'func',
      'dwi',
      'fmap',
      'perf',
      'pet',
      'meg',
      'eeg',
      'beh',
    ].includes(name)
  )
    return 'datatype'
  return 'other'
}

function makeFixture(
  root: string,
  files: Record<string, string>,
): { dataset: Dataset; fs: ReadOnlyFs } {
  const byPath = new Map<string, TreeNode>()
  const fileContent = new Map<string, string>()

  function ensureFolder(path: string): void {
    if (byPath.has(path)) return
    const name = path.split('/').pop() ?? ''
    byPath.set(path, {
      kind: 'folder',
      path,
      name,
      level: path === root ? 'root' : folderLevel(name),
      children: [],
      flags: {},
    } as FolderNode)
  }

  ensureFolder(root)
  for (const [filePath, content] of Object.entries(files)) {
    fileContent.set(filePath, content)
    let parent = filePath.split('/').slice(0, -1).join('/')
    while (parent.length >= root.length) {
      ensureFolder(parent)
      if (parent === root) break
      parent = parent.split('/').slice(0, -1).join('/')
    }
    const name = filePath.split('/').pop() ?? ''
    const parsed = parseFilename(name)
    byPath.set(filePath, {
      kind: 'file',
      path: filePath,
      name,
      entities: parsed.entities,
      suffix: parsed.suffix,
      extension: parsed.extension,
      flags: {},
    } as FileNode)
  }

  const dataset = {
    root,
    index: {
      byPath,
      bySubject: new Map(),
      bySubjectSession: new Map(),
      bySuffix: new Map(),
    },
  } as unknown as Dataset

  const fs: ReadOnlyFs = {
    async readTextFile(path: string): Promise<string> {
      const c = fileContent.get(path)
      if (c === undefined) throw new Error(`no content for ${path}`)
      return c
    },
    async exists(path: string): Promise<boolean> {
      return byPath.has(path)
    },
  }
  return { dataset, fs }
}

function renames(ops: RemoveOp[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const op of ops) if (op.kind === 'rename-path') out[op.from] = op.to
  return out
}

// ---------- sub is unremovable ----------

test('removing sub is unsupported', async () => {
  const { dataset, fs } = makeFixture('/ds', {
    '/ds/sub-01/anat/sub-01_T1w.nii.gz': '',
  })
  const plan = await computeRemoveEntityPlan({ dataset, kind: 'sub', fs })
  expect(plan.conflicts[0]?.kind).toBe('unsupported-entity')
})

test('removing a REQUIRED entity (task) is refused — audit P1', async () => {
  // task is required for func bold/events; removing it makes invalid BIDS
  // even though nothing collides. Must be refused, not offered.
  const { dataset, fs } = makeFixture('/ds', {
    '/ds/sub-01/func/sub-01_task-rest_bold.nii.gz': '',
    '/ds/sub-01/func/sub-01_task-rest_events.tsv': 'onset\n',
  })
  const plan = await computeRemoveEntityPlan({ dataset, kind: 'task', fs })
  expect(plan.conflicts[0]?.kind).toBe('unsupported-entity')
  expect(plan.ops).toHaveLength(0)
  // detection must not offer it either
  expect(detectRemovableEntities(dataset).map((e) => e.kind)).not.toContain(
    'task',
  )
})

// ---------- filename entity removal (run) ----------

describe('filename-entity removal', () => {
  test('strips a single-valued run from names + scans.tsv content', async () => {
    const { dataset, fs } = makeFixture('/ds', {
      '/ds/sub-01/func/sub-01_task-rest_run-1_bold.nii.gz': '',
      '/ds/sub-01/func/sub-01_task-rest_run-1_bold.json': '{}',
      '/ds/sub-01/sub-01_scans.tsv':
        'filename\tacq_time\nfunc/sub-01_task-rest_run-1_bold.nii.gz\t2020\n',
    })
    const plan = await computeRemoveEntityPlan({ dataset, kind: 'run', fs })
    expect(plan.conflicts).toHaveLength(0)
    const r = renames(plan.ops)
    expect(r['/ds/sub-01/func/sub-01_task-rest_run-1_bold.nii.gz']).toBe(
      '/ds/sub-01/func/sub-01_task-rest_bold.nii.gz',
    )
    const edit = plan.ops.find((o) => o.kind === 'edit-text')
    expect(edit?.kind === 'edit-text' && edit.newContent).toContain(
      'func/sub-01_task-rest_bold.nii.gz',
    )
  })

  test('refuses to remove run when it disambiguates (collision)', async () => {
    const { dataset, fs } = makeFixture('/ds', {
      '/ds/sub-01/func/sub-01_task-rest_run-1_bold.nii.gz': '',
      '/ds/sub-01/func/sub-01_task-rest_run-2_bold.nii.gz': '',
    })
    const plan = await computeRemoveEntityPlan({ dataset, kind: 'run', fs })
    expect(plan.conflicts.some((c) => c.kind === 'leaf-target-collision')).toBe(
      true,
    )
    expect(plan.ops).toHaveLength(0)
  })

  test('not-found when the entity is absent', async () => {
    const { dataset, fs } = makeFixture('/ds', {
      '/ds/sub-01/anat/sub-01_T1w.nii.gz': '',
    })
    const plan = await computeRemoveEntityPlan({ dataset, kind: 'run', fs })
    expect(plan.conflicts[0]?.kind).toBe('not-found')
  })

  test('fails closed when an in-scope scans.tsv is unreadable — audit P1', async () => {
    const scans = '/ds/sub-01/sub-01_scans.tsv'
    const { dataset, fs } = makeFixture('/ds', {
      '/ds/sub-01/func/sub-01_task-rest_run-1_bold.nii.gz': '',
      [scans]:
        'filename\tacq_time\nfunc/sub-01_task-rest_run-1_bold.nii.gz\t2020\n',
    })
    // The scans.tsv exists + is in-scope but can't be read (EACCES/EIO).
    const failingFs: ReadOnlyFs = {
      exists: fs.exists,
      async readTextFile(path: string): Promise<string> {
        if (path === scans) throw new Error('EACCES: permission denied')
        return fs.readTextFile(path)
      },
    }
    const plan = await computeRemoveEntityPlan({
      dataset,
      kind: 'run',
      fs: failingFs,
    })
    expect(plan.conflicts.some((c) => c.kind === 'unreadable-reference')).toBe(
      true,
    )
    // No path collapse while a reference is unreadable.
    expect(plan.ops).toHaveLength(0)
  })
})

// ---------- session removal (collapse) ----------

describe('session removal', () => {
  function singleSession() {
    return makeFixture('/ds', {
      '/ds/sub-01/sub-01_sessions.tsv': 'session_id\nses-A\n',
      '/ds/sub-01/ses-A/anat/sub-01_ses-A_T1w.nii.gz': '',
      '/ds/sub-01/ses-A/anat/sub-01_ses-A_T1w.json': '{}',
      '/ds/sub-01/ses-A/func/sub-01_ses-A_task-rest_bold.nii.gz': '',
      '/ds/sub-01/ses-A/sub-01_ses-A_scans.tsv':
        'filename\nfunc/sub-01_ses-A_task-rest_bold.nii.gz\n',
      '/ds/sub-01/ses-A/fmap/sub-01_ses-A_dir-AP_epi.json':
        '{"IntendedFor":"ses-A/func/sub-01_ses-A_task-rest_bold.nii.gz"}',
    })
  }

  test('collapses a single session: dir moves + filename strips', async () => {
    const { dataset, fs } = singleSession()
    const plan = await computeRemoveEntityPlan({ dataset, kind: 'ses', fs })
    expect(plan.conflicts).toHaveLength(0)
    const r = renames(plan.ops)
    // datatype dirs move up
    expect(r['/ds/sub-01/ses-A/anat']).toBe('/ds/sub-01/anat')
    expect(r['/ds/sub-01/ses-A/func']).toBe('/ds/sub-01/func')
    // files strip _ses-A at their post-move location
    expect(r['/ds/sub-01/anat/sub-01_ses-A_T1w.nii.gz']).toBe(
      '/ds/sub-01/anat/sub-01_T1w.nii.gz',
    )
    // session-level scans.tsv moves up + strips
    expect(r['/ds/sub-01/ses-A/sub-01_ses-A_scans.tsv']).toBe(
      '/ds/sub-01/sub-01_scans.tsv',
    )
  })

  test('deletes sessions.tsv and removes the emptied session dir', async () => {
    const { dataset, fs } = singleSession()
    const plan = await computeRemoveEntityPlan({ dataset, kind: 'ses', fs })
    expect(
      plan.ops.some(
        (o) =>
          o.kind === 'delete-file' && o.path.endsWith('sub-01_sessions.tsv'),
      ),
    ).toBe(true)
    expect(
      plan.ops.some(
        (o) => o.kind === 'remove-empty-dir' && o.path === '/ds/sub-01/ses-A',
      ),
    ).toBe(true)
  })

  test('strips ses from scans.tsv and IntendedFor content', async () => {
    const { dataset, fs } = singleSession()
    const plan = await computeRemoveEntityPlan({ dataset, kind: 'ses', fs })
    const edits = plan.ops.filter((o) => o.kind === 'edit-text')
    const scans = edits.find(
      (o) => o.kind === 'edit-text' && o.path.endsWith('_scans.tsv'),
    )
    expect(scans?.kind === 'edit-text' && scans.newContent).toContain(
      'func/sub-01_task-rest_bold.nii.gz',
    )
    const fmap = edits.find(
      (o) => o.kind === 'edit-text' && o.path.endsWith('.json'),
    )
    // both the ses-A/ path component and the _ses-A token are stripped
    expect(fmap?.kind === 'edit-text' && fmap.newContent).toContain(
      '"IntendedFor":"func/sub-01_task-rest_bold.nii.gz"',
    )
  })

  test('refuses to collapse when a subject has two sessions', async () => {
    const { dataset, fs } = makeFixture('/ds', {
      '/ds/sub-01/ses-A/anat/sub-01_ses-A_T1w.nii.gz': '',
      '/ds/sub-01/ses-B/anat/sub-01_ses-B_T1w.nii.gz': '',
    })
    const plan = await computeRemoveEntityPlan({ dataset, kind: 'ses', fs })
    expect(plan.conflicts.some((c) => c.kind === 'multi-session')).toBe(true)
    expect(plan.ops).toHaveLength(0)
  })

  test('not-found when there are no session folders', async () => {
    const { dataset, fs } = makeFixture('/ds', {
      '/ds/sub-01/anat/sub-01_T1w.nii.gz': '',
    })
    const plan = await computeRemoveEntityPlan({ dataset, kind: 'ses', fs })
    expect(plan.conflicts[0]?.kind).toBe('not-found')
  })

  test('refuses when a stripped file collides with an unchanged sibling — audit P2', async () => {
    // Inside the moved anat/, the stripped sub-01_ses-A_T1w → sub-01_T1w
    // would collide with the already-stripped sub-01_T1w sitting there.
    const { dataset, fs } = makeFixture('/ds', {
      '/ds/sub-01/ses-A/anat/sub-01_ses-A_T1w.nii.gz': '',
      '/ds/sub-01/ses-A/anat/sub-01_T1w.nii.gz': '',
    })
    const plan = await computeRemoveEntityPlan({ dataset, kind: 'ses', fs })
    expect(plan.conflicts.some((c) => c.kind === 'leaf-target-collision')).toBe(
      true,
    )
    expect(plan.ops).toHaveLength(0)
  })

  test('refuses when the session holds a bidsignored file — audit security P2', async () => {
    const { dataset, fs } = makeFixture('/ds', {
      '/ds/sub-01/ses-A/anat/sub-01_ses-A_T1w.nii.gz': '',
      '/ds/sub-01/ses-A/extra.bin': '',
    })
    // Mark the stray file bidsignored so the move skips it.
    const stray = dataset.index.byPath.get('/ds/sub-01/ses-A/extra.bin')
    if (stray?.kind === 'file') stray.flags.bidsIgnored = true
    const plan = await computeRemoveEntityPlan({ dataset, kind: 'ses', fs })
    expect(plan.conflicts.some((c) => c.kind === 'leaf-target-exists')).toBe(
      true,
    )
  })
})

// ---------- detection ----------

describe('detectRemovableEntities', () => {
  test('reports ses + run for a single-session single-run dataset', async () => {
    const { dataset } = makeFixture('/ds', {
      '/ds/sub-01/ses-A/func/sub-01_ses-A_task-rest_run-1_bold.nii.gz': '',
    })
    const kinds = detectRemovableEntities(dataset).map((e) => e.kind)
    expect(kinds).toContain('ses')
    expect(kinds).toContain('run')
    // folder entity sorts first
    expect(kinds[0]).toBe('ses')
  })

  test('omits run when it disambiguates two scans', async () => {
    const { dataset } = makeFixture('/ds', {
      '/ds/sub-01/func/sub-01_task-rest_run-1_bold.nii.gz': '',
      '/ds/sub-01/func/sub-01_task-rest_run-2_bold.nii.gz': '',
    })
    const kinds = detectRemovableEntities(dataset).map((e) => e.kind)
    expect(kinds).not.toContain('run')
  })

  test('omits ses when a subject has multiple sessions', async () => {
    const { dataset } = makeFixture('/ds', {
      '/ds/sub-01/ses-A/anat/sub-01_ses-A_T1w.nii.gz': '',
      '/ds/sub-01/ses-B/anat/sub-01_ses-B_T1w.nii.gz': '',
    })
    const kinds = detectRemovableEntities(dataset).map((e) => e.kind)
    expect(kinds).not.toContain('ses')
  })
})
