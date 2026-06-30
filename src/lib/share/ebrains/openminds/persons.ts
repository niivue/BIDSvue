/**
 * Author-name parser for openMINDS `Person` nodes.
 *
 * BIDS' `dataset_description.json#Authors` is a free-form string list
 * — typical values are `"Russell A. Poldrack"`, `"Trepel C."`, or
 * `"Tom S.M."`. openMINDS' `Person` shape splits the name into
 * `givenName` (first name + middle), `familyName` (last name),
 * and optional `alternateNames` (nicknames in parentheses).
 *
 * The upstream `bids2openminds/main.py:create_openminds_person` uses
 * the Python `nameparser.HumanName` library which has heavy heuristics
 * for academic / military / multi-part names. We port the subset that
 * matters for BIDS Authors:
 *
 *   - Standard "First Last" → `{given: "First", family: "Last"}`
 *   - "First Middle Last" → `{given: "First Middle", family: "Last"}`
 *   - "Last, First" (comma-flipped) → `{given: "First", family: "Last"}`
 *   - "Last, First Middle" → `{given: "First Middle", family: "Last"}`
 *   - "First (Nickname) Last" → `{given: "First", family: "Last", alternateNames: ["Nickname"]}`
 *   - "OneName" alone → `{given: "OneName", family: ""}` (we treat single
 *     tokens as given-name only; ORCID datasets often have these
 *     for collective authors like "ABCD Consortium")
 *
 * The upstream rejects names with non-word characters in the given
 * or family fields via the regex
 * `^[\w'\-, .][^0-9_!¡?÷?¿/\\+=@#$%^&*(){}|~<>;:[\]]{1,}$` — we
 * apply the same guard so a garbage value in `Authors` doesn't
 * smuggle weird characters into the openMINDS payload.
 *
 * Ported in shape from `bids2openminds/main.py` (MIT) and the
 * relevant slices of the `nameparser` package — see NOTICE.md.
 */

export interface ParsedPersonName {
  givenName: string | null
  familyName: string | null
  /** Nickname extracted from "First (Nick) Last" parenthesised form. */
  alternateNames: string[] | null
}

/** Regex bbased on `bids2openminds/main.py:name_regex`. Rejects any
 * field containing digits, hash, parens (except as parsed-out
 * nicknames), and most punctuation. */
const NAME_FIELD_RE = /^[\w'\-, .][^0-9_!¡?÷?¿/\\+=@#$%^&*(){}|~<>;:[\]]{1,}$/

/** Parse a free-form author name into the openMINDS-friendly shape.
 * Returns `null` when the input is too garbled to safely emit a
 * Person node — the caller drops that author rather than uploading
 * a half-formed record. */
export function parsePersonName(raw: string): ParsedPersonName | null {
  const cleaned = raw.trim()
  if (cleaned === '') return null

  // Extract nicknames in parentheses first so they don't interfere
  // with the rest of the parsing.
  const nicknames: string[] = []
  const withoutNicks = cleaned.replace(/\(([^)]+)\)/g, (_match, inner) => {
    const n = String(inner).trim()
    if (n !== '') nicknames.push(n)
    return ' '
  })
  const normalised = withoutNicks.replace(/\s+/g, ' ').trim()
  if (normalised === '') return null

  let givenPart: string
  let familyPart: string

  // Comma-flipped "Last, First Middle" form.
  if (normalised.includes(',')) {
    const [familyRaw, ...rest] = normalised.split(',').map((s) => s.trim())
    familyPart = familyRaw ?? ''
    givenPart = rest.join(', ').trim()
  } else {
    // Space-separated "First Middle Last" form. Last whitespace-token
    // is the family name; the rest is given.
    const tokens = normalised.split(' ').filter(Boolean)
    if (tokens.length === 0) return null
    if (tokens.length === 1) {
      // Single token — treat as given-name only (matches the
      // upstream behaviour for consortium-style authors).
      return {
        givenName: tokens[0],
        familyName: null,
        alternateNames: nicknames.length > 0 ? nicknames : null,
      }
    }
    familyPart = tokens[tokens.length - 1] ?? ''
    givenPart = tokens.slice(0, -1).join(' ').trim()
  }

  // Apply the upstream name-field guard. A field that fails the
  // regex becomes null (the openMINDS shape lets the property be
  // absent) rather than smuggling weird chars into the payload.
  const given =
    givenPart !== '' && NAME_FIELD_RE.test(givenPart) ? givenPart : null
  const family =
    familyPart !== '' && NAME_FIELD_RE.test(familyPart) ? familyPart : null

  // Mirror the upstream rejection: if BOTH given and family are
  // empty after guarding, drop the author. The upstream additionally
  // drops the case "no usable given AND family is longer than 1
  // char with a 1-char given"; we keep that check simpler — if
  // either field survives, we emit the Person.
  if (given === null && family === null) return null

  return {
    givenName: given,
    familyName: family,
    alternateNames: nicknames.length > 0 ? nicknames : null,
  }
}
