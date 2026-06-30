#!/usr/bin/env bun
/**
 * Catalog drift detector. Three pass categories:
 *
 * 1. Source <-> en.json reference parity. Every static `$_('key')`
 *    reference in `src/**\/*.{svelte,ts}` must resolve to a key in
 *    `en.json`. Unused-key warnings surface keys we ship without a
 *    caller.
 * 2. Per-locale parity. Every additional catalog under
 *    `src/lib/i18n/locales/` (currently `pt.json`, `es.json`) must
 *    carry the same key set as `en.json`. Every key's value is
 *    parsed via `@formatjs/icu-messageformat-parser` — a translator
 *    who fat-fingers ICU syntax (`{n, plural, one {...} other {}}`
 *    → `{n, plural one #}`) fails the build instead of crashing at
 *    render time. The variable set produced by the parser is then
 *    compared against the English source; missing / extra
 *    `{placeholder}` names also fail the build.
 * 3. Lock-file parity. Every non-English key must have a matching
 *    entry in `translations.lock.json`, and the on-disk
 *    `review-summary.json` (consumed at runtime by the Preferences
 *    pane) must match the lock file's truth. Hand-editing the lock
 *    without regenerating the summary fails the build.
 *
 * Only static-string keys are recognised — by design. Dynamic keys
 * ($_(varName), $_(`prefix.${x}`)) bypass this check, and the rule is "don't".
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type MessageFormatElement,
  TYPE,
  parse as parseICU,
} from '@formatjs/icu-messageformat-parser'
import { Glob } from 'bun'
import {
  type CatalogJson,
  type Lock,
  type ReviewSummary,
  buildReviewSummary,
  flattenCatalog,
} from './_i18nLockUtils'

const SRC_GLOB = 'src/**/*.{svelte,ts}'
const LOCALES_DIR = 'src/lib/i18n/locales'
const SOURCE_CATALOG = 'en.json'
const LOCK_FILE = 'translations.lock.json'
const REVIEW_SUMMARY_FILE = 'review-summary.json'

const KEY_REGEX = /\$_\(\s*(['"])([a-zA-Z0-9_.-]+)\1/g

/**
 * Keys whose names are computed at runtime (e.g.
 * `messages.${scope === 'file' ? 'noneForFile' : ...}`). The static
 * regex above can't see them, so they're allowlisted here. Add a key
 * here only when its dynamic call site is checked into src/.
 */
const DYNAMIC_KEYS: ReadonlySet<string> = new Set([
  'messages.noneForFile',
  'messages.noneForGroup',
  'messages.noneForFolder',
  // Launch.svelte's drag-drop banner stores `{ key, values }` in
  // `dropError` and the template resolves via `$_(dropError.key, …)`
  // (so a locale change after the drop re-translates the message —
  // closes audit 2026-06-20 P3-1). The static regex can't see the
  // dynamic argument.
  'launch.dropError.multiple',
  'launch.dropError.rejected',
  // Import.svelte renders the MNE-BIDS MEG-extra rows from the
  // `mneExtraFiles` array, resolving `$_(ef.label)` / `$_(ef.placeholder)`
  // dynamically — the static regex can't follow the field access.
  'importWizard.mneEmptyRoomLabel',
  'importWizard.mneEmptyRoomPlaceholder',
  'importWizard.mneCalibrationLabel',
  'importWizard.mneCalibrationPlaceholder',
  'importWizard.mneCrosstalkLabel',
  'importWizard.mneCrosstalkPlaceholder',
  // M-AI6 default prompts library. `DEFAULT_PROMPTS` in
  // `src/lib/ai/prompts.ts` carries the keys as `labelKey` /
  // `bodyKey` fields; `AIWindow.svelte` resolves them via
  // `$_(entry.labelKey)` / `$_(entry.bodyKey)`. The static regex
  // can't follow the field access.
  'prompts.summarizeLabel',
  'prompts.summarizeBody',
  'prompts.runValidatorLabel',
  'prompts.runValidatorBody',
  'prompts.findMissingTaskNamesLabel',
  'prompts.findMissingTaskNamesBody',
  'prompts.cleanupStubSidecarsLabel',
  'prompts.cleanupStubSidecarsBody',
  'prompts.checkParticipantsLabel',
  'prompts.checkParticipantsBody',
  'prompts.renameSubjectLabel',
  'prompts.renameSubjectBody',
  'prompts.minimizeLabel',
  'prompts.minimizeBody',
  'prompts.findDatesLabel',
  'prompts.findDatesBody',
  'prompts.authorEventsLabel',
  'prompts.authorEventsBody',
])

/**
 * Walk every node in a parsed ICU AST and collect the names of
 * top-level argument references (`{n}`, `{n, plural, ...}`,
 * `{n, select, ...}`, `{n, number}` etc.). Recurses into plural /
 * select arms so a `{n, plural, one {# day} other {# days}}` adds
 * `n` only once, while `{count, plural, one {{name}!}}` adds both
 * `count` and `name`. The literal `#` placeholder inside plural arms
 * binds to the enclosing variable and doesn't need its own entry.
 */
function collectIcuVariables(elements: MessageFormatElement[]): Set<string> {
  const out = new Set<string>()
  walk(elements, out)
  return out
}

function walk(els: MessageFormatElement[], out: Set<string>): void {
  for (const el of els) {
    switch (el.type) {
      case TYPE.literal:
      case TYPE.pound:
      case TYPE.tag:
        break
      case TYPE.argument:
      case TYPE.number:
      case TYPE.date:
      case TYPE.time:
        out.add(el.value)
        break
      case TYPE.select:
      case TYPE.plural:
        out.add(el.value)
        for (const arm of Object.values(el.options)) {
          walk(arm.value, out)
        }
        break
    }
  }
}

interface IcuCheck {
  variables: Set<string>
  parseError: string | null
}

function analyzeIcu(value: string): IcuCheck {
  try {
    // `ignoreTag: true` keeps `<path>`, `<name>` etc. as literal text
    // — they're used in catalog strings as bash-doc-style placeholders
    // (e.g. `collab-<name>`, `datalad get -n <path>`) and not XML
    // tags. `requiresOtherClause: true` forces every plural / select
    // to define an `other` arm, which is what svelte-i18n expects at
    // render time.
    const ast = parseICU(value, {
      ignoreTag: true,
      requiresOtherClause: true,
    })
    return { variables: collectIcuVariables(ast), parseError: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { variables: new Set(), parseError: message }
  }
}

async function findReferencedKeys(): Promise<Map<string, string[]>> {
  const refs = new Map<string, string[]>()
  const glob = new Glob(SRC_GLOB)
  for await (const path of glob.scan({ cwd: process.cwd() })) {
    const content = await readFile(path, 'utf8')
    KEY_REGEX.lastIndex = 0
    let match: RegExpExecArray | null = KEY_REGEX.exec(content)
    while (match !== null) {
      const key = match[2] as string
      const list = refs.get(key) ?? []
      list.push(path)
      refs.set(key, list)
      match = KEY_REGEX.exec(content)
    }
  }
  return refs
}

async function listOtherLocales(): Promise<string[]> {
  const entries = await readdir(LOCALES_DIR, { withFileTypes: true })
  const out: string[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    if (!e.name.endsWith('.json')) continue
    if (e.name === SOURCE_CATALOG) continue
    if (e.name === LOCK_FILE) continue
    if (e.name === REVIEW_SUMMARY_FILE) continue
    out.push(e.name)
  }
  out.sort()
  return out
}

interface PlaceholderMismatch {
  key: string
  missing: string[]
  extra: string[]
}

interface IcuParseFailure {
  key: string
  message: string
}

interface LocaleParityReport {
  missing: string[]
  extra: string[]
  placeholderMismatch: PlaceholderMismatch[]
  icuParseFailures: IcuParseFailure[]
}

async function checkLocaleParity(
  localeFile: string,
  english: Map<string, string>,
  englishIcu: Map<string, IcuCheck>,
): Promise<LocaleParityReport> {
  const raw = await readFile(join(LOCALES_DIR, localeFile), 'utf8')
  const parsed = JSON.parse(raw) as CatalogJson
  const flat = flattenCatalog(parsed)
  const missing: string[] = []
  const extra: string[] = []
  const placeholderMismatch: PlaceholderMismatch[] = []
  const icuParseFailures: IcuParseFailure[] = []
  for (const key of english.keys()) {
    if (!flat.has(key)) missing.push(key)
  }
  for (const key of flat.keys()) {
    if (!english.has(key)) extra.push(key)
  }
  for (const [key, enIcu] of englishIcu) {
    const localValue = flat.get(key)
    if (localValue === undefined) continue
    const localIcu = analyzeIcu(localValue)
    if (localIcu.parseError !== null) {
      icuParseFailures.push({ key, message: localIcu.parseError })
      continue
    }
    const placeMissing: string[] = []
    const placeExtra: string[] = []
    for (const p of enIcu.variables) {
      if (!localIcu.variables.has(p)) placeMissing.push(p)
    }
    for (const p of localIcu.variables) {
      if (!enIcu.variables.has(p)) placeExtra.push(p)
    }
    if (placeMissing.length > 0 || placeExtra.length > 0) {
      placeholderMismatch.push({
        key,
        missing: placeMissing,
        extra: placeExtra,
      })
    }
  }
  return { missing, extra, placeholderMismatch, icuParseFailures }
}

interface LockReport {
  missingFromLock: string[]
  extrasInLock: string[]
  summaryMismatch: { expected: ReviewSummary; actual: unknown } | null
}

async function checkLockAndSummary(
  english: Map<string, string>,
  localeFiles: string[],
): Promise<LockReport> {
  const lockRaw = await readFile(join(LOCALES_DIR, LOCK_FILE), 'utf8')
  const lock = JSON.parse(lockRaw) as Lock
  const expectedKeys = new Set<string>()
  const locales = localeFiles.map((f) => f.replace(/\.json$/, ''))
  for (const locale of locales) {
    for (const key of english.keys()) {
      expectedKeys.add(`${locale}.${key}`)
    }
  }
  const have = new Set(Object.keys(lock))
  const missingFromLock: string[] = []
  const extrasInLock: string[] = []
  for (const k of expectedKeys) {
    if (!have.has(k)) missingFromLock.push(k)
  }
  for (const k of have) {
    if (!expectedKeys.has(k)) extrasInLock.push(k)
  }

  const expectedSummary = buildReviewSummary(lock)
  let actualSummary: unknown
  try {
    const summaryRaw = await readFile(
      join(LOCALES_DIR, REVIEW_SUMMARY_FILE),
      'utf8',
    )
    actualSummary = JSON.parse(summaryRaw)
  } catch {
    actualSummary = null
  }
  const summaryMismatch =
    JSON.stringify(actualSummary) === JSON.stringify(expectedSummary)
      ? null
      : { expected: expectedSummary, actual: actualSummary }
  return { missingFromLock, extrasInLock, summaryMismatch }
}

async function main(): Promise<void> {
  const catalogRaw = await readFile(join(LOCALES_DIR, SOURCE_CATALOG), 'utf8')
  const catalog = JSON.parse(catalogRaw) as CatalogJson
  const english = flattenCatalog(catalog)
  const referencedKeys = await findReferencedKeys()

  // Pre-compile every English source string. A parse failure here is
  // a bug in `en.json` itself (the catalog's source of truth); treat
  // it as fatal — we can't compare placeholder shape against an
  // unparseable source.
  const englishIcu = new Map<string, IcuCheck>()
  const englishParseFailures: IcuParseFailure[] = []
  for (const [key, value] of english) {
    const probe = analyzeIcu(value)
    if (probe.parseError !== null) {
      englishParseFailures.push({ key, message: probe.parseError })
    }
    englishIcu.set(key, probe)
  }

  const missing: { key: string; files: string[] }[] = []
  for (const [key, files] of referencedKeys) {
    if (!english.has(key)) {
      missing.push({ key, files })
    }
  }

  const unused: string[] = []
  for (const key of english.keys()) {
    if (!referencedKeys.has(key) && !DYNAMIC_KEYS.has(key)) {
      unused.push(key)
    }
  }

  console.log(
    `i18n: ${english.size} keys in catalog, ${referencedKeys.size} referenced.`,
  )

  if (missing.length > 0) {
    console.error(`\nMissing keys (${missing.length}):`)
    for (const { key, files } of missing) {
      console.error(`  ${key}`)
      for (const file of files) {
        console.error(`    - ${file}`)
      }
    }
  }

  if (unused.length > 0) {
    console.warn(`\nUnused keys (${unused.length}):`)
    for (const key of unused) {
      console.warn(`  ${key}`)
    }
  }

  if (englishParseFailures.length > 0) {
    console.error(
      `\nen.json has ${englishParseFailures.length} ICU parse failure(s):`,
    )
    for (const f of englishParseFailures) {
      console.error(`  - ${f.key}: ${f.message}`)
    }
  }

  let parityErrors = 0
  const otherLocales = await listOtherLocales()
  for (const localeFile of otherLocales) {
    const report = await checkLocaleParity(localeFile, english, englishIcu)
    const total =
      report.missing.length +
      report.extra.length +
      report.placeholderMismatch.length +
      report.icuParseFailures.length
    if (total === 0) {
      console.log(`  ${localeFile}: parity OK`)
      continue
    }
    parityErrors += total
    console.error(`\n${localeFile} parity errors (${total}):`)
    if (report.missing.length > 0) {
      console.error(`  Missing in ${localeFile} (${report.missing.length}):`)
      for (const k of report.missing) console.error(`    - ${k}`)
    }
    if (report.extra.length > 0) {
      console.error(`  Extra in ${localeFile} (${report.extra.length}):`)
      for (const k of report.extra) console.error(`    - ${k}`)
    }
    if (report.placeholderMismatch.length > 0) {
      console.error(
        `  Placeholder mismatch (${report.placeholderMismatch.length}):`,
      )
      for (const m of report.placeholderMismatch) {
        const parts: string[] = []
        if (m.missing.length > 0)
          parts.push(`missing {${m.missing.join('}, {')}}`)
        if (m.extra.length > 0) parts.push(`extra {${m.extra.join('}, {')}}`)
        console.error(`    - ${m.key}: ${parts.join('; ')}`)
      }
    }
    if (report.icuParseFailures.length > 0) {
      console.error(
        `  ICU parse failure(s) (${report.icuParseFailures.length}):`,
      )
      for (const f of report.icuParseFailures) {
        console.error(`    - ${f.key}: ${f.message}`)
      }
    }
  }

  // Lock-file + summary parity. The lock is tooling metadata, but
  // both files end up in the repo, so drift between them (or between
  // either and `en.json`) silently breaks the Preferences "marked
  // for review" hint. The summary is the only one that actually
  // bundles into the renderer; lock parity protects future review
  // runs from operating on stale data.
  const lockReport = await checkLockAndSummary(english, otherLocales)
  const lockErrors =
    lockReport.missingFromLock.length +
    lockReport.extrasInLock.length +
    (lockReport.summaryMismatch !== null ? 1 : 0)
  if (lockErrors === 0) {
    console.log(`  ${LOCK_FILE} + ${REVIEW_SUMMARY_FILE}: parity OK`)
  } else {
    console.error(`\n${LOCK_FILE} parity errors (${lockErrors}):`)
    if (lockReport.missingFromLock.length > 0) {
      console.error(
        `  Missing from lock (${lockReport.missingFromLock.length}):`,
      )
      for (const k of lockReport.missingFromLock) console.error(`    - ${k}`)
    }
    if (lockReport.extrasInLock.length > 0) {
      console.error(`  Extras in lock (${lockReport.extrasInLock.length}):`)
      for (const k of lockReport.extrasInLock) console.error(`    - ${k}`)
    }
    if (lockReport.summaryMismatch !== null) {
      console.error(`  ${REVIEW_SUMMARY_FILE} is out of sync with the lock:`)
      console.error(
        `    expected: ${JSON.stringify(lockReport.summaryMismatch.expected.unreviewedByLocale)}`,
      )
      console.error(
        `    on-disk:  ${JSON.stringify((lockReport.summaryMismatch.actual as ReviewSummary | null)?.unreviewedByLocale ?? null)}`,
      )
      console.error(
        '    Re-run `bun run scripts/translate-i18n.ts` to refresh both files.',
      )
    }
  }

  if (
    missing.length > 0 ||
    parityErrors > 0 ||
    englishParseFailures.length > 0 ||
    lockErrors > 0
  ) {
    process.exit(1)
  }
}

await main()
