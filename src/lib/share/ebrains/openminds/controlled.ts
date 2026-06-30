/**
 * openMINDS controlled-vocabulary maps for fields the BIDS metadata
 * doesn't provide directly — the user picks a value from a dropdown
 * and we resolve to the canonical EBRAINS instance IRI.
 *
 * Three vocabularies are covered:
 *   - `license` — content-licensing terms (CC-BY-4.0, CC0-1.0, MIT, …)
 *   - `accessibility` — `ProductAccessibility` (freeAccess, embargoedAccess, controlledAccess)
 *   - `ageCategory` — `AgeCategory` (adult, youngAdult, …) for SubjectState
 *
 * The instance IRIs use the `openminds.ebrains.eu` host rather than
 * `openminds.om-i.org` because that's the form the upstream
 * `bids2ebrains` patcher emits and the EBRAINS Knowledge Graph
 * accepts as canonical. We keep `om-i.org` for the type IRIs and
 * for the controlled vocabularies our scanner can derive directly
 * (species, biologicalSex, handedness, technique, etc.) because
 * those came from the `bids2openminds` reference output. Both
 * namespaces resolve in the KG; the inconsistency is an upstream
 * quirk we mirror rather than fix.
 *
 * Ported in shape from `bids2ebrains/mappings.py` (MIT) — see
 * NOTICE.md.
 */

/** Lower-case alphanumeric-only canonical form of a label, used as
 * the dictionary key for case-/punctuation-tolerant lookups. So
 * `"CC-BY 4.0"` and `"ccby40"` and `"CCBY40"` all map to the same
 * entry. Matches the upstream `_norm()` helper. */
function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
}

const LICENSE_INSTANCES = {
  'CC-BY-4.0': 'https://openminds.ebrains.eu/instances/licenses/CC-BY-4.0',
  'CC-BY-3.0': 'https://openminds.ebrains.eu/instances/licenses/CC-BY-3.0',
  'CC-BY-2.0': 'https://openminds.ebrains.eu/instances/licenses/CC-BY-2.0',
  'CC-BY-SA-4.0':
    'https://openminds.ebrains.eu/instances/licenses/CC-BY-SA-4.0',
  'CC-BY-NC-4.0':
    'https://openminds.ebrains.eu/instances/licenses/CC-BY-NC-4.0',
  'CC-BY-ND-4.0':
    'https://openminds.ebrains.eu/instances/licenses/CC-BY-ND-4.0',
  'CC-BY-NC-SA-4.0':
    'https://openminds.ebrains.eu/instances/licenses/CC-BY-NC-SA-4.0',
  'CC-BY-NC-ND-4.0':
    'https://openminds.ebrains.eu/instances/licenses/CC-BY-NC-ND-4.0',
  'CC0-1.0': 'https://openminds.ebrains.eu/instances/licenses/CC0-1.0',
  MIT: 'https://openminds.ebrains.eu/instances/licenses/MIT',
  'Apache-2.0': 'https://openminds.ebrains.eu/instances/licenses/Apache-2.0',
  'BSD-2-Clause':
    'https://openminds.ebrains.eu/instances/licenses/BSD-2-Clause',
  'BSD-3-Clause':
    'https://openminds.ebrains.eu/instances/licenses/BSD-3-Clause',
  'GPL-3.0': 'https://openminds.ebrains.eu/instances/licenses/GPL-3.0',
} as const

const ACCESSIBILITY_INSTANCES = {
  freeAccess:
    'https://openminds.ebrains.eu/instances/productAccessibility/freeAccess',
  embargoedAccess:
    'https://openminds.ebrains.eu/instances/productAccessibility/embargoedAccess',
  controlledAccess:
    'https://openminds.ebrains.eu/instances/productAccessibility/controlledAccess',
} as const

const AGE_CATEGORY_INSTANCES = {
  adult: 'https://openminds.ebrains.eu/instances/ageCategory/adult',
  youngAdult: 'https://openminds.ebrains.eu/instances/ageCategory/youngAdult',
  primeAdult: 'https://openminds.ebrains.eu/instances/ageCategory/primeAdult',
  lateAdult: 'https://openminds.ebrains.eu/instances/ageCategory/lateAdult',
  adolescent: 'https://openminds.ebrains.eu/instances/ageCategory/adolescent',
  juvenile: 'https://openminds.ebrains.eu/instances/ageCategory/juvenile',
  infant: 'https://openminds.ebrains.eu/instances/ageCategory/infant',
  neonate: 'https://openminds.ebrains.eu/instances/ageCategory/neonate',
  perinatal: 'https://openminds.ebrains.eu/instances/ageCategory/perinatal',
  embryo: 'https://openminds.ebrains.eu/instances/ageCategory/embryo',
} as const

/** Public list of license labels the panel can render in a dropdown.
 * Order is from most-common to least-common (CC variants first). */
export const LICENSE_LABELS: ReadonlyArray<keyof typeof LICENSE_INSTANCES> = [
  'CC-BY-4.0',
  'CC0-1.0',
  'CC-BY-SA-4.0',
  'CC-BY-NC-4.0',
  'CC-BY-ND-4.0',
  'CC-BY-NC-SA-4.0',
  'CC-BY-NC-ND-4.0',
  'CC-BY-3.0',
  'CC-BY-2.0',
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'GPL-3.0',
]

export const ACCESSIBILITY_LABELS: ReadonlyArray<
  keyof typeof ACCESSIBILITY_INSTANCES
> = ['freeAccess', 'embargoedAccess', 'controlledAccess']

export const AGE_CATEGORY_LABELS: ReadonlyArray<
  keyof typeof AGE_CATEGORY_INSTANCES
> = [
  'adult',
  'youngAdult',
  'primeAdult',
  'lateAdult',
  'adolescent',
  'juvenile',
  'infant',
  'neonate',
  'perinatal',
  'embryo',
]

/** Resolve a free-form label to its canonical EBRAINS instance IRI.
 * Returns `null` when no match exists (the caller surfaces this as
 * a user-facing error rather than silently dropping the field). */
function buildNormalizedMap(
  table: Readonly<Record<string, string>>,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const [label, iri] of Object.entries(table)) {
    out.set(normalize(label), iri)
  }
  return out
}

const LICENSE_BY_NORM = buildNormalizedMap(LICENSE_INSTANCES)
const ACCESSIBILITY_BY_NORM = buildNormalizedMap(ACCESSIBILITY_INSTANCES)
const AGE_CATEGORY_BY_NORM = buildNormalizedMap(AGE_CATEGORY_INSTANCES)

export function resolveLicenseIri(label: string): string | null {
  return LICENSE_BY_NORM.get(normalize(label)) ?? null
}

export function resolveAccessibilityIri(label: string): string | null {
  return ACCESSIBILITY_BY_NORM.get(normalize(label)) ?? null
}

export function resolveAgeCategoryIri(label: string): string | null {
  return AGE_CATEGORY_BY_NORM.get(normalize(label)) ?? null
}
