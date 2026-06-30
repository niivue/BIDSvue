import { describe, expect, test } from 'bun:test'
import { parseFilename } from '$lib/bids/entities'
import type { Dataset, FileNode, FolderNode, TreeNode } from '$lib/bids/types'
import { type ReadAdapter, computePlan } from './computePlan'

// ---------- Test fixtures ----------

/**
 * Build a minimal Dataset stub from a `path → file-content?` map.
 *
 *   - Paths ending in `/` are folders; their content is ignored.
 *   - Paths that exist verbatim are files; content is the file body
 *     (used by the `ReadAdapter`).
 *   - Folder entries are auto-created for every parent dir mentioned.
 *
 * The shape covers what computePlan reads: `dataset.root`,
 * `dataset.index.byPath`, and `node.kind / node.name / node.extension`.
 */
function makeFixture(
  root: string,
  files: Record<string, string>,
): { dataset: Dataset; fs: ReadAdapter } {
  const byPath = new Map<string, TreeNode>()
  const fileContent = new Map<string, string>()

  function ensureFolder(path: string): void {
    if (byPath.has(path)) return
    const node: FolderNode = {
      kind: 'folder',
      path,
      name: path.split('/').pop() ?? '',
      level: 'other',
      children: [],
      flags: {},
    }
    byPath.set(path, node)
  }

  ensureFolder(root)
  for (const [filePath, content] of Object.entries(files)) {
    fileContent.set(filePath, content)
    // Walk parents to create folder entries.
    let parent = filePath.split('/').slice(0, -1).join('/')
    while (parent.length >= root.length) {
      ensureFolder(parent)
      if (parent === root) break
      parent = parent.split('/').slice(0, -1).join('/')
    }
    const name = filePath.split('/').pop() ?? ''
    const parsed = parseFilename(name)
    const node: FileNode = {
      kind: 'file',
      path: filePath,
      name,
      entities: parsed.entities,
      suffix: parsed.suffix,
      extension: parsed.extension,
      flags: {},
    }
    byPath.set(filePath, node)
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

  const fs: ReadAdapter = {
    async readTextFile(path: string): Promise<string> {
      const content = fileContent.get(path)
      if (content === undefined) {
        throw new Error(`fixture: no content for ${path}`)
      }
      return content
    },
    async exists(path: string): Promise<boolean> {
      return byPath.has(path)
    },
  }

  return { dataset, fs }
}

// ---------- Subject rename ----------

describe('computePlan — subject rename happy path', () => {
  test('renames the folder, every sub-X_ basename, and participants.tsv', async () => {
    const root = '/ds'
    const { dataset, fs } = makeFixture(root, {
      [`${root}/dataset_description.json`]: '{"Name":"x"}',
      [`${root}/participants.tsv`]:
        'participant_id\tage\nsub-01\t28\nsub-02\t34\n',
      [`${root}/sub-01/anat/sub-01_T1w.nii.gz`]: '<binary>',
      [`${root}/sub-01/anat/sub-01_T1w.json`]: '{"RepetitionTime":2.0}',
      [`${root}/sub-02/anat/sub-02_T1w.nii.gz`]: '<binary>',
    })

    const plan = await computePlan({
      dataset,
      kind: 'sub',
      oldLabel: '01',
      newLabel: '99',
      fs,
    })

    expect(plan.conflicts).toEqual([])
    expect(plan.counts.folders).toBe(1)
    expect(plan.counts.files).toBe(2) // T1w.nii.gz + T1w.json
    expect(plan.counts.tsvEdits).toBe(1) // participants.tsv
    expect(plan.counts.sidecarEdits).toBe(0)

    // Order: edit participants.tsv first, then folder rename, then leaves.
    const opKinds = plan.ops.map((op) =>
      op.kind === 'edit-text'
        ? `edit:${op.path}`
        : `rename:${op.from}→${op.to}`,
    )
    expect(opKinds[0]).toBe(`edit:${root}/participants.tsv`)
    expect(opKinds[1]).toBe(`rename:${root}/sub-01→${root}/sub-99`)
    // Remaining two are leaf renames, sorted alphabetically:
    expect(opKinds[2]).toBe(
      `rename:${root}/sub-99/anat/sub-01_T1w.json→${root}/sub-99/anat/sub-99_T1w.json`,
    )
    expect(opKinds[3]).toBe(
      `rename:${root}/sub-99/anat/sub-01_T1w.nii.gz→${root}/sub-99/anat/sub-99_T1w.nii.gz`,
    )

    // participants.tsv content: only the sub-01 row should change.
    const edit = plan.ops.find((op) => op.kind === 'edit-text')
    if (edit?.kind !== 'edit-text') throw new Error('expected edit-text op')
    expect(edit.newContent).toBe(
      'participant_id\tage\nsub-99\t28\nsub-02\t34\n',
    )
  })

  test('IntendedFor in fmap JSON gets updated; sub-X reference replaced safely', async () => {
    const root = '/ds'
    const { dataset, fs } = makeFixture(root, {
      [`${root}/dataset_description.json`]: '{"Name":"x"}',
      [`${root}/sub-01/anat/sub-01_T1w.nii.gz`]: '<binary>',
      [`${root}/sub-01/fmap/sub-01_magnitude1.nii.gz`]: '<binary>',
      [`${root}/sub-01/fmap/sub-01_magnitude1.json`]: JSON.stringify({
        IntendedFor: ['anat/sub-01_T1w.nii.gz'],
        EchoTime1: 0.005,
      }),
    })

    const plan = await computePlan({
      dataset,
      kind: 'sub',
      oldLabel: '01',
      newLabel: '07',
      fs,
    })

    expect(plan.conflicts).toEqual([])
    expect(plan.counts.sidecarEdits).toBe(1)
    const edit = plan.ops.find((op) => op.kind === 'edit-text')
    if (edit?.kind !== 'edit-text') throw new Error('expected edit-text op')
    expect(edit.newContent).toContain('"anat/sub-07_T1w.nii.gz"')
    expect(edit.newContent).not.toContain('sub-01')
  })

  test('skips participants.tsv edit when the file does not exist', async () => {
    const root = '/ds'
    const { dataset, fs } = makeFixture(root, {
      [`${root}/dataset_description.json`]: '{"Name":"x"}',
      // no participants.tsv
      [`${root}/sub-01/anat/sub-01_T1w.nii.gz`]: '<binary>',
      [`${root}/sub-01/anat/sub-01_T1w.json`]: '{}',
    })

    const plan = await computePlan({
      dataset,
      kind: 'sub',
      oldLabel: '01',
      newLabel: '99',
      fs,
    })

    expect(plan.conflicts).toEqual([])
    expect(plan.counts.tsvEdits).toBe(0)
    // No edit-text op should target a path that ends with participants.tsv.
    const editPaths = plan.ops
      .filter((op) => op.kind === 'edit-text')
      .map((op) => (op.kind === 'edit-text' ? op.path : ''))
    for (const p of editPaths) expect(p).not.toContain('participants.tsv')
    // The folder rename + leaf renames still proceed.
    expect(plan.counts.folders).toBe(1)
    expect(plan.counts.files).toBe(2)
  })

  test('word-boundary replacement: sub-1 → sub-2 does not corrupt sub-10', async () => {
    const root = '/ds'
    const { dataset, fs } = makeFixture(root, {
      [`${root}/dataset_description.json`]: '{"Name":"x"}',
      [`${root}/participants.tsv`]: 'participant_id\nsub-1\nsub-10\nsub-11\n',
      [`${root}/sub-1/anat/sub-1_T1w.json`]: '{"RepetitionTime":2.0}',
      [`${root}/sub-10/anat/sub-10_T1w.json`]: '{"RepetitionTime":2.0}',
    })

    const plan = await computePlan({
      dataset,
      kind: 'sub',
      oldLabel: '1',
      newLabel: '2',
      fs,
    })

    const edit = plan.ops.find((op) => op.kind === 'edit-text')
    if (edit?.kind !== 'edit-text') throw new Error('expected edit-text op')
    expect(edit.newContent).toBe('participant_id\nsub-2\nsub-10\nsub-11\n')

    // Folder and basename renames should only target the sub-1 entity.
    const folderRename = plan.ops.find(
      (op) => op.kind === 'rename-path' && op.isFolder,
    )
    if (folderRename?.kind !== 'rename-path') throw new Error()
    expect(folderRename.from).toBe(`${root}/sub-1`)
    expect(folderRename.to).toBe(`${root}/sub-2`)
  })
})

describe('computePlan — subject rename conflicts', () => {
  const root = '/ds'

  test('blocks when newLabel violates BIDS label rules', async () => {
    const { dataset, fs } = makeFixture(root, {
      [`${root}/sub-01/anat/sub-01_T1w.nii.gz`]: '<binary>',
    })
    const plan = await computePlan({
      dataset,
      kind: 'sub',
      oldLabel: '01',
      newLabel: 'invalid_label', // underscore not allowed
      fs,
    })
    expect(plan.conflicts.map((c) => c.kind)).toContain('invalid-label')
    expect(plan.ops).toEqual([])
  })

  test('blocks no-op renames (old === new)', async () => {
    const { dataset, fs } = makeFixture(root, {
      [`${root}/sub-01/anat/sub-01_T1w.nii.gz`]: '<binary>',
    })
    const plan = await computePlan({
      dataset,
      kind: 'sub',
      oldLabel: '01',
      newLabel: '01',
      fs,
    })
    expect(plan.conflicts.map((c) => c.kind)).toContain('no-op')
  })

  test('blocks when target subject already exists', async () => {
    const { dataset, fs } = makeFixture(root, {
      [`${root}/sub-01/anat/sub-01_T1w.nii.gz`]: '<binary>',
      [`${root}/sub-02/anat/sub-02_T1w.nii.gz`]: '<binary>',
    })
    const plan = await computePlan({
      dataset,
      kind: 'sub',
      oldLabel: '01',
      newLabel: '02',
      fs,
    })
    expect(plan.conflicts.map((c) => c.kind)).toContain('target-exists')
    expect(plan.ops).toEqual([])
  })

  test('blocks when the source subject does not exist', async () => {
    const { dataset, fs } = makeFixture(root, {
      [`${root}/sub-01/anat/sub-01_T1w.nii.gz`]: '<binary>',
    })
    const plan = await computePlan({
      dataset,
      kind: 'sub',
      oldLabel: 'XX',
      newLabel: 'YY',
      fs,
    })
    expect(plan.conflicts.map((c) => c.kind)).toContain('not-found')
  })

  test('blocks when a leaf rename would overwrite a hand-placed file', async () => {
    // Malformed-but-realistic dataset: a stray sub-02_T1w.json hand-placed
    // under sub-01/anat. Renaming sub-01 → sub-02 would otherwise compute
    // a clean plan and then renamePath would fail mid-apply.
    const { dataset, fs } = makeFixture(root, {
      [`${root}/sub-01/anat/sub-01_T1w.nii.gz`]: '<binary>',
      [`${root}/sub-01/anat/sub-01_T1w.json`]: '{}',
      [`${root}/sub-01/anat/sub-02_T1w.json`]: '{}',
    })
    const plan = await computePlan({
      dataset,
      kind: 'sub',
      oldLabel: '01',
      newLabel: '02',
      fs,
    })
    // target-exists fires first because sub-02 already exists implicitly
    // via the index; if not, leaf-target-exists must surface.
    expect(plan.conflicts.length).toBeGreaterThan(0)
    expect(plan.ops).toEqual([])
  })

  test('blocks when two leaves would rename onto the same target', async () => {
    // Both `sub-01_T1w.json` (under sub-01/anat) and a separate file
    // that already happens to encode sub-02 would collide on sub-02_T1w.json.
    // The collision is the same kind: leaf-target-exists / leaf-target-collision.
    // Here we drop the existing sub-02 elsewhere so the folder rename is OK,
    // and instead place two files in the moving subtree whose post-rename
    // basenames match.
    const { dataset, fs } = makeFixture(root, {
      [`${root}/sub-01/anat/sub-01_T1w.nii.gz`]: '<binary>',
      [`${root}/sub-01/anat/sub-01_T1w.json`]: '{}',
      // pre-existing file in the SAME subtree that happens to look like
      // the post-rename target. After sub-01→sub-99, sub-01_T1w.json
      // wants to become sub-99_T1w.json, but that file already exists in
      // its sibling slot inside sub-01/anat/. The preflight catches it.
      [`${root}/sub-01/anat/sub-99_T1w.json`]: '{}',
    })
    const plan = await computePlan({
      dataset,
      kind: 'sub',
      oldLabel: '01',
      newLabel: '99',
      fs,
    })
    expect(plan.conflicts.map((c) => c.kind)).toContain('leaf-target-exists')
    expect(plan.ops).toEqual([])
  })
})

// ---------- Session rename ----------

describe('computePlan — session rename', () => {
  const root = '/ds'

  test('renames a session under one subject; participants.tsv untouched', async () => {
    const { dataset, fs } = makeFixture(root, {
      [`${root}/participants.tsv`]: 'participant_id\nsub-01\n',
      [`${root}/sub-01/sub-01_sessions.tsv`]:
        'session_id\tacq_time\nses-01\t2024-01-01\nses-02\t2024-06-01\n',
      [`${root}/sub-01/ses-01/anat/sub-01_ses-01_T1w.nii.gz`]: '<binary>',
      [`${root}/sub-01/ses-01/anat/sub-01_ses-01_T1w.json`]: '{}',
      [`${root}/sub-01/ses-02/anat/sub-01_ses-02_T1w.nii.gz`]: '<binary>',
    })

    const plan = await computePlan({
      dataset,
      kind: 'ses',
      oldLabel: '01',
      newLabel: 'pre',
      scopeSubjectPath: `${root}/sub-01`,
      fs,
    })

    expect(plan.conflicts).toEqual([])
    expect(plan.counts.folders).toBe(1)
    expect(plan.counts.files).toBe(2) // .nii.gz + .json
    expect(plan.counts.tsvEdits).toBe(1) // sub-01_sessions.tsv

    // Sessions.tsv edits only the ses-01 row.
    const edit = plan.ops.find((op) => op.kind === 'edit-text')
    if (edit?.kind !== 'edit-text') throw new Error()
    expect(edit.newContent).toBe(
      'session_id\tacq_time\nses-pre\t2024-01-01\nses-02\t2024-06-01\n',
    )

    // No participants.tsv edit (it doesn't contain ses-01).
    expect(plan.ops.filter((op) => op.kind === 'edit-text')).toHaveLength(1)

    // Folder rename targets <subject>/ses-01 → <subject>/ses-pre.
    const folderRename = plan.ops.find(
      (op) => op.kind === 'rename-path' && op.isFolder,
    )
    if (folderRename?.kind !== 'rename-path') throw new Error()
    expect(folderRename.from).toBe(`${root}/sub-01/ses-01`)
    expect(folderRename.to).toBe(`${root}/sub-01/ses-pre`)

    // Leaf renames target post-folder-rename paths (ses-pre/...).
    const leafRenames = plan.ops.filter(
      (op) => op.kind === 'rename-path' && !op.isFolder,
    )
    for (const op of leafRenames) {
      if (op.kind !== 'rename-path') throw new Error()
      expect(op.from).toContain('/ses-pre/')
      expect(op.to).toContain('/ses-pre/')
      expect(op.from).toContain('sub-01_ses-01_')
      expect(op.to).toContain('sub-01_ses-pre_')
    }
  })

  test('skips sessions.tsv edit when the file does not exist', async () => {
    const { dataset, fs } = makeFixture(root, {
      // no sub-01_sessions.tsv at all
      [`${root}/sub-01/ses-01/anat/sub-01_ses-01_T1w.json`]: '{}',
    })

    const plan = await computePlan({
      dataset,
      kind: 'ses',
      oldLabel: '01',
      newLabel: 'A',
      scopeSubjectPath: `${root}/sub-01`,
      fs,
    })

    expect(plan.conflicts).toEqual([])
    expect(plan.counts.tsvEdits).toBe(0)
    // The folder rename + leaf rename still happen.
    expect(plan.counts.folders).toBe(1)
    expect(plan.counts.files).toBe(1)
  })

  test('does not touch the other session under the same subject', async () => {
    const { dataset, fs } = makeFixture(root, {
      [`${root}/sub-01/sub-01_sessions.tsv`]: 'session_id\nses-01\nses-02\n',
      [`${root}/sub-01/ses-01/anat/sub-01_ses-01_T1w.json`]: '{}',
      [`${root}/sub-01/ses-02/anat/sub-01_ses-02_T1w.json`]: '{}',
    })

    const plan = await computePlan({
      dataset,
      kind: 'ses',
      oldLabel: '01',
      newLabel: '03',
      scopeSubjectPath: `${root}/sub-01`,
      fs,
    })

    // Only ses-01 paths and references should appear in ops.
    for (const op of plan.ops) {
      if (op.kind === 'rename-path') {
        expect(op.from).toContain('ses-01')
      } else {
        // Edit op: it's the sessions.tsv, which contains both ses-01
        // and ses-02. The replacer leaves ses-02 alone.
        expect(op.newContent).toContain('ses-02')
        expect(op.newContent).toContain('ses-03')
        expect(op.newContent).not.toContain('ses-01')
      }
    }
  })
})

// ---------- Filename-entity renames (task / acq / run / chunk / …) ----------

describe('computePlan — task rename (filename-only entity)', () => {
  test('renames every file with task-<old> across all subjects', async () => {
    const root = '/d'
    const { dataset, fs } = makeFixture(root, {
      [`${root}/dataset_description.json`]: '{"Name":"x"}',
      [`${root}/sub-01/func/sub-01_task-rest_bold.nii.gz`]: 'a',
      [`${root}/sub-01/func/sub-01_task-rest_bold.json`]: '{}',
      [`${root}/sub-02/func/sub-02_task-rest_bold.nii.gz`]: 'b',
      [`${root}/sub-02/func/sub-02_task-rest_bold.json`]: '{}',
    })

    const plan = await computePlan({
      dataset,
      kind: 'task',
      oldLabel: 'rest',
      newLabel: 'flanker',
      fs,
    })

    expect(plan.conflicts).toEqual([])
    expect(plan.counts.folders).toBe(0)
    expect(plan.counts.files).toBe(4)
    // Every rename keeps its parent dir and just rewrites the basename's token.
    for (const op of plan.ops) {
      if (op.kind !== 'rename-path') continue
      expect(op.from.includes('task-rest')).toBe(true)
      expect(op.to.includes('task-flanker')).toBe(true)
      expect(op.to.replace('task-flanker', 'task-rest')).toBe(op.from)
    }
  })

  test('also edits scans.tsv and IntendedFor references mentioning the token', async () => {
    const root = '/d'
    const scansTsv = 'filename\nfunc/sub-01_task-rest_bold.nii.gz\n'
    const fmapJson = JSON.stringify({
      IntendedFor: ['func/sub-01_task-rest_bold.nii.gz'],
    })
    const { dataset, fs } = makeFixture(root, {
      [`${root}/dataset_description.json`]: '{"Name":"x"}',
      [`${root}/sub-01/sub-01_scans.tsv`]: scansTsv,
      [`${root}/sub-01/func/sub-01_task-rest_bold.nii.gz`]: 'a',
      [`${root}/sub-01/fmap/sub-01_magnitude1.json`]: fmapJson,
    })

    const plan = await computePlan({
      dataset,
      kind: 'task',
      oldLabel: 'rest',
      newLabel: 'flanker',
      fs,
    })

    expect(plan.conflicts).toEqual([])
    expect(plan.counts.tsvEdits).toBeGreaterThanOrEqual(1)
    expect(plan.counts.sidecarEdits).toBeGreaterThanOrEqual(1)
    const editOps = plan.ops.filter((o) => o.kind === 'edit-text')
    const haveScans = editOps.some((o) =>
      'newContent' in o ? o.newContent.includes('task-flanker') : false,
    )
    expect(haveScans).toBe(true)
  })

  test("reports 'not-found' when the token doesn't appear anywhere", async () => {
    const root = '/d'
    const { dataset, fs } = makeFixture(root, {
      [`${root}/dataset_description.json`]: '{}',
      [`${root}/sub-01/anat/sub-01_T1w.json`]: '{}',
    })
    const plan = await computePlan({
      dataset,
      kind: 'task',
      oldLabel: 'rest',
      newLabel: 'flanker',
      fs,
    })
    expect(plan.ops).toEqual([])
    expect(plan.conflicts.map((c) => c.kind)).toEqual(['not-found'])
  })

  test('refuses no-op rename', async () => {
    const root = '/d'
    const { dataset, fs } = makeFixture(root, {
      [`${root}/sub-01/func/sub-01_task-rest_bold.json`]: '{}',
    })
    const plan = await computePlan({
      dataset,
      kind: 'task',
      oldLabel: 'rest',
      newLabel: 'rest',
      fs,
    })
    expect(plan.conflicts.map((c) => c.kind)).toContain('no-op')
  })

  test('refuses invalid label', async () => {
    const root = '/d'
    const { dataset, fs } = makeFixture(root, {
      [`${root}/sub-01/func/sub-01_task-rest_bold.json`]: '{}',
    })
    const plan = await computePlan({
      dataset,
      kind: 'task',
      oldLabel: 'rest',
      newLabel: 'has spaces',
      fs,
    })
    expect(plan.conflicts.map((c) => c.kind)).toContain('invalid-label')
  })

  test('detects leaf-target-exists collisions with files outside the moving set', async () => {
    // run-01 -> run-02 in a dataset that already has both run-01 AND run-02
    // for the same subject. The rename would write run-01 onto run-02.
    const root = '/d'
    const { dataset, fs } = makeFixture(root, {
      [`${root}/sub-01/func/sub-01_task-rest_run-01_bold.nii.gz`]: 'a',
      [`${root}/sub-01/func/sub-01_task-rest_run-02_bold.nii.gz`]: 'b',
    })
    const plan = await computePlan({
      dataset,
      kind: 'run',
      oldLabel: '01',
      newLabel: '02',
      fs,
    })
    expect(plan.ops).toEqual([])
    expect(plan.conflicts.map((c) => c.kind)).toContain('leaf-target-exists')
  })

  test('skips files inside derivatives / sourcedata / code', async () => {
    const root = '/d'
    const { dataset, fs } = makeFixture(root, {
      [`${root}/sub-01/func/sub-01_task-rest_bold.json`]: '{}',
      [`${root}/derivatives/proj/sub-01_task-rest_desc-clean_bold.json`]: '{}',
      [`${root}/sourcedata/sub-01_task-rest_raw.dat`]: 'raw',
    })
    // Mark the special-folder children so the engine respects scope.
    // GroupNode doesn't carry flags; only File/Folder nodes do.
    for (const [p, n] of dataset.index.byPath) {
      if (n.kind === 'group') continue
      if (p.startsWith(`${root}/derivatives/`)) {
        n.flags = { ...n.flags, specialFolder: 'derivatives' }
      }
      if (p.startsWith(`${root}/sourcedata/`)) {
        n.flags = { ...n.flags, specialFolder: 'sourcedata' }
      }
    }

    const plan = await computePlan({
      dataset,
      kind: 'task',
      oldLabel: 'rest',
      newLabel: 'flanker',
      fs,
    })

    // Only the sub-01/func/ file should be touched.
    expect(plan.counts.files).toBe(1)
    for (const op of plan.ops) {
      if (op.kind === 'rename-path') {
        expect(op.from).not.toContain('derivatives/')
        expect(op.from).not.toContain('sourcedata/')
      }
    }
  })

  test('run rename inside a single basename touches that file alone', async () => {
    const root = '/d'
    const { dataset, fs } = makeFixture(root, {
      [`${root}/sub-01/func/sub-01_task-rest_run-02_bold.nii.gz`]: 'a',
    })
    const plan = await computePlan({
      dataset,
      kind: 'run',
      oldLabel: '02',
      newLabel: '03',
      fs,
    })
    expect(plan.conflicts).toEqual([])
    expect(plan.counts.files).toBe(1)
    expect(plan.counts.folders).toBe(0)
    const op = plan.ops[0]
    if (op.kind !== 'rename-path') throw new Error('expected rename')
    expect(op.from).toBe(
      `${root}/sub-01/func/sub-01_task-rest_run-02_bold.nii.gz`,
    )
    expect(op.to).toBe(
      `${root}/sub-01/func/sub-01_task-rest_run-03_bold.nii.gz`,
    )
  })
})
