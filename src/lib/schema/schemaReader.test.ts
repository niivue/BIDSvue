// Schema-reader tests against inline schema fixtures + a smoke pass
// against the real shipped schema. The inline fixtures cover the
// selector cases the reader recognises (suffix / datatype / modality /
// match-extension / intersects-suffix) plus the conditional fall-through
// for unknown selectors.

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BidsSchema } from './internalTypes'
import { fieldSpec, fieldsForSidecar } from './schemaReader'
import {
  buildDatatypeToModalityMap,
  parseSidecarContext,
} from './sidecarContext'
import type { SidecarContext } from './types'

const inlineSchema: BidsSchema = {
  schema_version: '0.0.0-test',
  rules: {
    sidecars: {
      mri: {
        // Unconditional: applies to every mri+.nii sidecar.
        MRIHardware: {
          selectors: ['modality == "mri"', 'match(extension, "^\\.json$")'],
          fields: {
            Manufacturer: 'recommended',
            DeviceSerialNumber: {
              level: 'recommended',
              description_addendum: 'corresponds to DICOM (0018, 1000)',
            },
            // Schema upgrade safety: a 'prohibited' field should silently
            // drop out of the editor (we only surface levels the editor
            // can render).
            DroppedField: 'optional',
          },
        },
        // Conditional on a sidecar field — the reader can't evaluate it.
        MTParameters: {
          selectors: ['sidecar.MTState == true'],
          fields: {
            MTOffsetFrequency: 'required',
          },
        },
        // Suffix-restricted: only applies when intersects([suffix], [...])
        // matches. Tests the intersects path.
        ASLOnly: {
          selectors: ['intersects([suffix], ["asl", "m0scan"])'],
          fields: {
            PCASLType: 'required',
          },
        },
        // Should not apply to T1w (suffix == "bold").
        FuncOnly: {
          selectors: ['suffix == "bold"'],
          fields: {
            TaskName: 'required',
          },
        },
      },
    },
    modalities: {
      mri: { datatypes: ['anat', 'func', 'perf'] },
      eeg: { datatypes: ['eeg'] },
    },
  },
  objects: {
    metadata: {
      Manufacturer: {
        name: 'Manufacturer',
        display_name: 'Manufacturer',
        description: 'Manufacturer of the equipment.',
        type: 'string',
      },
      DeviceSerialNumber: {
        name: 'DeviceSerialNumber',
        description: 'Serial number of the device.',
        type: 'string',
      },
      DroppedField: {
        name: 'DroppedField',
        description: 'never surfaces',
        type: 'string',
      },
      MTOffsetFrequency: {
        name: 'MTOffsetFrequency',
        description: 'MT offset in Hz.',
        type: 'number',
        unit: 'Hz',
      },
      PCASLType: {
        name: 'PCASLType',
        description: 'PCASL type.',
        type: 'string',
        enum: ['balanced', 'unbalanced'],
      },
      TaskName: {
        name: 'TaskName',
        description: 'Name of the task.',
        type: 'string',
      },
    },
  },
}

const t1wContext: SidecarContext = {
  suffix: 'T1w',
  datatype: 'anat',
  modality: 'mri',
  extension: '.json',
}

const aslContext: SidecarContext = {
  suffix: 'asl',
  datatype: 'perf',
  modality: 'mri',
  extension: '.json',
}

describe('fieldsForSidecar — selector evaluation', () => {
  test('returns unconditional fields when modality + extension match', () => {
    const result = fieldsForSidecar(t1wContext, inlineSchema)
    const names = result.recommended.map((e) => e.spec.name)
    expect(names).toContain('Manufacturer')
    expect(names).toContain('DeviceSerialNumber')
  })

  test('marks conditional-selector rules as conditional', () => {
    const result = fieldsForSidecar(t1wContext, inlineSchema)
    const mt = result.required.find((e) => e.spec.name === 'MTOffsetFrequency')
    expect(mt).toBeDefined()
    expect(mt?.conditional).toBe(true)
  })

  test('intersects([suffix], …) excludes non-matching suffixes', () => {
    const result = fieldsForSidecar(t1wContext, inlineSchema)
    expect(
      result.required.find((e) => e.spec.name === 'PCASLType'),
    ).toBeUndefined()
  })

  test('intersects([suffix], …) includes matching suffixes', () => {
    const result = fieldsForSidecar(aslContext, inlineSchema)
    const pcasl = result.required.find((e) => e.spec.name === 'PCASLType')
    expect(pcasl).toBeDefined()
    expect(pcasl?.conditional).toBe(false)
  })

  test('suffix == "X" rules are excluded for other suffixes', () => {
    const result = fieldsForSidecar(t1wContext, inlineSchema)
    expect(
      result.required.find((e) => e.spec.name === 'TaskName'),
    ).toBeUndefined()
  })

  test('drops fields whose metadata is missing from the schema', () => {
    const { Manufacturer: _stripped, ...metadataWithoutManufacturer } =
      inlineSchema.objects.metadata
    void _stripped
    const partial: BidsSchema = {
      ...inlineSchema,
      objects: {
        ...inlineSchema.objects,
        metadata: metadataWithoutManufacturer,
      },
    }
    const result = fieldsForSidecar(t1wContext, partial)
    expect(
      result.recommended.find((e) => e.spec.name === 'Manufacturer'),
    ).toBeUndefined()
  })

  test('sorts each level alphabetically by field name', () => {
    const result = fieldsForSidecar(t1wContext, inlineSchema)
    const names = result.recommended.map((e) => e.spec.name)
    const sorted = [...names].sort()
    expect(names).toEqual(sorted)
  })
})

describe('fieldsForSidecar — level resolution', () => {
  test('prefers stricter level when a field appears in multiple rules', () => {
    const schemaWithConflict: BidsSchema = {
      ...inlineSchema,
      rules: {
        ...inlineSchema.rules,
        sidecars: {
          mri: {
            ...inlineSchema.rules.sidecars.mri,
            // Mark Manufacturer as required here — should beat the
            // recommended level on MRIHardware.
            ExtraRule: {
              selectors: ['modality == "mri"', 'match(extension, "^\\.json$")'],
              fields: { Manufacturer: 'required' },
            },
          },
        },
      },
    }
    const result = fieldsForSidecar(t1wContext, schemaWithConflict)
    expect(
      result.required.find((e) => e.spec.name === 'Manufacturer'),
    ).toBeDefined()
    expect(
      result.recommended.find((e) => e.spec.name === 'Manufacturer'),
    ).toBeUndefined()
  })

  test('an unconditional rule promotes a previously-conditional field', () => {
    const schemaPromote: BidsSchema = {
      ...inlineSchema,
      rules: {
        ...inlineSchema.rules,
        sidecars: {
          mri: {
            // Conditional rule says Manufacturer is recommended.
            Conditional: {
              selectors: ['sidecar.MTState == true'],
              fields: { Manufacturer: 'recommended' },
            },
            // Unconditional rule should win — same level, but loses
            // its conditional flag.
            Unconditional: {
              selectors: ['modality == "mri"', 'match(extension, "^\\.json$")'],
              fields: { Manufacturer: 'recommended' },
            },
          },
        },
      },
    }
    const result = fieldsForSidecar(t1wContext, schemaPromote)
    const man = result.recommended.find((e) => e.spec.name === 'Manufacturer')
    expect(man).toBeDefined()
    expect(man?.conditional).toBe(false)
  })
})

describe('fieldSpec', () => {
  test('converts a metadata entry to FieldSpec', () => {
    const spec = fieldSpec('PCASLType', inlineSchema)
    expect(spec?.name).toBe('PCASLType')
    expect(spec?.type).toBe('string')
    expect(spec?.enum).toEqual(['balanced', 'unbalanced'])
  })

  test('returns null for an unknown field name', () => {
    expect(fieldSpec('TotallyUnknown', inlineSchema)).toBeNull()
  })
})

describe('parseSidecarContext', () => {
  test('parses an anat sidecar into context', () => {
    const ctx = parseSidecarContext(
      '/d/sub-01/anat/sub-01_T1w.json',
      inlineSchema,
    )
    expect(ctx).toEqual({
      suffix: 'T1w',
      datatype: 'anat',
      modality: 'mri',
      extension: '.json',
    })
  })

  test('returns null for a dataset-level JSON outside a datatype folder', () => {
    expect(
      parseSidecarContext('/d/dataset_description.json', inlineSchema),
    ).toBeNull()
  })

  test('returns null for non-JSON files', () => {
    expect(
      parseSidecarContext('/d/sub-01/anat/sub-01_T1w.nii.gz', inlineSchema),
    ).toBeNull()
  })

  test('returns null when the parent dir is not a known datatype', () => {
    expect(
      parseSidecarContext('/d/sub-01/weird/sub-01_T1w.json', inlineSchema),
    ).toBeNull()
  })
})

describe('buildDatatypeToModalityMap', () => {
  test('inverts modalities.<mod>.datatypes correctly', () => {
    const map = buildDatatypeToModalityMap(inlineSchema)
    expect(map.get('anat')).toBe('mri')
    expect(map.get('perf')).toBe('mri')
    expect(map.get('eeg')).toBe('eeg')
    expect(map.size).toBe(4)
  })
})

// --- smoke test against the real schema, if the offline-built static
// asset is present. Skipped in environments where the bundle hasn't been
// generated (a freshly cloned worktree without postinstall would land
// here). We test high-confidence facts only: SliceTiming is recommended
// for mri 2D acquisitions; Manufacturer is recommended on mri sidecars.

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const realSchemaPath = resolve(repoRoot, 'static', '_validator.schema.json')

describe.if(existsSync(realSchemaPath))(
  'schema smoke test (real BIDS schema)',
  () => {
    const realSchema = JSON.parse(
      readFileSync(realSchemaPath, 'utf8'),
    ) as BidsSchema

    test('Manufacturer surfaces as recommended on an mri sidecar', () => {
      const result = fieldsForSidecar(t1wContext, realSchema)
      const man = result.recommended.find((e) => e.spec.name === 'Manufacturer')
      expect(man).toBeDefined()
    })

    test('SliceTiming surfaces on an mri sidecar', () => {
      // The rule is conditional on MRAcquisitionType == "2D", so the reader
      // should mark it conditional rather than dropping it.
      const result = fieldsForSidecar(t1wContext, realSchema)
      const all = [
        ...result.required,
        ...result.recommended,
        ...result.optional,
      ]
      const st = all.find((e) => e.spec.name === 'SliceTiming')
      expect(st).toBeDefined()
      expect(st?.conditional).toBe(true)
    })

    test('PCASLType surfaces (conditionally) for asl sidecars', () => {
      // PCASLType's rule (rules.sidecars.asl.MRIASLPcaslSpecific) is
      // recommended-level and conditional on
      // sidecar.ArterialSpinLabelingType == "PCASL"; the reader should
      // surface it with conditional=true so the form view can mark it.
      const result = fieldsForSidecar(aslContext, realSchema)
      const all = [
        ...result.required,
        ...result.recommended,
        ...result.optional,
      ]
      const pc = all.find((e) => e.spec.name === 'PCASLType')
      expect(pc).toBeDefined()
      expect(pc?.conditional).toBe(true)
      expect(pc?.spec.enum).toEqual(['balanced', 'unbalanced'])
    })
  },
)
