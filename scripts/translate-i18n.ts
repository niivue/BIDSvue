#!/usr/bin/env bun
/**
 * One-shot AI bootstrap + drift-resync for non-English locale catalogs.
 *
 * Reads `src/lib/i18n/locales/en.json` as the source of truth, then for
 * each non-English locale catalog (`pt.json`, `es.json`, …) translates
 * any key that is either:
 *   - missing from the target catalog, OR
 *   - present in the target catalog but flagged
 *     `humanReviewed: false` in `translations.lock.json` AND whose
 *     English source has changed since the lock entry was written.
 *
 * Writes the resulting catalog back and updates the lock file. The
 * lock file is consumed at runtime only as a tiny `{en: false, pt: true}`
 * summary surfaced by the Preferences pane's "translations marked for
 * review" hint — not as a catalog. See docs/i18n_goal.md §"Decision log".
 *
 * Flags:
 *   --force   re-translate every key, including those marked
 *             `humanReviewed: true`. Use sparingly; intended for
 *             "the source English shifted in a way that breaks the
 *             reviewed translation".
 *   --dry     print the keys that would be translated and exit.
 *   --locale=<slug>  translate only the named locale.
 *
 * Translation backend: Anthropic Claude via the Messages API. Requires
 * `ANTHROPIC_API_KEY` in the environment. If the key is missing, the
 * script prints the list of keys that would change and exits 0 — useful
 * as a CI "everything is in sync" check without needing the API key.
 *
 * The script is the ONLY supported way to (re-)translate; do not edit
 * pt.json / es.json by hand for new English keys. Hand-edits for
 * native-speaker review are expected and tracked via the lock file's
 * `humanReviewed: true` flag.
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type CatalogJson,
  type Lock,
  buildReviewSummary,
  flattenCatalog,
  sortCatalogByEnglish,
  sortLockKeys,
  unflattenCatalog,
} from './_i18nLockUtils'

const LOCALES_DIR = 'src/lib/i18n/locales'
const SOURCE_LOCALE = 'en'
const TARGET_LOCALES = ['pt', 'es'] as const
const LOCK_PATH = join(LOCALES_DIR, 'translations.lock.json')
const REVIEW_SUMMARY_PATH = join(LOCALES_DIR, 'review-summary.json')
const API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-opus-4-7'
const MAX_BATCH = 40

interface Args {
  force: boolean
  dryRun: boolean
  locale: string | null
}

function parseArgs(argv: string[]): Args {
  let force = false
  let dryRun = false
  let locale: string | null = null
  for (const a of argv.slice(2)) {
    if (a === '--force') force = true
    else if (a === '--dry' || a === '--dry-run') dryRun = true
    else if (a.startsWith('--locale=')) locale = a.slice('--locale='.length)
    else {
      console.error(`Unknown flag: ${a}`)
      process.exit(2)
    }
  }
  return { force, dryRun, locale }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

async function loadLock(): Promise<Lock> {
  try {
    return await readJson<Lock>(LOCK_PATH)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return {}
    throw err
  }
}

function lockKey(locale: string, keyPath: string): string {
  return `${locale}.${keyPath}`
}

interface ToTranslate {
  locale: string
  keyPath: string
  english: string
}

interface ReviewedDrift {
  locale: string
  keyPath: string
}

/**
 * Walk the English catalog and decide which target-locale entries need
 * (re-)translation. A non-empty `work` list AND/OR a non-empty
 * `reviewedDrift` list both indicate the catalog is out of sync with
 * `en.json`.
 *
 * `reviewedDrift` contains entries the user previously marked
 * `humanReviewed: true` whose English source has changed since that
 * review. Without `--force`, the script preserves the existing
 * translation (don't blow away human work silently) but reports the
 * drift loudly so the reviewer can re-translate by hand or rerun with
 * `--force` after backing up the manual edits. Audit P2 (2026-05-25).
 */
function pickKeysToTranslate(
  locale: string,
  english: Map<string, string>,
  current: Map<string, string>,
  lock: Lock,
  force: boolean,
): { work: ToTranslate[]; reviewedDrift: ReviewedDrift[] } {
  const work: ToTranslate[] = []
  const reviewedDrift: ReviewedDrift[] = []
  for (const [keyPath, source] of english) {
    const lockEntry = lock[lockKey(locale, keyPath)]
    const have = current.get(keyPath)
    if (have === undefined) {
      work.push({ locale, keyPath, english: source })
      continue
    }
    if (force) {
      work.push({ locale, keyPath, english: source })
      continue
    }
    const sourceHash = sha256(source)
    if (lockEntry?.humanReviewed) {
      if (
        lockEntry.sourceHash !== undefined &&
        lockEntry.sourceHash !== sourceHash
      ) {
        reviewedDrift.push({ locale, keyPath })
      }
      continue
    }
    if (
      lockEntry?.sourceHash !== undefined &&
      lockEntry.sourceHash === sourceHash
    ) {
      continue
    }
    work.push({ locale, keyPath, english: source })
  }
  return { work, reviewedDrift }
}

const LANGUAGE_LABELS: Record<string, string> = {
  pt: 'Brazilian Portuguese',
  es: 'Spanish',
}

async function translateBatch(
  locale: string,
  batch: ToTranslate[],
  apiKey: string,
): Promise<Map<string, string>> {
  const target = LANGUAGE_LABELS[locale] ?? locale
  const items = batch.map((b) => ({ key: b.keyPath, english: b.english }))
  const prompt = [
    `Translate the following UI strings from English into ${target}.`,
    'Return a JSON object mapping each input "key" to the translated string.',
    'Hard rules:',
    '- Preserve every {placeholder} name and ICU MessageFormat syntax verbatim, including the literal "#" inside plural/select arms.',
    '- Preserve BIDS terminology (sub-, ses-, T1w, BOLD, fmap, DICOM, etc.), command names (datalad, dcm2niix, allineate), file extensions, and product names (BIDSvue, brainlife, OpenNeuro, EBRAINS).',
    '- Preserve typographic punctuation (…, –, —, curly quotes) as in the source.',
    '- Do not translate code-style strings such as `datalad get` — keep them verbatim.',
    '- Output ONLY JSON, no commentary.',
    '',
    `INPUT:\n${JSON.stringify(items, null, 2)}`,
  ].join('\n')

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as {
    content?: { type: string; text?: string }[]
  }
  const text = (body.content ?? [])
    .filter(
      (c): c is { type: string; text: string } => typeof c.text === 'string',
    )
    .map((c) => c.text)
    .join('\n')
  const match = text.match(/\{[\s\S]*\}/)
  if (match === null) {
    throw new Error(`No JSON object in API response: ${text.slice(0, 200)}`)
  }
  const parsed = JSON.parse(match[0]) as Record<string, string>
  const out = new Map<string, string>()
  for (const item of batch) {
    const v = parsed[item.keyPath]
    if (typeof v !== 'string') {
      throw new Error(
        `Missing translation for "${item.keyPath}" in API response`,
      )
    }
    out.set(item.keyPath, v)
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  const english = flattenCatalog(
    await readJson<CatalogJson>(join(LOCALES_DIR, `${SOURCE_LOCALE}.json`)),
  )
  const lock = await loadLock()
  const locales =
    args.locale === null ? TARGET_LOCALES : ([args.locale] as const)
  const apiKey = process.env.ANTHROPIC_API_KEY ?? ''

  // Per-locale dirty flag — set when we MUTATE either the catalog or
  // the lock entries for that locale. `--dry` keeps both off, so the
  // run reports diffs without touching disk.
  const dirty: Set<string> = new Set()
  const perLocaleCurrent: Map<string, Map<string, string>> = new Map()

  for (const locale of locales) {
    if (!(TARGET_LOCALES as readonly string[]).includes(locale)) {
      console.error(`Unknown locale: ${locale}`)
      process.exit(2)
    }
    let current: Map<string, string>
    try {
      current = flattenCatalog(
        await readJson<CatalogJson>(join(LOCALES_DIR, `${locale}.json`)),
      )
    } catch {
      current = new Map()
    }
    perLocaleCurrent.set(locale, current)

    // Step 1 — surface keys this catalog carries that English no
    // longer has. We previously only did this AFTER translation work,
    // which left extras un-pruned when nothing else needed to change.
    // Now we collect them every run so a pure-English-deletion fixup
    // doesn't require unrelated work to land. Audit P2 (2026-05-25).
    const extras: string[] = []
    for (const k of current.keys()) {
      if (!english.has(k)) extras.push(k)
    }
    if (extras.length > 0) {
      console.log(`[${locale}] ${extras.length} extra key(s) to prune.`)
      for (const k of extras) console.log(`  - ${k}`)
      if (!args.dryRun) {
        for (const k of extras) {
          current.delete(k)
          delete lock[lockKey(locale, k)]
        }
        dirty.add(locale)
      }
    }

    const { work, reviewedDrift } = pickKeysToTranslate(
      locale,
      english,
      current,
      lock,
      args.force,
    )
    if (reviewedDrift.length > 0) {
      console.warn(
        `[${locale}] ${reviewedDrift.length} reviewed entry(ies) have a changed English source — translations are preserved; rerun with --force after backing up to regenerate:`,
      )
      for (const d of reviewedDrift) console.warn(`  ~ ${d.keyPath}`)
    }
    if (work.length === 0) {
      if (extras.length === 0 && reviewedDrift.length === 0) {
        console.log(`[${locale}] up to date.`)
      }
      continue
    }
    console.log(`[${locale}] ${work.length} key(s) to translate.`)
    if (args.dryRun) {
      for (const w of work) console.log(`  + ${w.keyPath}`)
      continue
    }
    if (apiKey === '') {
      console.warn(
        `[${locale}] ANTHROPIC_API_KEY is not set; printing pending work and exiting.`,
      )
      for (const w of work) console.warn(`  + ${w.keyPath}`)
      process.exitCode = 1
      continue
    }
    for (let i = 0; i < work.length; i += MAX_BATCH) {
      const batch = work.slice(i, i + MAX_BATCH)
      const translations = await translateBatch(locale, batch, apiKey)
      for (const [keyPath, value] of translations) {
        current.set(keyPath, value)
        lock[lockKey(locale, keyPath)] = {
          humanReviewed: false,
          sourceHash: sha256(english.get(keyPath) as string),
        }
      }
      console.log(
        `[${locale}] translated ${Math.min(i + MAX_BATCH, work.length)}/${work.length}`,
      )
    }
    dirty.add(locale)
  }

  if (args.dryRun) {
    return
  }

  for (const locale of dirty) {
    const current = perLocaleCurrent.get(locale)
    if (current === undefined) continue
    const sorted = sortCatalogByEnglish(current, english)
    await writeFile(
      join(LOCALES_DIR, `${locale}.json`),
      `${JSON.stringify(unflattenCatalog(sorted), null, 2)}\n`,
      'utf8',
    )
  }

  // Drop lock entries for unknown locales / keys. Always runs (not
  // gated by `dirty`) so a stale entry for a removed locale still gets
  // cleaned even if no catalog changed in this run.
  let lockMutated = false
  for (const k of Object.keys(lock)) {
    const dot = k.indexOf('.')
    if (dot < 0) {
      delete lock[k]
      lockMutated = true
      continue
    }
    const locale = k.slice(0, dot)
    const keyPath = k.slice(dot + 1)
    if (!(TARGET_LOCALES as readonly string[]).includes(locale)) {
      delete lock[k]
      lockMutated = true
      continue
    }
    if (!english.has(keyPath)) {
      delete lock[k]
      lockMutated = true
    }
  }
  if (dirty.size > 0 || lockMutated) {
    await writeFile(
      LOCK_PATH,
      `${JSON.stringify(sortLockKeys(lock), null, 2)}\n`,
      'utf8',
    )
    await writeFile(
      REVIEW_SUMMARY_PATH,
      `${JSON.stringify(buildReviewSummary(lock), null, 2)}\n`,
      'utf8',
    )
  }
}

await main()
