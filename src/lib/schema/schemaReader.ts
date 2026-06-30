// Schema query layer used by the M4 sidecar editor.
//
// Two surfaces:
//
//   - `fieldsForSidecar(ctx, schema)` walks `rules.sidecars.*` and
//     returns the fields applicable to `ctx`, partitioned by level.
//     Rules whose selectors depend only on `(modality, datatype, suffix,
//     extension)` are evaluated; rules with selectors that need sidecar
//     values, dataset facts, or entity presence are still surfaced with
//     `conditional: true` so the form view can hint at them without
//     pretending they always apply. (Phase F will couple the editor to
//     the running validator's view of which conditionals actually fire.)
//
//   - `fieldSpec(name, schema)` looks up `objects.metadata.<name>` and
//     converts it to the `FieldSpec` shape the form widgets consume.
//
// The reader is pure: given a `BidsSchema` + a `SidecarContext`, the
// output is deterministic. Unit tests pass an inline schema fixture so
// they don't depend on the static asset being present.

import type {
  BidsSchema,
  SchemaFieldRule,
  SchemaMetadataDef,
  SchemaSidecarRule,
} from './internalTypes'
import type {
  FieldEntry,
  FieldLevel,
  FieldSpec,
  SidecarContext,
  SidecarFieldsResult,
} from './types'

/**
 * Aggregate the schema's sidecar rules for `ctx` into the four
 * level-partitioned lists the form view renders. Field-level conflicts
 * across rules (same field at different levels) resolve by precedence:
 * `required > recommended > optional > deprecated`. Unconditional rules
 * beat conditional rules at the same level.
 */
export function fieldsForSidecar(
  ctx: SidecarContext,
  schema: BidsSchema,
): SidecarFieldsResult {
  // Working map: field name -> chosen entry. Built up across the schema
  // walk; partitioned at the end.
  const chosen = new Map<string, FieldEntry>()

  for (const groupName of Object.keys(schema.rules.sidecars)) {
    const group = schema.rules.sidecars[groupName]
    for (const ruleName of Object.keys(group)) {
      const rule = group[ruleName]
      // Defensive: some entries under `rules.sidecars.derivatives.*` are
      // namespacing buckets (no `selectors`, no `fields`) that nest
      // further rule groups. The M4 form view doesn't try to surface
      // derivative-specific fields yet; skipping non-leaf entries keeps
      // the reader robust without recursing into shapes we haven't
      // committed to a UI for.
      if (
        rule === null ||
        typeof rule !== 'object' ||
        !Array.isArray((rule as SchemaSidecarRule).selectors) ||
        typeof (rule as SchemaSidecarRule).fields !== 'object'
      ) {
        continue
      }
      const match = evaluateRuleSelectors(rule, ctx)
      if (match.outcome === 'skip') continue

      for (const [fieldName, fieldRule] of Object.entries(rule.fields)) {
        const normalised = normaliseFieldRule(fieldRule)
        if (normalised === null) continue
        const spec = lookupFieldSpec(fieldName, schema)
        if (spec === null) continue

        const candidate: FieldEntry = {
          spec,
          level: normalised.level,
          levelAddendum: normalised.levelAddendum,
          descriptionAddendum: normalised.descriptionAddendum,
          conditional: match.outcome === 'conditional',
        }
        const previous = chosen.get(fieldName)
        if (previous === undefined || candidatePreferred(candidate, previous)) {
          chosen.set(fieldName, candidate)
        }
      }
    }
  }

  const out: SidecarFieldsResult = {
    required: [],
    recommended: [],
    optional: [],
    deprecated: [],
  }
  for (const entry of chosen.values()) out[entry.level].push(entry)
  for (const level of [
    'required',
    'recommended',
    'optional',
    'deprecated',
  ] as const) {
    out[level].sort((a, b) => a.spec.name.localeCompare(b.spec.name))
  }
  return out
}

/**
 * Convert `schema.objects.metadata.<name>` into the `FieldSpec` shape
 * the form widgets consume. Returns `null` for unknown names (the
 * caller can decide whether to fall back to a free-text input or
 * surface the unknown field in the editor's "Unknown" section).
 */
export function fieldSpec(name: string, schema: BidsSchema): FieldSpec | null {
  return lookupFieldSpec(name, schema)
}

// ---------- internals ----------

interface RuleMatch {
  outcome: 'apply' | 'conditional' | 'skip'
}

/**
 * Decide whether a rule applies, is conditional, or doesn't apply to
 * `ctx`. The validator has its own full selector evaluator (mini
 * expression language with comparison + intersection + match); we don't
 * recreate it. Instead we recognise the unconditional patterns the BIDS
 * schema actually uses and mark anything else as conditional.
 */
function evaluateRuleSelectors(
  rule: SchemaSidecarRule,
  ctx: SidecarContext,
): RuleMatch {
  let conditional = false
  for (const sel of rule.selectors) {
    const trimmed = sel.trim()
    const result = matchSelector(trimmed, ctx)
    if (result === 'false') return { outcome: 'skip' }
    if (result === 'conditional') conditional = true
  }
  return { outcome: conditional ? 'conditional' : 'apply' }
}

/**
 * Single-selector evaluator. Returns `true` when the selector is
 * unconditionally satisfied by the context, `false` when it's
 * unconditionally violated, and `conditional` when it depends on facts
 * the context doesn't carry (sidecar values, dataset modalities,
 * entity presence). Conservative on purpose — false positives would
 * hide fields the user should see; false conditionals just add a hint
 * badge.
 */
function matchSelector(
  selector: string,
  ctx: SidecarContext,
): 'true' | 'false' | 'conditional' {
  // `modality == "mri"` / `datatype == "anat"` / `suffix == "T1w"`
  const eq = selector.match(/^(\w+)\s*==\s*["']([^"']+)["']$/)
  if (eq !== null) {
    const [, key, value] = eq
    if (key === 'modality') return ctx.modality === value ? 'true' : 'false'
    if (key === 'datatype') return ctx.datatype === value ? 'true' : 'false'
    if (key === 'suffix') return ctx.suffix === value ? 'true' : 'false'
    if (key === 'extension') return ctx.extension === value ? 'true' : 'false'
    // `sidecar.X == ...`, `dataset.X == ...` — needs runtime data.
    return 'conditional'
  }

  // `intersects([suffix], ["asl", "m0scan"])` -> conditional unless we
  // recognise the LHS as a context field.
  const intersects = selector.match(
    /^intersects\(\s*\[(\w+)\]\s*,\s*\[([^\]]+)\]\s*\)$/,
  )
  if (intersects !== null) {
    const [, lhs, listRaw] = intersects
    const list = listRaw
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    if (lhs === 'suffix') return list.includes(ctx.suffix) ? 'true' : 'false'
    if (lhs === 'modality')
      return list.includes(ctx.modality) ? 'true' : 'false'
    if (lhs === 'datatype')
      return list.includes(ctx.datatype) ? 'true' : 'false'
    return 'conditional'
  }

  // `match(extension, "^\.nii(\.gz)?$")` — anchors the rule to a
  // *data file* extension, not the sidecar's. The validator runs these
  // rules against the primary file (e.g. the .nii.gz) and reads the
  // companion .json's content during evaluation. The sidecar editor is
  // editing that .json directly, so the rule's fields still belong in
  // the form view; treating the extension selector as always-satisfied
  // matches the user's mental model ("show me what should be in this
  // sidecar"). Schema rules that legitimately restrict to JSON-only
  // contexts use other selectors (suffix == "...") so we don't lose
  // them.
  if (/^match\(\s*extension\s*,/.test(selector)) {
    return 'true'
  }

  // `entities.chunk` (truthy check) / `sidecar.MTState == true` / etc.
  // Anything we don't recognise stays conditional rather than aborting
  // the rule outright; better to over-surface than miss fields.
  return 'conditional'
}

function normaliseFieldRule(rule: SchemaFieldRule): {
  level: FieldLevel
  levelAddendum?: string
  descriptionAddendum?: string
} | null {
  if (typeof rule === 'string') {
    if (
      rule === 'required' ||
      rule === 'recommended' ||
      rule === 'optional' ||
      rule === 'deprecated'
    ) {
      return { level: rule }
    }
    // Other shorthand values exist upstream (`"prohibited"`); the form
    // view drops them since "don't include this field" isn't an editor
    // affordance — the validator will flag it if present.
    return null
  }
  if (
    rule.level === 'required' ||
    rule.level === 'recommended' ||
    rule.level === 'optional' ||
    rule.level === 'deprecated'
  ) {
    return {
      level: rule.level,
      levelAddendum: rule.level_addendum,
      descriptionAddendum: rule.description_addendum,
    }
  }
  return null
}

const levelRank: Record<FieldLevel, number> = {
  required: 0,
  recommended: 1,
  optional: 2,
  deprecated: 3,
}

/**
 * Prefer the candidate when it has a stricter level, OR when its level
 * matches the previous but the previous was conditional and the
 * candidate is unconditional (so unconditional rules "promote" a
 * conditional shorter-level entry to a guaranteed appearance).
 */
function candidatePreferred(
  candidate: FieldEntry,
  previous: FieldEntry,
): boolean {
  if (levelRank[candidate.level] < levelRank[previous.level]) return true
  if (levelRank[candidate.level] > levelRank[previous.level]) return false
  if (previous.conditional && !candidate.conditional) return true
  return false
}

function lookupFieldSpec(name: string, schema: BidsSchema): FieldSpec | null {
  const def = schema.objects.metadata[name] as SchemaMetadataDef | undefined
  if (def === undefined) return null
  return {
    name: def.name ?? name,
    displayName: def.display_name ?? null,
    description: def.description ?? '',
    type: coerceType(def.type),
    enum: def.enum,
    unit: def.unit,
    items:
      def.items === undefined
        ? undefined
        : {
            ...def.items,
            type:
              def.items.type === undefined
                ? undefined
                : coerceType(def.items.type),
          },
    minimum: def.minimum,
    maximum: def.maximum,
    exclusiveMinimum: def.exclusiveMinimum,
    exclusiveMaximum: def.exclusiveMaximum,
  }
}

function coerceType(t: string | undefined): FieldSpec['type'] {
  switch (t) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'array':
    case 'object':
      return t
    default:
      return 'unknown'
  }
}
