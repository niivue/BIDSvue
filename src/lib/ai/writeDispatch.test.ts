import { describe, expect, it } from 'bun:test'
import { planAiWrite } from './writeDispatch'

const ROOT = '/data/study'

describe('planAiWrite — save_text_file', () => {
  it('plans a write under the root', () => {
    const plan = planAiWrite(
      'save_text_file',
      { path: 'README', text: 'hi' },
      ROOT,
    )
    expect(plan).toMatchObject({
      kind: 'write',
      absPath: '/data/study/README',
      text: 'hi',
      opType: 'textEdit',
    })
  })

  it('joins nested relative paths', () => {
    const plan = planAiWrite(
      'save_text_file',
      { path: 'sub-01/anat/sub-01_T1w.json', text: '{}' },
      ROOT,
    )
    expect(plan).toMatchObject({
      absPath: '/data/study/sub-01/anat/sub-01_T1w.json',
    })
  })

  it('rejects missing path / text', () => {
    expect(() => planAiWrite('save_text_file', { text: 'x' }, ROOT)).toThrow(
      /path/,
    )
    expect(() => planAiWrite('save_text_file', { path: 'a' }, ROOT)).toThrow(
      /text/,
    )
  })

  it('rejects traversal and absolute paths', () => {
    expect(() =>
      planAiWrite('save_text_file', { path: '../escape', text: 'x' }, ROOT),
    ).toThrow(/\.\./)
    expect(() =>
      planAiWrite('save_text_file', { path: '/etc/passwd', text: 'x' }, ROOT),
    ).toThrow(/relative/)
  })

  it('refuses identity-bearing participants.tsv', () => {
    expect(() =>
      planAiWrite(
        'save_text_file',
        { path: 'participants.tsv', text: 'x' },
        ROOT,
      ),
    ).toThrow(/rename_entity/)
  })

  it('allows an empty text body (truncate-to-empty is a valid edit)', () => {
    const plan = planAiWrite(
      'save_text_file',
      { path: 'CHANGES', text: '' },
      ROOT,
    )
    if (plan.kind !== 'write') throw new Error('expected write')
    expect(plan.text).toBe('')
  })

  it('refuses identity/out-of-scope case-insensitively (macOS FS) — audit P3', () => {
    expect(() =>
      planAiWrite(
        'save_text_file',
        { path: 'Participants.tsv', text: 'x' },
        ROOT,
      ),
    ).toThrow(/rename_entity/)
    expect(() =>
      planAiWrite(
        'save_text_file',
        { path: 'Code/script.py', text: 'x' },
        ROOT,
      ),
    ).toThrow(/out of scope/)
  })
})

describe('planAiWrite — save_sidecar', () => {
  it('accepts a JSON string and keeps it verbatim', () => {
    const plan = planAiWrite(
      'save_sidecar',
      { path: 'sub-01/func/x.json', json: '{"TaskName":"rest"}' },
      ROOT,
    )
    expect(plan).toMatchObject({ kind: 'write', opType: 'sidecarEdit' })
    if (plan.kind !== 'write') throw new Error('expected write')
    expect(plan.text).toBe('{"TaskName":"rest"}')
  })

  it('serialises an object argument', () => {
    const plan = planAiWrite(
      'save_sidecar',
      { path: 'x.json', json: { a: 1 } },
      ROOT,
    )
    if (plan.kind !== 'write') throw new Error('expected write')
    expect(JSON.parse(plan.text)).toEqual({ a: 1 })
  })

  it('rejects invalid JSON string', () => {
    expect(() =>
      planAiWrite('save_sidecar', { path: 'x.json', json: '{not json' }, ROOT),
    ).toThrow(/valid JSON/)
  })

  it('rejects missing json', () => {
    expect(() => planAiWrite('save_sidecar', { path: 'x.json' }, ROOT)).toThrow(
      /json/,
    )
  })

  it('requires a .json path (P2.8)', () => {
    expect(() =>
      planAiWrite('save_sidecar', { path: 'README', json: '{}' }, ROOT),
    ).toThrow(/\.json/)
    expect(() =>
      planAiWrite('save_sidecar', { path: 'sub-01/x.tsv', json: '{}' }, ROOT),
    ).toThrow(/\.json/)
  })
})

describe('planAiWrite — VCS/app-internal defense-in-depth (P1.1/P2.3)', () => {
  it('blocks .git* and app-internal components for every write tool', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['save_text_file', { path: '.git/hooks/pre-commit', text: 'x' }],
      ['save_text_file', { path: '.gitignore', text: 'x' }],
      ['save_sidecar', { path: '.datalad/config.json', json: '{}' }],
      ['delete_file', { path: '.gitmodules' }],
      ['delete_file', { path: 'sub-01/.bidsvue/x' }],
    ]
    for (const [tool, args] of cases) {
      expect(() => planAiWrite(tool, args, ROOT)).toThrow(/off-limits|\.\./)
    }
  })

  it('rejects backslash paths (the Rust-bypass class)', () => {
    // TS normalises `\`→`/`, so `.git\hooks` resolves into .git/ and is
    // caught by the component block (Rust rejects the backslash outright).
    expect(() =>
      planAiWrite(
        'save_text_file',
        { path: '.git\\hooks\\x', text: 'y' },
        ROOT,
      ),
    ).toThrow(/off-limits/)
  })

  it('still allows .bidsignore', () => {
    const plan = planAiWrite(
      'save_text_file',
      { path: '.bidsignore', text: 'x' },
      ROOT,
    )
    expect(plan).toMatchObject({ kind: 'write' })
  })
})

describe('planAiWrite — delete_file', () => {
  it('plans a delete under the root', () => {
    const plan = planAiWrite(
      'delete_file',
      { path: 'sub-01/anat/junk.json' },
      ROOT,
    )
    expect(plan).toMatchObject({
      kind: 'delete',
      absPath: '/data/study/sub-01/anat/junk.json',
    })
  })

  it('refuses derivatives / sourcedata / code', () => {
    for (const top of ['derivatives', 'sourcedata', 'code']) {
      expect(() =>
        planAiWrite('delete_file', { path: `${top}/x.json` }, ROOT),
      ).toThrow(/out of scope/)
    }
  })

  it('refuses identity-bearing participants.tsv', () => {
    expect(() =>
      planAiWrite('delete_file', { path: 'participants.tsv' }, ROOT),
    ).toThrow(/rename_entity/)
  })

  it('refuses traversal', () => {
    expect(() => planAiWrite('delete_file', { path: '../x' }, ROOT)).toThrow(
      /\.\./,
    )
  })

  it('refuses derivatives even with a ./ prefix mask (P1 regression)', () => {
    // The scope check must run on the RESOLVED path, not the raw input —
    // `./derivatives/x` resolves into derivatives/ and must still be
    // refused (the prefix used to mask the first real segment).
    expect(() =>
      planAiWrite('delete_file', { path: './derivatives/x.tsv' }, ROOT),
    ).toThrow(/out of scope/)
    // A `.`-segment in the middle still resolves into sourcedata/.
    expect(() =>
      planAiWrite('delete_file', { path: 'sourcedata/./x' }, ROOT),
    ).toThrow(/out of scope/)
    // Leading-slash variants are caught earlier as absolute paths.
    expect(() =>
      planAiWrite('delete_file', { path: '//sourcedata/x' }, ROOT),
    ).toThrow(/relative/)
  })
})

describe('planAiWrite — rename_entity', () => {
  it('plans a subject rename', () => {
    const plan = planAiWrite(
      'rename_entity',
      { entity: 'sub', oldValue: 'ds01', newValue: 'control01' },
      ROOT,
    )
    expect(plan).toMatchObject({
      kind: 'rename',
      entity: 'sub',
      oldValue: 'ds01',
      newValue: 'control01',
    })
  })

  it('rejects an unknown entity kind', () => {
    expect(() =>
      planAiWrite(
        'rename_entity',
        { entity: 'banana', oldValue: 'a', newValue: 'b' },
        ROOT,
      ),
    ).toThrow(/entity/)
  })

  it('rejects missing oldValue / newValue', () => {
    expect(() =>
      planAiWrite('rename_entity', { entity: 'sub', newValue: 'b' }, ROOT),
    ).toThrow(/oldValue/)
    expect(() =>
      planAiWrite('rename_entity', { entity: 'sub', oldValue: 'a' }, ROOT),
    ).toThrow(/newValue/)
  })

  it('points an empty-newValue rename at remove_entity', () => {
    expect(() =>
      planAiWrite(
        'rename_entity',
        { entity: 'ses', oldValue: 'A', newValue: '' },
        ROOT,
      ),
    ).toThrow(/remove_entity/)
  })
})

describe('planAiWrite — remove_entity', () => {
  it('plans an entity removal', () => {
    const plan = planAiWrite('remove_entity', { entity: 'ses' }, ROOT)
    expect(plan).toMatchObject({ kind: 'remove-entity', entity: 'ses' })
  })

  it('rejects an unknown / sub entity', () => {
    expect(() =>
      planAiWrite('remove_entity', { entity: 'banana' }, ROOT),
    ).toThrow(/entity/)
  })
})

describe('planAiWrite — unwired', () => {
  it('rejects a genuinely unknown tool', () => {
    expect(() => planAiWrite('make_coffee', { x: 1 }, ROOT)).toThrow(
      /not wired/,
    )
  })
})
