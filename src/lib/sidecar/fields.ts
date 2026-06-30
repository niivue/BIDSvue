// Pure helpers used by the sidecar form-view widgets.
//
// Two responsibilities:
//
// 1. Convert between in-memory JSON values and the strings the
//    form's <input> / <textarea> elements work with. The form view
//    binds inputs via local string state and pushes parsed values
//    back into the in-memory sidecar tree on commit (input blur or
//    Enter), so each widget needs a `format`/`parse` pair that
//    knows about the field's type.
//
// 2. List the keys present in a parsed sidecar that don't appear in
//    any of the schema's known-field lists. The form view renders
//    those under an "Unknown" section so users can see and edit
//    fields the schema doesn't acknowledge (custom tooling output,
//    vendor extensions, deprecated names).
//
// Pure / synchronous / no DOM. Tests in fields.test.ts cover each
// parse path and the unknown-keys derivation.

import type { FieldSpec, SidecarFieldsResult } from '$lib/schema/types'

/**
 * Render a parsed JSON value as the string the corresponding form
 * widget should display. Per type:
 *
 *   - `string`: the value as-is. `null` → empty string (treated as
 *     "no value").
 *   - `number` / `integer`: `String(value)`. Falls back to empty
 *     string when the value isn't a finite number.
 *   - `boolean`: not used (checkboxes use `checked`, not value text).
 *   - `array` / `object` / `unknown`: pretty-printed JSON. Newlines
 *     fit naturally in a `<textarea>`.
 *
 * Tries to mirror what the user typed for round-trip stability:
 * `"2"` stays `"2"`, not `"2.0"`, on a number field with value `2`.
 */
export function valueToInputString(value: unknown, spec: FieldSpec): string {
  if (value === undefined) return ''
  if (spec.type === 'string') {
    return value === null ? '' : String(value)
  }
  if (spec.type === 'number' || spec.type === 'integer') {
    if (typeof value === 'number' && Number.isFinite(value))
      return String(value)
    return ''
  }
  if (spec.type === 'boolean') {
    // Caller uses `checked`; this path is reachable only if a non-
    // checkbox UI is rendering a boolean — surface the literal so
    // the user sees it.
    return value === true ? 'true' : value === false ? 'false' : ''
  }
  // Compound + unknown: JSON pretty-print so the textarea reads.
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return ''
  }
}

/** Result of attempting to parse a widget string back to a JSON value. */
export type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

/**
 * Parse a string from an input back into the JSON value type the
 * field's FieldSpec calls for. Returns `{ok: false, error}` so the
 * widget can surface a per-field error chip without throwing.
 *
 * Per type:
 *
 *   - `string`: empty string → `null` (the field is unset). Any other
 *     string is taken verbatim.
 *   - `number`: empty → `null`. `parseFloat` + finite-check; otherwise
 *     error. Bounds (`minimum`, `maximum`, `exclusiveMinimum`,
 *     `exclusiveMaximum`) are validated here so the widget can flag
 *     out-of-range entries.
 *   - `integer`: same as number, plus `Number.isInteger`.
 *   - `boolean`: parseable from the literal strings `"true"`/`"false"`.
 *     Empty → `null`.
 *   - `array` / `object` / `unknown`: `JSON.parse`. Empty → `null`.
 */
export function inputStringToValue(raw: string, spec: FieldSpec): ParseResult {
  const trimmed = raw.trim()
  if (spec.type === 'string') {
    if (trimmed === '') return { ok: true, value: null }
    return { ok: true, value: raw }
  }
  if (spec.type === 'number' || spec.type === 'integer') {
    if (trimmed === '') return { ok: true, value: null }
    const n = Number(trimmed)
    if (!Number.isFinite(n)) {
      return { ok: false, error: `${trimmed} is not a number` }
    }
    if (spec.type === 'integer' && !Number.isInteger(n)) {
      return { ok: false, error: 'expected an integer' }
    }
    const rangeError = checkRange(n, spec)
    if (rangeError !== null) return { ok: false, error: rangeError }
    return { ok: true, value: n }
  }
  if (spec.type === 'boolean') {
    if (trimmed === '') return { ok: true, value: null }
    if (trimmed === 'true') return { ok: true, value: true }
    if (trimmed === 'false') return { ok: true, value: false }
    return { ok: false, error: 'expected "true" or "false"' }
  }
  // array / object / unknown — JSON-parse the textarea.
  if (trimmed === '') return { ok: true, value: null }
  try {
    const parsed = JSON.parse(raw)
    return { ok: true, value: parsed }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'invalid JSON',
    }
  }
}

function checkRange(n: number, spec: FieldSpec): string | null {
  if (typeof spec.minimum === 'number' && n < spec.minimum) {
    return `must be ≥ ${spec.minimum}`
  }
  if (typeof spec.maximum === 'number' && n > spec.maximum) {
    return `must be ≤ ${spec.maximum}`
  }
  if (typeof spec.exclusiveMinimum === 'number' && n <= spec.exclusiveMinimum) {
    return `must be > ${spec.exclusiveMinimum}`
  }
  if (typeof spec.exclusiveMaximum === 'number' && n >= spec.exclusiveMaximum) {
    return `must be < ${spec.exclusiveMaximum}`
  }
  return null
}

/**
 * Names of top-level fields that exist in the parsed sidecar value
 * but are not in any of the schema's required/recommended/optional/
 * deprecated lists for this context. Used to populate the "Unknown"
 * section so users can see and edit fields the schema doesn't model
 * (vendor extras, hand-added metadata).
 *
 * Operates on top-level keys only — nested-object fields stay inside
 * their owning field's widget.
 */
export function unknownFieldNames(
  parsedValue: unknown,
  schemaFields: SidecarFieldsResult,
): string[] {
  if (parsedValue === null || typeof parsedValue !== 'object') return []
  if (Array.isArray(parsedValue)) return []
  const known = new Set<string>()
  for (const e of schemaFields.required) known.add(e.spec.name)
  for (const e of schemaFields.recommended) known.add(e.spec.name)
  for (const e of schemaFields.optional) known.add(e.spec.name)
  for (const e of schemaFields.deprecated) known.add(e.spec.name)
  const out: string[] = []
  for (const key of Object.keys(parsedValue as Record<string, unknown>)) {
    if (!known.has(key)) out.push(key)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

/**
 * Infer a FieldSpec for an unknown-section field from its current
 * runtime value. Lets the form view route unknown fields to the
 * same widget shapes the schema-known ones use, instead of falling
 * straight to "JSON textarea" for everything.
 */
export function inferSpecFromValue(name: string, value: unknown): FieldSpec {
  let type: FieldSpec['type'] = 'unknown'
  if (typeof value === 'string') type = 'string'
  else if (typeof value === 'number')
    type = Number.isInteger(value) ? 'integer' : 'number'
  else if (typeof value === 'boolean') type = 'boolean'
  else if (Array.isArray(value)) type = 'array'
  else if (value !== null && typeof value === 'object') type = 'object'
  return {
    name,
    displayName: null,
    description: '',
    type,
  }
}
