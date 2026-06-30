import { describe, expect, test } from 'bun:test'
import { parseFilename } from './entities'
import {
  type BatchPattern,
  findMatchingPaths,
  matchesPattern,
  patternFromFilename,
} from './match'
import type { Dataset, FileNode, NodeFlags } from './types'

function parse(name: string) {
  return parseFilename(name)
}

describe('patternFromFilename', () => {
  test('captures all entities as literals', () => {
    const p = patternFromFilename(parse('sub-crlab_task-smt_run-02_bold.json'))
    expect(p.entities).toEqual([
      { key: 'sub', value: 'crlab' },
      { key: 'task', value: 'smt' },
      { key: 'run', value: '02' },
    ])
    expect(p.suffix).toBe('bold')
    expect(p.extension).toBe('.json')
  })

  test('preserves canonical entity order from the parsed filename', () => {
    const p = patternFromFilename(
      parse('sub-01_ses-1_task-rest_run-01_bold.json'),
    )
    expect(p.entities.map((e) => e.key)).toEqual(['sub', 'ses', 'task', 'run'])
  })
})

describe('matchesPattern — entity matching', () => {
  const source = parse('sub-crlab_task-smt_run-02_bold.json')
  const literalPattern = patternFromFilename(source)

  test('all-literal matches only the exact source filename', () => {
    expect(matchesPattern(source, literalPattern)).toBe(true)
    expect(
      matchesPattern(
        parse('sub-emmet_task-smt_run-02_bold.json'),
        literalPattern,
      ),
    ).toBe(false)
  })

  test('wildcarding sub matches files with the same task/run', () => {
    const pattern: BatchPattern = {
      ...literalPattern,
      entities: [
        { key: 'sub', value: null },
        { key: 'task', value: 'smt' },
        { key: 'run', value: '02' },
      ],
    }
    expect(
      matchesPattern(parse('sub-emmet_task-smt_run-02_bold.json'), pattern),
    ).toBe(true)
    expect(
      matchesPattern(parse('sub-emmet_task-smt_run-03_bold.json'), pattern),
    ).toBe(false)
    expect(
      matchesPattern(parse('sub-emmet_task-rest_run-02_bold.json'), pattern),
    ).toBe(false)
  })

  test('wildcarding suffix matches any suffix with the same entity set', () => {
    const pattern: BatchPattern = {
      ...literalPattern,
      suffix: null,
    }
    expect(
      matchesPattern(parse('sub-crlab_task-smt_run-02_events.json'), pattern),
    ).toBe(true)
    expect(
      matchesPattern(parse('sub-crlab_task-smt_run-02_bold.json'), pattern),
    ).toBe(true)
  })
})

describe('matchesPattern — entity-set rules', () => {
  const literalPattern = patternFromFilename(
    parse('sub-crlab_task-smt_run-02_bold.json'),
  )

  test('rejects candidates with extra entities', () => {
    // Extra session entity → different set → no match, even if every
    // pattern-known entity matches.
    expect(
      matchesPattern(
        parse('sub-crlab_ses-01_task-smt_run-02_bold.json'),
        literalPattern,
      ),
    ).toBe(false)
  })

  test('rejects candidates missing one of the pattern entities', () => {
    expect(
      matchesPattern(parse('sub-crlab_task-smt_bold.json'), literalPattern),
    ).toBe(false)
  })

  test('rejects candidates with different entity keys', () => {
    // task-smt + ses-01 vs the source's task-smt + run-02 — same size,
    // different set.
    expect(
      matchesPattern(parse('sub-crlab_ses-01_task-smt_bold.json'), {
        ...literalPattern,
        entities: [
          { key: 'sub', value: null },
          { key: 'task', value: null },
          { key: 'run', value: null },
        ],
      }),
    ).toBe(false)
  })
})

describe('matchesPattern — broad mode (extraEntitiesAllowed)', () => {
  const sourcePattern = patternFromFilename(parse('sub-01_T1w.json'))

  test('with suffix wildcarded, matches files that have additional entities', () => {
    const pattern: BatchPattern = {
      ...sourcePattern,
      suffix: null,
      extraEntitiesAllowed: true,
    }
    expect(
      matchesPattern(parse('sub-01_dir-AP_run-01_epi.json'), pattern),
    ).toBe(true)
    expect(
      matchesPattern(
        parse('sub-01_task-rest_acq-dualecho_run-01_echo-1_bold.json'),
        pattern,
      ),
    ).toBe(true)
    expect(matchesPattern(parse('sub-01_T1w.json'), pattern)).toBe(true)
  })

  test('literal entities still filter (sub-01 stays scoped to subject 01)', () => {
    const pattern: BatchPattern = {
      ...sourcePattern,
      suffix: null,
      extraEntitiesAllowed: true,
    }
    expect(matchesPattern(parse('sub-02_task-rest_bold.json'), pattern)).toBe(
      false,
    )
  })

  test('with every entity wildcarded, still excludes entity-less orphans', () => {
    // The wildcard semantic in broad mode is "key must be present, any
    // value" — without it, `dataset_description.json` (zero entities)
    // would match every relaxed pattern.
    const pattern: BatchPattern = {
      entities: [{ key: 'sub', value: null }],
      suffix: null,
      extension: '.json',
      extraEntitiesAllowed: true,
    }
    expect(matchesPattern(parse('dataset_description.json'), pattern)).toBe(
      false,
    )
    // But files that DO have the wildcarded entity (any value) match.
    expect(matchesPattern(parse('sub-99_T1w.json'), pattern)).toBe(true)
    expect(matchesPattern(parse('sub-99_task-rest_bold.json'), pattern)).toBe(
      true,
    )
  })

  test('extension match still enforced in broad mode', () => {
    const pattern: BatchPattern = {
      ...sourcePattern,
      suffix: null,
      extraEntitiesAllowed: true,
    }
    expect(matchesPattern(parse('sub-01_T1w.nii'), pattern)).toBe(false)
    expect(matchesPattern(parse('sub-01_scans.tsv'), pattern)).toBe(false)
  })
})

describe('matchesPattern — ignored entities (tri-state)', () => {
  // Regression: starting from a bold-anchored pattern (sub, ses, task,
  // run) and wildcarding every entity still excluded anat sidecars
  // because broad-mode wildcards require the key to be PRESENT.
  // Cycling each chip past wildcard into "ignored" drops the key check
  // entirely, so the bold source can broadcast to every sidecar.
  test('broad mode + every entity ignored matches any same-suffix sidecar', () => {
    const pattern: BatchPattern = {
      entities: [
        { key: 'sub', value: null, ignored: true },
        { key: 'ses', value: null, ignored: true },
        { key: 'task', value: null, ignored: true },
        { key: 'run', value: null, ignored: true },
      ],
      suffix: null,
      extension: '.json',
      extraEntitiesAllowed: true,
    }
    expect(matchesPattern(parse('sub-01_ses-1_run-01_T1w.json'), pattern)).toBe(
      true,
    )
    expect(
      matchesPattern(parse('sub-01_ses-1_task-rest_run-01_bold.json'), pattern),
    ).toBe(true)
    expect(matchesPattern(parse('sub-01_acq-mp2_T2w.json'), pattern)).toBe(true)
    // Entity-less orphan also matches once every entity is ignored —
    // expected for "match all sidecars" semantics.
    expect(matchesPattern(parse('dataset_description.json'), pattern)).toBe(
      true,
    )
  })

  test('broad mode + only some entities ignored keeps other key checks', () => {
    // Ignore `task` but require `sub` to be present. anat sidecars (no
    // task) match; orphans without sub do not.
    const pattern: BatchPattern = {
      entities: [
        { key: 'sub', value: null },
        { key: 'task', value: null, ignored: true },
      ],
      suffix: null,
      extension: '.json',
      extraEntitiesAllowed: true,
    }
    expect(matchesPattern(parse('sub-01_T1w.json'), pattern)).toBe(true)
    expect(matchesPattern(parse('sub-01_task-rest_bold.json'), pattern)).toBe(
      true,
    )
    expect(matchesPattern(parse('dataset_description.json'), pattern)).toBe(
      false,
    )
  })

  test('narrow mode: ignored keys are tolerated as candidate extras but not required', () => {
    // Pattern derived from a bold sidecar (4 entities), with `task`
    // ignored. The candidate may have task or omit it; the other three
    // entity keys must be exactly present.
    const pattern: BatchPattern = {
      entities: [
        { key: 'sub', value: null },
        { key: 'ses', value: null },
        { key: 'task', value: null, ignored: true },
        { key: 'run', value: null },
      ],
      suffix: 'bold',
      extension: '.json',
    }
    // Candidate has task: matches (task is tolerated as ignored extra).
    expect(
      matchesPattern(parse('sub-01_ses-1_task-rest_run-01_bold.json'), pattern),
    ).toBe(true)
    // Candidate omits task: also matches (ignored = optional).
    expect(
      matchesPattern(parse('sub-01_ses-1_run-01_bold.json'), pattern),
    ).toBe(true)
    // Candidate adds an unknown non-ignored extra (acq): rejected in
    // narrow mode.
    expect(
      matchesPattern(
        parse('sub-01_ses-1_acq-x_task-rest_run-01_bold.json'),
        pattern,
      ),
    ).toBe(false)
  })

  test('literal value on a non-ignored entity still filters under ignored siblings', () => {
    // Make sure ignored entries don't accidentally relax literal-value
    // checks elsewhere in the pattern.
    const pattern: BatchPattern = {
      entities: [
        { key: 'sub', value: '01' },
        { key: 'task', value: null, ignored: true },
      ],
      suffix: null,
      extension: '.json',
      extraEntitiesAllowed: true,
    }
    expect(matchesPattern(parse('sub-01_task-rest_bold.json'), pattern)).toBe(
      true,
    )
    expect(matchesPattern(parse('sub-02_task-rest_bold.json'), pattern)).toBe(
      false,
    )
  })
})

describe('matchesPattern — extension and suffix', () => {
  const literalPattern = patternFromFilename(parse('sub-X_T1w.json'))

  test('rejects mismatched extension', () => {
    expect(matchesPattern(parse('sub-X_T1w.tsv'), literalPattern)).toBe(false)
  })

  test('extension match is case-insensitive', () => {
    expect(matchesPattern(parse('sub-X_T1w.JSON'), literalPattern)).toBe(true)
  })

  test('rejects mismatched literal suffix', () => {
    expect(matchesPattern(parse('sub-X_T2w.json'), literalPattern)).toBe(false)
  })
})

describe('findMatchingPaths — scope filter', () => {
  // Minimal dataset stub: only the byPath index is consulted.
  function makeFile(path: string, flags: NodeFlags = {}): FileNode {
    const name = path.split('/').pop() ?? ''
    const parsed = parseFilename(name)
    return {
      kind: 'file',
      path,
      name,
      entities: parsed.entities,
      suffix: parsed.suffix,
      extension: parsed.extension,
      flags,
    }
  }
  function makeDataset(...files: FileNode[]): Dataset {
    const byPath = new Map<string, FileNode>()
    for (const f of files) byPath.set(f.path, f)
    return {
      root: '/ds',
      // The other fields are not read by findMatchingPaths; cast keeps
      // the test light.
      index: {
        byPath,
        bySubject: new Map(),
        bySubjectSession: new Map(),
        bySuffix: new Map(),
      },
    } as unknown as Dataset
  }

  const raw = makeFile('/ds/sub-01/anat/sub-01_T1w.json')
  const sibling = makeFile('/ds/sub-02/anat/sub-02_T1w.json')
  const inDerivatives = makeFile(
    '/ds/derivatives/mriqc/sub-01/anat/sub-01_T1w.json',
    { specialFolder: 'derivatives' },
  )
  const inBidsui = makeFile('/ds/.bidsvue/originals/op-1/sub-01_T1w.json', {
    specialFolder: 'bidsvue',
  })
  const ignored = makeFile('/ds/sub-01/anat/sub-01_T1w.json.bak', {
    bidsIgnored: true,
  })
  const pattern: BatchPattern = {
    entities: [{ key: 'sub', value: null }],
    suffix: 'T1w',
    extension: '.json',
  }

  test('without sourcePath, matches every same-shape file regardless of scope', () => {
    const ds = makeDataset(raw, sibling, inDerivatives, inBidsui)
    expect(findMatchingPaths(ds, pattern)).toEqual([
      inBidsui.path,
      inDerivatives.path,
      raw.path,
      sibling.path,
    ])
  })

  test('with a raw sourcePath, excludes derivatives and .bidsvue siblings', () => {
    const ds = makeDataset(raw, sibling, inDerivatives, inBidsui)
    expect(findMatchingPaths(ds, pattern, raw.path)).toEqual([
      raw.path,
      sibling.path,
    ])
  })

  test('with a derivatives sourcePath, only derivative siblings remain', () => {
    const otherDeriv = makeFile(
      '/ds/derivatives/mriqc/sub-02/anat/sub-02_T1w.json',
      { specialFolder: 'derivatives' },
    )
    const ds = makeDataset(raw, sibling, inDerivatives, otherDeriv)
    expect(findMatchingPaths(ds, pattern, inDerivatives.path)).toEqual([
      inDerivatives.path,
      otherDeriv.path,
    ])
  })

  test('bidsIgnored siblings are excluded from a non-ignored source', () => {
    const pat: BatchPattern = {
      entities: [{ key: 'sub', value: 'X' }],
      suffix: 'T1w',
      extension: '.json',
    }
    const xRaw = makeFile('/ds/sub-X/anat/sub-X_T1w.json')
    const ds = makeDataset(xRaw, ignored)
    expect(findMatchingPaths(ds, pat, xRaw.path)).toEqual([xRaw.path])
  })

  test('datatype=null and suffix=null matches sidecars across classes and modalities', () => {
    const source = makeFile('/ds/sub-crlab/anat/sub-crlab_T1w.json')
    const dwi = makeFile('/ds/sub-crlab/dwi/sub-crlab_acq-AP_dwi.json')
    const epi = makeFile('/ds/sub-crlab/fmap/sub-crlab_dir-AP_run-01_epi.json')
    const bold = makeFile(
      '/ds/sub-crlab/func/sub-crlab_task-rest_run-01_bold.json',
    )
    const ds = makeDataset(source, dwi, epi, bold)
    const pat: BatchPattern = {
      entities: [{ key: 'sub', value: null }],
      suffix: null,
      datatype: null,
      extension: '.json',
      extraEntitiesAllowed: true,
    }
    expect(findMatchingPaths(ds, pat, source.path)).toEqual([
      source.path,
      dwi.path,
      epi.path,
      bold.path,
    ])
  })

  test('datatype literal with suffix wildcard stays inside one class', () => {
    const t1w = makeFile('/ds/sub-01/anat/sub-01_T1w.json')
    const t2w = makeFile('/ds/sub-02/anat/sub-02_T2w.json')
    const dwi = makeFile('/ds/sub-01/dwi/sub-01_acq-AP_dwi.json')
    const ds = makeDataset(t1w, t2w, dwi)
    const pat: BatchPattern = {
      entities: [{ key: 'sub', value: null }],
      suffix: null,
      datatype: 'anat',
      extension: '.json',
      extraEntitiesAllowed: true,
    }
    expect(findMatchingPaths(ds, pat, t1w.path)).toEqual([t1w.path, t2w.path])
  })

  test('datatype literal with suffix literal matches one class and one modality', () => {
    const t1w = makeFile('/ds/sub-01/anat/sub-01_T1w.json')
    const t2w = makeFile('/ds/sub-02/anat/sub-02_T2w.json')
    const dwiT1w = makeFile('/ds/sub-03/dwi/sub-03_T1w.json')
    const ds = makeDataset(t1w, t2w, dwiT1w)
    const pat: BatchPattern = {
      entities: [{ key: 'sub', value: null }],
      suffix: 'T1w',
      datatype: 'anat',
      extension: '.json',
      extraEntitiesAllowed: true,
    }
    expect(findMatchingPaths(ds, pat, t1w.path)).toEqual([t1w.path])
  })
})
