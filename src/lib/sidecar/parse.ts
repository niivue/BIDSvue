// JSON sidecar parse/serialize with key-order + format + literal
// preservation.
//
// The M4 editor needs to read a sidecar, let the user mutate one or
// more fields, and write it back so the diff against the original is
// just the changed field's value — the M4 acceptance criterion at
// decisions/M4-sidecar-editor.md.
//
// Approach:
//
// 1. `parseSidecar(text)` calls `JSON.parse` to get the value tree,
//    then walks the source text alongside the tree to record:
//       - the raw source slice for every value (scalar or compound),
//         keyed by JSON Pointer (`/EchoTime`, `/SliceTiming/0`, ...);
//       - the parsed value at every scalar path (for change detection).
//
// 2. `serializeSidecar(value, format)` recursively renders the value:
//       - For each path, check whether the in-memory value is
//         *structurally* equal to the parsed-at-parse-time value.
//         If yes, emit the source's raw slice verbatim — preserving
//         scientific notation, trailing zeros, single-line vs
//         multi-line array layout, and any whitespace inside the
//         slice.
//       - If structurally different (the user edited something here
//         or a descendant), fall through to standard pretty-printed
//         output using the captured indent string.
//
// What this preserves:
//   - Key order on unchanged sub-trees (V8/JSC insertion-order
//     guarantee + raw-slice fallthrough).
//   - Scalar literal forms (`2.7e-06` stays `2.7e-06`, not
//     `0.0000027`; `2.0` stays `2.0`, not `2`).
//   - Array layout: dcm2niix emits `"SliceTiming": [0, 0.6825, ...]`
//     on one line and `"ImageType": [\n  "ORIGINAL",\n  ...\n]` on
//     multiple lines; the raw-slice path round-trips both.
//   - Indent style (2-space, 4-space, tabs) for any region we *do*
//     re-render (mutations + newly-added keys).
//   - Trailing newline.
//
// What this does NOT preserve:
//   - Comments (BIDS sidecars are strict JSON; validator rejects them).
//   - Whitespace on the modified path's siblings — if you edit
//     `EchoTime` in the middle of an object that has unusual spacing
//     between unrelated keys, the modified key's line uses the
//     captured indent and a normal `": "` separator. The siblings'
//     raw slices still preserve their formatting.
//   - Lossless string round-tripping is best-effort; `JSON.parse`
//     normalises `\uXXXX` escapes when the char is printable. For BIDS
//     sidecars that don't carry exotic strings this isn't a problem.
//
// The doc-comment on `M4 acceptance criteria` covers this: "preserves
// byte-for-byte structural equivalence outside the changed field."
// We preserve much more than that on the bytes the user *doesn't*
// touch; touched-bytes get re-rendered cleanly.

/** Opaque bookkeeping the serializer consumes; treat it as a black box. */
export interface SidecarFormat {
  /**
   * Indent string used by the source (e.g. `'  '`, `'    '`, `'\t'`).
   * `null` when the source has no indented lines.
   */
  indent: string | null
  /** True when the source ends with a `\n`. */
  trailingNewline: boolean
  /**
   * Raw text of every value in the source — scalar or compound —
   * keyed by JSON Pointer (`/`, `/EchoTime`, `/SliceTiming/0`,
   * `/nested/inner/a`). The empty-string key holds the whole document.
   */
  rawSlices: Map<string, string>
  /**
   * The parsed value at each path. Used for structural-equality
   * checks during render.
   */
  originalValues: Map<string, unknown>
}

export interface ParsedSidecar {
  /** The parsed value. For valid BIDS sidecars this is a plain object. */
  value: unknown
  format: SidecarFormat
}

/**
 * Parse a sidecar JSON string and capture formatting + raw-text
 * metadata. Throws `SyntaxError` on invalid JSON.
 */
export function parseSidecar(text: string): ParsedSidecar {
  const value = JSON.parse(text)
  // Independent snapshot. We walk this copy as the "original" so the
  // user's mutations to `value` don't bleed into the change-detection
  // map. `JSON.parse` twice on the same text gives us two trees with
  // identical scalars but disjoint compound references, which is
  // exactly what `structurallyEqual` needs.
  const snapshot = JSON.parse(text)
  const { rawSlices, originalValues } = scanValues(text, snapshot)
  return {
    value,
    format: {
      indent: detectIndent(text),
      trailingNewline: text.endsWith('\n'),
      rawSlices,
      originalValues,
    },
  }
}

/**
 * Detect the indent string used by the first indented line of `text`.
 * Returns `null` for single-line JSON or text with no leading
 * whitespace on any line.
 */
export function detectIndent(text: string): string | null {
  const lines = text.split('\n')
  for (const line of lines) {
    if (line.length === 0) continue
    const m = line.match(/^([ \t]+)\S/)
    if (m !== null) return m[1]
  }
  return null
}

/**
 * Serialize a sidecar value back to a string in the same format the
 * source used. Sub-trees structurally identical to the parsed source
 * re-emit verbatim; sub-trees containing edits fall through to
 * standard pretty-printed output using `format.indent`.
 *
 * Indent fallback: if `format.indent` is null (single-line source),
 * use 2-space.
 */
export function serializeSidecar(
  value: unknown,
  format: SidecarFormat,
): string {
  const indent = format.indent ?? '  '
  const body = renderValue(value, format, '', 0, indent)
  return format.trailingNewline ? `${body}\n` : body
}

// ---------- render ----------

function renderValue(
  value: unknown,
  format: SidecarFormat,
  path: string,
  depth: number,
  indent: string,
): string {
  // Raw-slice fast path: if the parsed value at this path is
  // structurally identical to what we recorded at parse time, just
  // emit the source bytes.
  const original = format.originalValues.get(path)
  if (format.originalValues.has(path) && structurallyEqual(original, value)) {
    const raw = format.rawSlices.get(path)
    if (raw !== undefined) return raw
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const outerPad = indent.repeat(depth)
    const innerPad = indent.repeat(depth + 1)
    const items = value.map((v, i) =>
      renderValue(v, format, `${path}/${i}`, depth + 1, indent),
    )
    return `[\n${items.map((it) => innerPad + it).join(',\n')}\n${outerPad}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    const outerPad = indent.repeat(depth)
    const innerPad = indent.repeat(depth + 1)
    const items = entries.map(([k, v]) => {
      const keyEncoded = JSON.stringify(k)
      const child = renderValue(
        v,
        format,
        `${path}/${escapePointer(k)}`,
        depth + 1,
        indent,
      )
      return `${innerPad}${keyEncoded}: ${child}`
    })
    return `{\n${items.join(',\n')}\n${outerPad}}`
  }
  return JSON.stringify(value as never)
}

/**
 * Structural deep-equal for JSON-shaped values. Used to decide
 * whether a sub-tree matches the source at parse time so the raw
 * slice can be re-emitted.
 *
 * Key order on objects matters: an object whose keys were reordered
 * by the editor should re-render with `JSON.stringify`'s key order
 * (which matches the in-memory order), not the source's. So
 * `Object.keys(a)[i] !== Object.keys(b)[i]` counts as a mismatch.
 */
function structurallyEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!structurallyEqual(a[i], b[i])) return false
    }
    return true
  }
  if (typeof a === 'object') {
    const ak = Object.keys(a as object)
    const bk = Object.keys(b as object)
    if (ak.length !== bk.length) return false
    for (let i = 0; i < ak.length; i++) {
      if (ak[i] !== bk[i]) return false
      if (
        !structurallyEqual(
          (a as Record<string, unknown>)[ak[i]],
          (b as Record<string, unknown>)[bk[i]],
        )
      )
        return false
    }
    return true
  }
  return false
}

/** RFC 6901 escape: `~` -> `~0`, `/` -> `~1`. */
function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1')
}

// ---------- scanner ----------

interface ScanResult {
  rawSlices: Map<string, string>
  originalValues: Map<string, unknown>
}

/**
 * Walk the source text alongside the parsed value tree, recording
 * (path -> raw slice) for every value and (path -> parsed value) for
 * every path. The scanner trusts that `JSON.parse` already validated
 * the input; it doesn't reject malformed JSON.
 */
function scanValues(text: string, root: unknown): ScanResult {
  const rawSlices = new Map<string, string>()
  const originalValues = new Map<string, unknown>()
  const cursor = { i: 0 }
  walk(text, cursor, root, '', rawSlices, originalValues)
  return { rawSlices, originalValues }
}

function walk(
  text: string,
  cursor: { i: number },
  value: unknown,
  path: string,
  rawSlices: Map<string, string>,
  originalValues: Map<string, unknown>,
): void {
  skipWhitespace(text, cursor)
  const start = cursor.i
  const ch = text[start]

  if (ch === '"') {
    consumeString(text, cursor)
    rawSlices.set(path, text.slice(start, cursor.i))
    originalValues.set(path, value)
    return
  }

  if (ch === '{') {
    cursor.i++ // skip {
    const obj = value as Record<string, unknown>
    skipWhitespace(text, cursor)
    if (text[cursor.i] === '}') {
      cursor.i++
      rawSlices.set(path, text.slice(start, cursor.i))
      originalValues.set(path, value)
      return
    }
    while (cursor.i < text.length) {
      skipWhitespace(text, cursor)
      const keyStart = cursor.i
      consumeString(text, cursor)
      const key = JSON.parse(text.slice(keyStart, cursor.i)) as string
      skipWhitespace(text, cursor)
      cursor.i++ // ':'
      walk(
        text,
        cursor,
        obj[key],
        `${path}/${escapePointer(key)}`,
        rawSlices,
        originalValues,
      )
      skipWhitespace(text, cursor)
      if (text[cursor.i] === ',') {
        cursor.i++
        continue
      }
      if (text[cursor.i] === '}') {
        cursor.i++
        rawSlices.set(path, text.slice(start, cursor.i))
        originalValues.set(path, value)
        return
      }
    }
    return
  }

  if (ch === '[') {
    cursor.i++ // skip [
    const arr = value as unknown[]
    skipWhitespace(text, cursor)
    if (text[cursor.i] === ']') {
      cursor.i++
      rawSlices.set(path, text.slice(start, cursor.i))
      originalValues.set(path, value)
      return
    }
    let idx = 0
    while (cursor.i < text.length) {
      walk(text, cursor, arr[idx], `${path}/${idx}`, rawSlices, originalValues)
      idx++
      skipWhitespace(text, cursor)
      if (text[cursor.i] === ',') {
        cursor.i++
        continue
      }
      if (text[cursor.i] === ']') {
        cursor.i++
        rawSlices.set(path, text.slice(start, cursor.i))
        originalValues.set(path, value)
        return
      }
    }
    return
  }

  // number / true / false / null
  while (cursor.i < text.length) {
    const c = text[cursor.i]
    if (
      c === ',' ||
      c === '}' ||
      c === ']' ||
      c === ' ' ||
      c === '\n' ||
      c === '\r' ||
      c === '\t'
    ) {
      break
    }
    cursor.i++
  }
  rawSlices.set(path, text.slice(start, cursor.i))
  originalValues.set(path, value)
}

function consumeString(text: string, cursor: { i: number }): void {
  cursor.i++ // opening quote
  while (cursor.i < text.length) {
    const c = text[cursor.i]
    if (c === '\\') {
      // Skip the escape's payload byte, but clamp so a malformed input
      // ending with a lone backslash (e.g. `"...\`) can't push the
      // cursor past `text.length` and silently exit the loop. The outer
      // `JSON.parse` would reject this input first today, but the
      // scanner is defence-in-depth — clamping here keeps the
      // invariant local rather than depending on a caller's validation.
      cursor.i = Math.min(cursor.i + 2, text.length)
      continue
    }
    if (c === '"') {
      cursor.i++
      return
    }
    cursor.i++
  }
}

function skipWhitespace(text: string, cursor: { i: number }): void {
  while (cursor.i < text.length) {
    const c = text[cursor.i]
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
      cursor.i++
      continue
    }
    return
  }
}
