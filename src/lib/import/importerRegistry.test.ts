import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ImporterConfig,
  type ImporterField,
  type ImporterReader,
  allowsEmptyDatasetName,
  findImporterConfig,
  hidesDatasetNameField,
  isFieldHidden,
  loadImporters,
  toolProducesLocator,
} from './importerRegistry'

const RESOURCE_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'resources',
  'common',
  'importers',
)

/** Reader that maps relative names directly to the on-disk resources/ tree. */
const diskReader: ImporterReader = {
  async readJson(name) {
    return JSON.parse(await readFile(join(RESOURCE_DIR, name), 'utf8'))
  },
}

describe('loadImporters (against the real bundled JSON)', () => {
  test('loads the manifest + dcm2niix-reproin + heudiconv + dcm2bids + ezbids-meg + pet2bids configs', async () => {
    const configs = await loadImporters(diskReader)
    expect(configs).toHaveLength(6)
    expect(configs[0].id).toBe('dcm2niix-reproin')
    expect(configs[0].label).toBe('dcm2niix (reproin)')
    expect(configs[0].binary).toBe('dcm2niix')
    // Bundled sidecar — no `external` block in JSON.
    expect(configs[0].external).toBeUndefined()
    expect(configs[1].id).toBe('heudiconv')
    expect(configs[1].binary).toBe('heudiconv')
    expect(configs[1].external?.installHint).toContain('pip install heudiconv')
    expect(configs[2].id).toBe('dcm2bids')
    expect(configs[2].binary).toBe('dcm2bids')
    // Bundled sidecar — no `external` block in JSON. The dcm2bids
    // descriptor's `installHint` carries the unsupported-platform
    // guidance (rendered from `ImportTool.installHint` in Import.svelte).
    expect(configs[2].external).toBeUndefined()
    // ezBIDS MEG: pure-TS converter (no `external` block, even though
    // it isn't a shell sidecar -- the kind discriminant lives in
    // `tools.ts`, not in the manifest JSON).
    expect(configs[3].id).toBe('ezbids-meg')
    expect(configs[3].label).toBe('ezBIDS MEG')
    expect(configs[3].binary).toBe('ezbids-meg')
    expect(configs[3].external).toBeUndefined()
    // pet2bids: reuses the bundled dcm2niix binary plus the M12
    // BIDSvue-side PET enricher post-pass.
    expect(configs[4].id).toBe('pet2bids')
    expect(configs[4].label).toBe('pet2bids')
    expect(configs[4].binary).toBe('dcm2niix')
    expect(configs[4].external).toBeUndefined()
    // mne-bids: external-environment-backed (local Python mne-bids).
    expect(configs[5].id).toBe('mne-bids')
    expect(configs[5].label).toBe('MNE-BIDS')
    expect(configs[5].external?.installHint).toContain('pip install mne-bids')
  })

  test('mne-bids fields: subject/task required + powerLineFrequency number (raw file is the wizard source picker, not a manifest field)', async () => {
    const configs = await loadImporters(diskReader)
    const mne = configs.find((c) => c.id === 'mne-bids')
    expect(mne).toBeDefined()
    const byKey = (k: string) => mne?.fields.find((f) => f.key === k)
    expect(byKey('subject')?.required).toBe(true)
    expect(byKey('task')?.required).toBe(true)
    expect(byKey('powerLineFrequency')?.type).toBe('number')
    // The raw file is selected via the wizard's source picker (srcDir),
    // not a manifest field — so the form has no rawFile/filePath field.
    expect(byKey('rawFile')).toBeUndefined()
  })

  test('pet2bids fields: subject(req) / session / anonymize / petMetadataPath', async () => {
    const configs = await loadImporters(diskReader)
    const pet2bids = configs.find((c) => c.id === 'pet2bids')
    expect(pet2bids).toBeDefined()
    const fields = pet2bids?.fields ?? []
    expect(fields.map((f) => f.key)).toEqual([
      'subject',
      'session',
      'anonymize',
      'petMetadataPath',
    ])
    const byKey = new Map(fields.map((f) => [f.key, f]))
    expect(byKey.get('subject')?.required).toBe(true)
    expect(byKey.get('subject')?.type).toBe('bidsLabel')
    expect(byKey.get('session')?.required).toBeUndefined()
    expect(byKey.get('anonymize')?.type).toBe('boolean')
    // Default matches reproinx.py / dcm2niix `-ba o`: strip PII while
    // preserving AcquisitionDateTime. Unified with dcm2niix-reproin's
    // default in the audit 2026-05-20 follow-up bundle so users see
    // the same toggle semantics across both importers.
    expect(byKey.get('anonymize')?.default).toBe(false)
    expect(byKey.get('petMetadataPath')?.type).toBe('filePath')
    expect(byKey.get('petMetadataPath')?.required).toBeUndefined()
    expect(byKey.get('petMetadataPath')?.extensions).toEqual(['json'])
    // pet2bids opts the Dataset name field into "visible but optional":
    // empty lands the import directly inside the picked "Save in" folder
    // so adding a subject to an existing dataset is one less keystroke.
    expect(pet2bids?.datasetNameOptional).toBe(true)
    expect(pet2bids?.allowEmptyDatasetName).toBeUndefined()
  })

  test('ezbids-meg fields: subject(req) / session / task(req) / acquisition / run / powerLineFrequency', async () => {
    const configs = await loadImporters(diskReader)
    const fields = configs[3].fields
    expect(fields.map((f) => f.key)).toEqual([
      'subject',
      'session',
      'task',
      'acquisition',
      'run',
      'powerLineFrequency',
    ])
    const byKey = new Map(fields.map((f) => [f.key, f]))
    expect(byKey.get('subject')?.required).toBe(true)
    expect(byKey.get('task')?.required).toBe(true)
    expect(byKey.get('session')?.required).toBeUndefined()
    expect(byKey.get('task')?.type).toBe('bidsLabel')
    expect(byKey.get('powerLineFrequency')?.type).toBe('number')
    expect(byKey.get('powerLineFrequency')?.default).toBe(0)
  })

  test('dcm2niix-reproin fields: anonymize / saveDerivatives (subject + session intentionally absent)', async () => {
    // `projectName` was removed M10-F -- folder name is the
    // dataset_description.json Name; users who want a different
    // Name edit the sidecar after import. `saveDerivatives` landed
    // with the v1.0.20260515 dcm2niix bump.
    // `subject` + `session` were removed in the 2026-05-19 sweep:
    // dcm2niix-reproin's `-f %H` always derives subject from
    // PatientID and session from ProtocolName per-study, so any
    // user-supplied `-bi` / `-bv` would override the derivation and
    // collapse a multi-PatientID DICOM tree onto one `sub-X`.
    const configs = await loadImporters(diskReader)
    const fields = configs[0].fields
    expect(fields.map((f) => f.key)).toEqual([
      'anonymize',
      'saveDerivatives',
      'shiftDates',
    ])
    const byKey = new Map(fields.map((f) => [f.key, f]))
    expect(byKey.get('subject')).toBeUndefined()
    expect(byKey.get('session')).toBeUndefined()
    expect(byKey.get('anonymize')?.type).toBe('boolean')
    // Default matches reproinx.py / dcm2niix `-ba o`: strip PII while
    // preserving AcquisitionDateTime + provenance demographics so the
    // post-pass can populate participants.tsv.
    expect(byKey.get('anonymize')?.default).toBe(false)
    expect(byKey.get('saveDerivatives')?.type).toBe('boolean')
    expect(byKey.get('saveDerivatives')?.default).toBe(false)
    expect(byKey.get('shiftDates')?.type).toBe('boolean')
    expect(byKey.get('shiftDates')?.default).toBe(false)
    // dcm2niix-reproin accepts an empty Dataset name: dcm2niix's `-f %H`
    // argv creates a <StudyDescription>/ subfolder under -o.
    expect(configs[0].allowEmptyDatasetName).toBe(true)
    // Help text on every field; the wizard renders it as a tooltip.
    for (const f of fields) {
      expect(f.help?.length ?? 0).toBeGreaterThan(0)
    }
  })

  test('heudiconv fields: heuristic / subject / session (no anonymize)', async () => {
    // heudiconv's --anon-cmd takes an external script, not a y/n flag,
    // so the descriptor intentionally omits the anonymize field. The
    // `heuristic` field defaults to "reproin" but accepts any built-in
    // name or absolute .py path; rendered with a Browse… button.
    const configs = await loadImporters(diskReader)
    const fields = configs[1].fields
    expect(fields.map((f) => f.key)).toEqual([
      'heuristic',
      'subject',
      'session',
    ])
    const byKey = new Map(fields.map((f) => [f.key, f]))
    expect(byKey.get('heuristic')?.type).toBe('heuristic')
    expect(byKey.get('heuristic')?.default).toBe('reproin')
  })

  test('dcm2bids fields: required subject + config (filePath) + cleanupUnmatched (default true)', async () => {
    // dcm2bids needs both subject (-p) and config (-c) to run; the
    // wizard's `unfilledRequiredFields` blocks Run until they're set.
    // `--auto_extract_entities` is intentionally not exposed — it
    // silently corrupts entity labels when the config also defines
    // custom_entities (see buildDcm2bidsArgv docstring).
    // `cleanupUnmatched` defaults true so the imported tree is
    // BIDS-valid; off keeps the tmp_dcm2bids/ working dir for
    // debugging.
    const configs = await loadImporters(diskReader)
    const fields = configs[2].fields
    expect(fields.map((f) => f.key)).toEqual([
      'subject',
      'session',
      'config',
      'cleanupUnmatched',
    ])
    const byKey = new Map(fields.map((f) => [f.key, f]))
    expect(byKey.get('subject')?.required).toBe(true)
    expect(byKey.get('config')?.required).toBe(true)
    expect(byKey.get('config')?.type).toBe('filePath')
    expect(byKey.get('config')?.extensions).toEqual(['json'])
    expect(byKey.get('cleanupUnmatched')?.type).toBe('boolean')
    expect(byKey.get('cleanupUnmatched')?.default).toBe(true)
  })

  test('findImporterConfig returns the matching config', async () => {
    const configs = await loadImporters(diskReader)
    expect(findImporterConfig('dcm2niix-reproin', configs).id).toBe(
      'dcm2niix-reproin',
    )
  })

  test('findImporterConfig throws on unknown id', async () => {
    const configs = await loadImporters(diskReader)
    expect(() =>
      findImporterConfig('heudiconv-future' as never, configs),
    ).toThrow(/no config for "heudiconv-future"/)
  })
})

// ----- runtime validation --------------------------------------------------

function makeReader(files: Record<string, unknown>): ImporterReader {
  return {
    async readJson(name) {
      if (!(name in files)) {
        throw new Error(`reader: not found: ${name}`)
      }
      return files[name]
    },
  }
}

describe('loadImporters validation', () => {
  test('rejects non-object manifest', async () => {
    await expect(
      loadImporters(makeReader({ 'manifest.json': 'oops' })),
    ).rejects.toThrow(/expected an object/)
  })

  test('rejects manifest with non-number version', async () => {
    await expect(
      loadImporters(
        makeReader({ 'manifest.json': { version: '1', importers: [] } }),
      ),
    ).rejects.toThrow(/`version` must be a number/)
  })

  test('rejects manifest with non-array importers', async () => {
    await expect(
      loadImporters(
        makeReader({ 'manifest.json': { version: 1, importers: 'x' } }),
      ),
    ).rejects.toThrow(/`importers` must be an array/)
  })

  test('rejects config whose id does not match manifest entry', async () => {
    await expect(
      loadImporters(
        makeReader({
          'manifest.json': { version: 1, importers: ['dcm2niix-reproin'] },
          'dcm2niix-reproin.json': {
            id: 'wrong-id',
            label: 'x',
            description: 'y',
            binary: 'b',
            fields: [],
          },
        }),
      ),
    ).rejects.toThrow(/id field "wrong-id" does not match/)
  })

  test('rejects field whose default does not match type', async () => {
    await expect(
      loadImporters(
        makeReader({
          'manifest.json': { version: 1, importers: ['dcm2niix-reproin'] },
          'dcm2niix-reproin.json': {
            id: 'dcm2niix-reproin',
            label: 'x',
            description: 'y',
            binary: 'b',
            fields: [
              {
                key: 'anonymize',
                label: 'Anonymize',
                type: 'boolean',
                default: 'true', // string, not boolean
              },
            ],
          },
        }),
      ),
    ).rejects.toThrow(/default for boolean must be a boolean/)
  })

  test('rejects external block that is not an object', async () => {
    await expect(
      loadImporters(
        makeReader({
          'manifest.json': { version: 1, importers: ['dcm2niix-reproin'] },
          'dcm2niix-reproin.json': {
            id: 'dcm2niix-reproin',
            label: 'x',
            description: 'y',
            binary: 'b',
            external: 'install via pip',
            fields: [],
          },
        }),
      ),
    ).rejects.toThrow(/external must be an object/)
  })

  test('rejects external block missing installHint', async () => {
    await expect(
      loadImporters(
        makeReader({
          'manifest.json': { version: 1, importers: ['dcm2niix-reproin'] },
          'dcm2niix-reproin.json': {
            id: 'dcm2niix-reproin',
            label: 'x',
            description: 'y',
            binary: 'b',
            external: {},
            fields: [],
          },
        }),
      ),
    ).rejects.toThrow(/installHint/)
  })

  test('rejects unknown field type', async () => {
    await expect(
      loadImporters(
        makeReader({
          'manifest.json': { version: 1, importers: ['dcm2niix-reproin'] },
          'dcm2niix-reproin.json': {
            id: 'dcm2niix-reproin',
            label: 'x',
            description: 'y',
            binary: 'b',
            fields: [
              {
                key: 'mystery',
                label: 'Mystery',
                type: 'date',
                default: '',
              },
            ],
          },
        }),
      ),
    ).rejects.toThrow(/type "date" not in/)
  })

  test('rejects field key that does not match the slug regex', async () => {
    await expect(
      loadImporters(
        makeReader({
          'manifest.json': { version: 1, importers: ['dcm2niix-reproin'] },
          'dcm2niix-reproin.json': {
            id: 'dcm2niix-reproin',
            label: 'x',
            description: 'y',
            binary: 'b',
            fields: [
              {
                key: '../escape',
                label: 'Bad',
                type: 'string',
                default: '',
              },
            ],
          },
        }),
      ),
    ).rejects.toThrow(/must match/)
  })

  test('rejects field key that is a reserved Object property', async () => {
    await expect(
      loadImporters(
        makeReader({
          'manifest.json': { version: 1, importers: ['dcm2niix-reproin'] },
          'dcm2niix-reproin.json': {
            id: 'dcm2niix-reproin',
            label: 'x',
            description: 'y',
            binary: 'b',
            fields: [
              {
                key: 'constructor',
                label: 'Bad',
                type: 'string',
                default: '',
              },
            ],
          },
        }),
      ),
    ).rejects.toThrow(/reserved Object property/)
  })

  test('rejects filePath extension that is not alphanumeric', async () => {
    await expect(
      loadImporters(
        makeReader({
          'manifest.json': { version: 1, importers: ['dcm2niix-reproin'] },
          'dcm2niix-reproin.json': {
            id: 'dcm2niix-reproin',
            label: 'x',
            description: 'y',
            binary: 'b',
            fields: [
              {
                key: 'config',
                label: 'Config',
                type: 'filePath',
                default: '',
                extensions: ['../etc/passwd'],
              },
            ],
          },
        }),
      ),
    ).rejects.toThrow(/must match/)
  })
})

describe('allowsEmptyDatasetName', () => {
  const staticAllow: ImporterConfig = {
    id: 'dcm2niix-reproin',
    label: 'dcm2niix (reproin)',
    description: '',
    binary: 'dcm2niix',
    fields: [],
    allowEmptyDatasetName: true,
  }
  const heudiconvConfig: ImporterConfig = {
    id: 'heudiconv',
    label: 'heudiconv',
    description: '',
    binary: 'heudiconv',
    fields: [
      {
        key: 'heuristic',
        label: 'Heuristic',
        type: 'heuristic',
        default: 'reproin',
      },
    ],
  }
  const dcm2bidsConfig: ImporterConfig = {
    id: 'dcm2bids',
    label: 'dcm2bids',
    description: '',
    binary: 'dcm2bids',
    fields: [],
  }

  test('static allowEmptyDatasetName: true wins regardless of values', () => {
    expect(allowsEmptyDatasetName('dcm2niix-reproin', staticAllow, {})).toBe(
      true,
    )
  })

  test('heudiconv with reproin heuristic allows empty (heudiconv-reproin scaffolds locator)', () => {
    expect(
      allowsEmptyDatasetName('heudiconv', heudiconvConfig, {
        heuristic: 'reproin',
      }),
    ).toBe(true)
  })

  test('heudiconv with convertall / other built-in heuristics requires a name', () => {
    for (const h of [
      'convertall',
      'bids_with_ses',
      'cmrr_heuristic',
      'example',
    ]) {
      expect(
        allowsEmptyDatasetName('heudiconv', heudiconvConfig, { heuristic: h }),
      ).toBe(false)
    }
  })

  test('heudiconv with a custom .py heuristic path defaults to requiring a name', () => {
    expect(
      allowsEmptyDatasetName('heudiconv', heudiconvConfig, {
        heuristic: '/Users/me/my_heuristic.py',
      }),
    ).toBe(false)
  })

  test('non-heudiconv tools without the static flag require a name', () => {
    expect(allowsEmptyDatasetName('dcm2bids', dcm2bidsConfig, {})).toBe(false)
  })

  test('null config falls back to requiring a name', () => {
    expect(allowsEmptyDatasetName('heudiconv', null, {})).toBe(false)
  })

  test('datasetNameOptional: true allows empty (pet2bids opt-in)', () => {
    const optional: ImporterConfig = {
      id: 'pet2bids',
      label: 'pet2bids',
      description: '',
      binary: 'dcm2niix',
      fields: [],
      datasetNameOptional: true,
    }
    expect(allowsEmptyDatasetName('pet2bids', optional, {})).toBe(true)
  })
})

describe('hidesDatasetNameField', () => {
  test('allowEmptyDatasetName: true hides the field (tool generates locator)', () => {
    const hide: ImporterConfig = {
      id: 'dcm2niix-reproin',
      label: 'dcm2niix (reproin)',
      description: '',
      binary: 'dcm2niix',
      fields: [],
      allowEmptyDatasetName: true,
    }
    expect(hidesDatasetNameField('dcm2niix-reproin', hide, {})).toBe(true)
  })

  test('heudiconv with reproin heuristic hides the field', () => {
    const heudiconv: ImporterConfig = {
      id: 'heudiconv',
      label: 'heudiconv',
      description: '',
      binary: 'heudiconv',
      fields: [],
    }
    expect(
      hidesDatasetNameField('heudiconv', heudiconv, { heuristic: 'reproin' }),
    ).toBe(true)
  })

  test('datasetNameOptional: true does NOT hide the field (pet2bids keeps it visible)', () => {
    const optional: ImporterConfig = {
      id: 'pet2bids',
      label: 'pet2bids',
      description: '',
      binary: 'dcm2niix',
      fields: [],
      datasetNameOptional: true,
    }
    expect(hidesDatasetNameField('pet2bids', optional, {})).toBe(false)
  })

  test('default (neither flag set) leaves the field visible', () => {
    const plain: ImporterConfig = {
      id: 'dcm2bids',
      label: 'dcm2bids',
      description: '',
      binary: 'dcm2bids',
      fields: [],
    }
    expect(hidesDatasetNameField('dcm2bids', plain, {})).toBe(false)
  })
})

describe('isFieldHidden', () => {
  const subjectField: ImporterField = {
    key: 'subject',
    label: 'Subject ID',
    type: 'bidsLabel',
    default: '',
  }
  const sessionField: ImporterField = {
    key: 'session',
    label: 'Session',
    type: 'bidsLabel',
    default: '',
  }
  const heuristicField: ImporterField = {
    key: 'heuristic',
    label: 'Heuristic',
    type: 'heuristic',
    default: 'reproin',
  }

  test('heudiconv + reproin hides subject + session (heuristic derives both)', () => {
    expect(
      isFieldHidden('heudiconv', subjectField, { heuristic: 'reproin' }),
    ).toBe(true)
    expect(
      isFieldHidden('heudiconv', sessionField, { heuristic: 'reproin' }),
    ).toBe(true)
  })

  test('heudiconv + reproin keeps the heuristic field visible', () => {
    expect(
      isFieldHidden('heudiconv', heuristicField, { heuristic: 'reproin' }),
    ).toBe(false)
  })

  test('heudiconv with a non-reproin built-in heuristic keeps subject + session visible (-s required)', () => {
    for (const h of [
      'convertall',
      'bids_with_ses',
      'cmrr_heuristic',
      'example',
    ]) {
      expect(isFieldHidden('heudiconv', subjectField, { heuristic: h })).toBe(
        false,
      )
      expect(isFieldHidden('heudiconv', sessionField, { heuristic: h })).toBe(
        false,
      )
    }
  })

  test('heudiconv with a custom .py keeps subject + session visible when detection result is null (not probed / read failed)', () => {
    expect(
      isFieldHidden(
        'heudiconv',
        subjectField,
        { heuristic: '/Users/me/my_heuristic.py' },
        null,
      ),
    ).toBe(false)
    expect(
      isFieldHidden(
        'heudiconv',
        sessionField,
        { heuristic: '/Users/me/my_heuristic.py' },
        null,
      ),
    ).toBe(false)
  })

  test('heudiconv with a custom .py + detected infotoids hides subject + session', () => {
    expect(
      isFieldHidden(
        'heudiconv',
        subjectField,
        { heuristic: '/Users/me/my_heuristic.py' },
        true,
      ),
    ).toBe(true)
    expect(
      isFieldHidden(
        'heudiconv',
        sessionField,
        { heuristic: '/Users/me/my_heuristic.py' },
        true,
      ),
    ).toBe(true)
  })

  test('heudiconv with a custom .py + positively-no-infotoids keeps subject + session visible', () => {
    expect(
      isFieldHidden(
        'heudiconv',
        subjectField,
        { heuristic: '/Users/me/my_heuristic.py' },
        false,
      ),
    ).toBe(false)
    expect(
      isFieldHidden(
        'heudiconv',
        sessionField,
        { heuristic: '/Users/me/my_heuristic.py' },
        false,
      ),
    ).toBe(false)
  })

  test('Windows-style backslash path is treated as a path for the infotoids gate', () => {
    expect(
      isFieldHidden(
        'heudiconv',
        subjectField,
        { heuristic: 'C:\\Users\\me\\heuristic.py' },
        true,
      ),
    ).toBe(true)
  })

  test('detection result is ignored when heuristic is a built-in name (only the reproin branch applies)', () => {
    expect(
      isFieldHidden(
        'heudiconv',
        subjectField,
        { heuristic: 'convertall' },
        true,
      ),
    ).toBe(false)
  })

  test('non-heudiconv tools never hide via this helper (their manifests already omit if not needed)', () => {
    expect(isFieldHidden('dcm2niix-reproin', subjectField, {})).toBe(false)
    expect(isFieldHidden('dcm2bids', subjectField, {})).toBe(false)
  })
})

describe('toolProducesLocator', () => {
  test('dcm2niix-reproin: always true (-f %H derives per study)', () => {
    expect(toolProducesLocator('dcm2niix-reproin', {})).toBe(true)
    expect(toolProducesLocator('dcm2niix-reproin', {}, true)).toBe(true)
    expect(toolProducesLocator('dcm2niix-reproin', {}, false)).toBe(true)
  })

  test('heudiconv + reproin heuristic: true regardless of detection result', () => {
    expect(
      toolProducesLocator('heudiconv', { heuristic: 'reproin' }, null),
    ).toBe(true)
    expect(
      toolProducesLocator('heudiconv', { heuristic: 'reproin' }, false),
    ).toBe(true)
  })

  test('heudiconv + non-reproin built-in: false (no infotoids in those heuristics)', () => {
    for (const h of [
      'convertall',
      'bids_with_ses',
      'cmrr_heuristic',
      'example',
    ]) {
      expect(toolProducesLocator('heudiconv', { heuristic: h })).toBe(false)
    }
  })

  test('heudiconv + custom .py with detected infotoids: true', () => {
    expect(
      toolProducesLocator(
        'heudiconv',
        { heuristic: '/Users/me/my_heuristic.py' },
        true,
      ),
    ).toBe(true)
  })

  test('heudiconv + custom .py without detected infotoids: false (conservative)', () => {
    expect(
      toolProducesLocator(
        'heudiconv',
        { heuristic: '/Users/me/my_heuristic.py' },
        false,
      ),
    ).toBe(false)
    expect(
      toolProducesLocator(
        'heudiconv',
        { heuristic: '/Users/me/my_heuristic.py' },
        null,
      ),
    ).toBe(false)
  })

  test('Windows-style backslash path with detected infotoids: true', () => {
    expect(
      toolProducesLocator(
        'heudiconv',
        { heuristic: 'C:\\Users\\me\\heuristic.py' },
        true,
      ),
    ).toBe(true)
  })

  test('dcm2bids / pet2bids / ezbids-meg: always false (no locator)', () => {
    expect(toolProducesLocator('dcm2bids', {})).toBe(false)
    expect(toolProducesLocator('pet2bids', {})).toBe(false)
    expect(toolProducesLocator('ezbids-meg', {})).toBe(false)
  })
})
