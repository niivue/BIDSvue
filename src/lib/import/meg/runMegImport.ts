// MEG import orchestrator. Pure-TS counterpart to the M8 dcm2niix /
// heudiconv / dcm2bids importer at `src/lib/import/runImport.ts`,
// but without an external binary -- per-vendor parsers under
// `formats/<vendor>/` produce a `MegRecording` in-process and the
// sidecar writers in `writers/sidecars.ts` emit the BIDS files
// directly.
//
// Operation log integration: the whole import commits as a single
// `'import'` operation under one `OperationContext`. The
// `'created-tree'` marker on destDir means the M6 undo executor
// collapses the imported tree wholesale (matches the M8 epilogue),
// and the M9 H1 destructive-undo confirmation overlay automatically
// applies.
//
// Vendor coverage:
//   - CTF   (M10-B):  `.ds` directory  -> parse .res4 + .hc, copy dir
//   - Elekta (M10-C): `.fif` file      -> parse FIFF tag stream, copy file
//   - KIT   (M10-D):  `.con`/`.sqd` file -> parse directory-of-dirs, copy file
//   - BTi   (M10-E):  directory with `config` + `c,*` data file -> parse
//                      config header + PDF trailer + (optional) hs_file,
//                      copy dir verbatim
//
// `MegVendor` is the discriminant. The wizard's manifest layer
// exposes one `ezbids-meg` entry whose dispatch is by source-path
// extension, not by tool choice -- the user picks "ezBIDS MEG" and
// the orchestrator routes to the right parser.

import { beginOperation } from '$lib/mutate/backup'
import type { MutateFs } from '$lib/mutate/backup'
import type { DatasetStatePaths } from '$lib/state/appPaths'
import { basename } from '$lib/util/paths'
import { btiRecordingFromHeaders } from './formats/bti/btiRecording'
import {
  parseBtiConfigHeader,
  parseBtiHeadShape,
  parseBtiPdfTrailer,
} from './formats/bti/header'
import { parseCtfHc } from './formats/ctf/coordinates'
import { ctfRecordingFromRes4 } from './formats/ctf/ctfRecording'
import { parseRes4 } from './formats/ctf/header'
import { fifRecordingFromHeader } from './formats/fif/fifRecording'
import { parseFif } from './formats/fif/header'
import { parseKit } from './formats/kit/header'
import { kitRecordingFromHeader } from './formats/kit/kitRecording'
import type { MegRecording } from './recording'
import {
  writeChannelsTsv,
  writeCoordsystemJson,
  writeMegJson,
} from './writers/sidecars'

const BIDS_LABEL_RE = /^[a-zA-Z0-9]+$/

function validateBidsLabel(value: string, fieldName: string): string | null {
  if (value.length === 0) return `${fieldName} is empty`
  if (!BIDS_LABEL_RE.test(value)) {
    return `${fieldName} "${value}" must match [a-zA-Z0-9]+ (BIDS label rule)`
  }
  return null
}

function validatePathArg(value: string, fieldName: string): string | null {
  if (value.length === 0) return `${fieldName} is empty`
  if (value.startsWith('-')) return `${fieldName} must not start with "-"`
  if (value.includes('\0')) return `${fieldName} must not contain NUL`
  return null
}

export type MegVendor = 'CTF' | 'Elekta' | 'KIT' | 'BTi'

/**
 * Auto-detect vendor from a source path's suffix. Returns null if the
 * suffix doesn't match a supported vendor format -- the orchestrator
 * surfaces this as a clear "unsupported source" error rather than
 * trying to parse arbitrary bytes.
 *
 * BTi sources are directories with no specific suffix; use
 * `detectMegVendorAsync` instead when filesystem access is available.
 */
export function detectMegVendor(srcPath: string): MegVendor | null {
  // Case-insensitive: macOS picker can return e.g. `*.FIF` or `*.SQD`
  // when the user has cased the suffix unusually (round-10 audit M3).
  const lower = srcPath.toLowerCase()
  if (lower.endsWith('.ds')) return 'CTF'
  if (lower.endsWith('.fif')) return 'Elekta'
  if (lower.endsWith('.con') || lower.endsWith('.sqd')) return 'KIT'
  return null
}

/**
 * Async variant of `detectMegVendor` that handles directory sources
 * whose vendor can only be determined by inspecting the contents.
 * BTi recordings are a directory containing at least:
 *   - `config`           (system + per-channel header)
 *   - a `c,*` file       (PDF data file, e.g. `c,rfDC`)
 *
 * Falls back to `detectMegVendor`'s suffix matching first so the
 * suffix-based vendors don't pay the readDir cost.
 */
export async function detectMegVendorAsync(
  srcPath: string,
  fs: MutateFs,
): Promise<MegVendor | null> {
  const synced = detectMegVendor(srcPath)
  if (synced !== null) return synced
  try {
    if (!(await fs.exists(srcPath))) return null
    const entries = await fs.readDir(srcPath)
    const names = entries.map((e) => e.name)
    const hasConfig = names.includes('config')
    const hasDataFile = names.some((n) => n.startsWith('c,'))
    if (hasConfig && hasDataFile) return 'BTi'
  } catch {
    // readDir on a file (vs. directory) throws; treat as "not detected"
    // and fall through to the unsupported-source error in the caller.
  }
  return null
}

export interface RunMegImportOptions {
  statePaths: DatasetStatePaths
  /**
   * Absolute path to the vendor source. CTF: a `.ds` directory.
   * Elekta: a `.fif` file. KIT: a `.con` / `.sqd` file. BTi: a
   * directory containing `config` + a `c,*` data file.
   */
  srcPath: string
  /** Absolute path to the destination BIDS dataset directory. */
  destDir: string
  /**
   * Optional vendor override. When absent the orchestrator detects
   * from the source-path suffix via `detectMegVendor`.
   */
  vendor?: MegVendor
  /** BIDS subject label without the `sub-` prefix. */
  subject: string
  /** BIDS session label without the `ses-` prefix. Omit for no session. */
  session?: string
  /** `_meg.json.TaskName` and the `task-<X>` entity. */
  task: string
  /** BIDS acquisition label. Omit for no `acq-` entity. */
  acquisition?: string
  /** BIDS run label (e.g. `"01"`). Omit for no `run-` entity. */
  run?: string
  /** `_meg.json.PowerLineFrequency`. `null` or undefined -> "n/a". */
  powerLineFrequency?: number | null
  /** `_meg.json.DewarPosition`. `null` or undefined -> "n/a". */
  dewarPosition?: string | null
  /** Wizard hint for `_meg.json.ContinuousHeadLocalization`. */
  continuousHeadLocalization?: boolean
  /** Wizard hint for `_meg.json.DigitizedLandmarks`. */
  digitizedLandmarks?: boolean
  /** Wizard hint for `_meg.json.DigitizedHeadPoints`. */
  digitizedHeadPoints?: boolean
  /**
   * `_meg.json.AssociatedEmptyRoom` -- path to a previously-imported
   * empty-room recording relative to the destDir (BIDS-style). Empty
   * or undefined skips the field.
   */
  associatedEmptyRoom?: string
  /** BIDS version string. */
  bidsVersion: string
  /**
   * Optional License + Authors overrides for the wizard's
   * dataset_description.json rewrite. When set, replaces the
   * corresponding fields in the description stub written below.
   * See `import/postpass/datasetDescription.ts` for the exact
   * semantics.
   */
  description?: {
    license?: 'PD' | 'PDDL' | 'CC0' | null
    authors?: ReadonlyArray<string>
  }
  /** MutateFs (Tauri in prod, node:fs in tests). */
  fs: MutateFs
}

export interface RunMegImportResult {
  /** Absolute path to the imported vendor data. CTF: `.ds` directory;
   *  Elekta: `.fif` file; KIT: `.con`/`.sqd` file; BTi: `<entityStem>_meg/`
   *  directory containing the original `config` + `c,*` + `hs_file`. */
  importedDataPath: string
  /** Sidecar files emitted, as absolute paths (matches the
   *  `importedDataPath` shape; tests and callers consume them
   *  directly with `fs.readFile`). */
  sidecarsWritten: string[]
  /** Count of bytes copied for the raw vendor data. */
  rawBytesCopied: number
  /** Which vendor handler ran. */
  vendor: MegVendor
  /** Wall-clock duration of the import in milliseconds — measured from
   *  runMegImport entry to return. Surfaced in the wizard alongside
   *  the dcm2niix-shaped importers' duration. */
  durationMs: number
}

/**
 * Internal: per-vendor parse result. Shared shape lets the main
 * orchestrator handle the BIDS-layout + sidecar + commit logic
 * once, regardless of source format.
 */
interface ParsedSource {
  recording: MegRecording
  /**
   * `dir` -> source is a directory; we copy every entry one at a time.
   *   - CTF: `stem` is the `.ds` folder's basename without extension;
   *     entries whose name starts with the stem get renamed to use
   *     `<entityStem>_meg` as the new prefix.
   *   - BTi: `stem` is `null` -- the BIDS-MEG spec keeps BTi
   *     filenames (`config`, `c,rfDC`, `hs_file`) verbatim inside the
   *     `<entityStem>_meg/` directory.
   *
   * `file` -> source is a single file; we copy one blob
   *   (FIF .fif, KIT .con/.sqd).
   */
  copy:
    | {
        kind: 'dir'
        entries: readonly { name: string }[]
        stem: string | null
      }
    | { kind: 'file' }
  /**
   * Output basename WITHOUT the leading entity stem (e.g. `_meg.ds`
   * for CTF, `_meg.fif` for FIF). The orchestrator prepends the
   * computed entity stem.
   */
  outputSuffix: string
}

/**
 * Run an MEG-to-BIDS import. The entire operation commits under one
 * `OperationContext`; destDir is recorded as `'created-tree'` so the
 * M6 undo path wipes everything wholesale on rollback.
 */
export async function runMegImport(
  opts: RunMegImportOptions,
): Promise<RunMegImportResult> {
  const startedAt = Date.now()
  const { fs, statePaths, srcPath, destDir } = opts

  const vendor = opts.vendor ?? (await detectMegVendorAsync(srcPath, fs))
  if (vendor === null) {
    throw new Error(
      `runMegImport: cannot determine MEG vendor for "${srcPath}" -- supported sources are .ds (CTF), .fif (Elekta), .con/.sqd (KIT), and a BTi directory containing "config" + a "c,*" data file`,
    )
  }
  if (
    vendor !== 'CTF' &&
    vendor !== 'Elekta' &&
    vendor !== 'KIT' &&
    vendor !== 'BTi'
  ) {
    throw new Error(`runMegImport: vendor "${vendor}" not yet supported`)
  }

  for (const [name, value] of [
    ['srcPath', srcPath],
    ['destDir', destDir],
  ] as const) {
    const err = validatePathArg(value, name)
    if (err !== null) throw new Error(`runMegImport: ${err}`)
  }
  for (const [name, value] of [
    ['subject', opts.subject],
    ['task', opts.task],
  ] as const) {
    const err = validateBidsLabel(value, name)
    if (err !== null) throw new Error(`runMegImport: ${err}`)
  }
  for (const optional of [
    ['session', opts.session] as const,
    ['acquisition', opts.acquisition] as const,
    ['run', opts.run] as const,
  ]) {
    const [name, value] = optional
    if (value !== undefined && value !== '') {
      const err = validateBidsLabel(value, name)
      if (err !== null) throw new Error(`runMegImport: ${err}`)
    }
  }

  if (!(await fs.exists(srcPath))) {
    throw new Error(`runMegImport: srcPath does not exist: "${srcPath}"`)
  }

  // Per-vendor source shape validation (suffix is the routing key).
  // Suffix comparison stays case-insensitive to match detectMegVendor
  // (round-10 audit M3).
  const lowerSrc = srcPath.toLowerCase()
  if (vendor === 'CTF' && !lowerSrc.endsWith('.ds')) {
    throw new Error(
      `runMegImport (CTF): srcPath must be a .ds directory, got "${srcPath}"`,
    )
  }
  if (vendor === 'Elekta' && !lowerSrc.endsWith('.fif')) {
    throw new Error(
      `runMegImport (Elekta): srcPath must be a .fif file, got "${srcPath}"`,
    )
  }
  if (
    vendor === 'KIT' &&
    !(lowerSrc.endsWith('.con') || lowerSrc.endsWith('.sqd'))
  ) {
    throw new Error(
      `runMegImport (KIT): srcPath must be a .con or .sqd file, got "${srcPath}"`,
    )
  }
  if (vendor === 'BTi') {
    // BTi source must be a directory containing both a `config` file
    // and a `c,*` data file. The auto-detection path already confirms
    // this; the explicit-vendor path needs to re-check here so the
    // wizard's caller can't pass a `.fif` with `vendor: 'BTi'`.
    const btiEntries = await fs.readDir(srcPath)
    const btiNames = btiEntries.map((e) => e.name)
    if (
      !btiNames.includes('config') ||
      !btiNames.some((n) => n.startsWith('c,'))
    ) {
      throw new Error(
        `runMegImport (BTi): srcPath must be a directory containing "config" + a "c,*" data file, got "${srcPath}"`,
      )
    }
  }

  // Refuse to overwrite. Same preflight contract as the M8 importer:
  // destDir must be missing or empty.
  //
  // Track whether THIS call created destDir. If the per-vendor parser
  // throws below (before the OperationContext begins), wipe the
  // partial output so the wizard's failure path doesn't leave an
  // untracked empty directory on disk (round-9 external audit H1).
  let destCreatedByThisCall = false
  if (await fs.exists(destDir)) {
    const existing = await fs.readDir(destDir)
    if (existing.length > 0) {
      throw new Error(
        `runMegImport: destDir already exists and is non-empty: "${destDir}". v1 only imports into a fresh directory.`,
      )
    }
  } else {
    await fs.mkdir(destDir, { recursive: true })
    destCreatedByThisCall = true
  }

  // ---- per-vendor parse ----
  let parsed: ParsedSource
  try {
    parsed =
      vendor === 'CTF'
        ? await parseCtfSource(srcPath, opts, fs)
        : vendor === 'Elekta'
          ? await parseFifSource(srcPath, opts, fs)
          : vendor === 'KIT'
            ? await parseKitSource(srcPath, opts, fs)
            : await parseBtiSource(srcPath, opts, fs)
  } catch (err) {
    if (destCreatedByThisCall) {
      await fs
        .remove(destDir, { recursive: true })
        .catch((rmErr) =>
          console.warn(
            `[runMegImport] failed to clean up partial destDir after parse error: ${rmErr}`,
          ),
        )
    }
    throw err
  }

  if (
    opts.associatedEmptyRoom !== undefined &&
    opts.associatedEmptyRoom !== ''
  ) {
    parsed.recording.meta.vendorMeta.AssociatedEmptyRoom =
      opts.associatedEmptyRoom
  }

  // ---- BIDS output layout ----
  const subSegment = `sub-${opts.subject}`
  const sesSegment =
    opts.session !== undefined && opts.session !== ''
      ? `ses-${opts.session}`
      : null
  const megDir = sesSegment
    ? `${destDir}/${subSegment}/${sesSegment}/meg`
    : `${destDir}/${subSegment}/meg`
  const entityStem = buildEntityStem({
    subject: opts.subject,
    session: opts.session,
    task: opts.task,
    acquisition: opts.acquisition,
    run: opts.run,
  })
  const importedBasename = `${entityStem}${parsed.outputSuffix}`
  const importedDataPath = `${megDir}/${importedBasename}`
  const sidecarBase = `${megDir}/${entityStem}_meg`
  const coordsystemBase = sesSegment
    ? `${megDir}/${subSegment}_${sesSegment}_coordsystem.json`
    : `${megDir}/${subSegment}_coordsystem.json`

  const datasetName = basename(destDir)

  const ctx = beginOperation(
    destDir,
    statePaths,
    {
      opType: 'import',
      summary: `Imported ${vendor} MEG from ${basename(srcPath)} to ${basename(destDir)}`,
      details: {
        toolId: 'ezbids-meg',
        vendor,
        srcPath,
        destDir,
        subject: opts.subject,
        session: opts.session ?? null,
        task: opts.task,
        acquisition: opts.acquisition ?? null,
        run: opts.run ?? null,
        associatedEmptyRoom: opts.associatedEmptyRoom ?? null,
      },
    },
    fs,
  )

  const sidecarsWritten: string[] = []
  let rawBytesCopied = 0

  try {
    await ctx.recordCreatedTree(destDir, { kind: 'meg-import-destdir' })

    // Ensure parent directories exist before atomic writes.
    await fs.mkdir(megDir, { recursive: true })

    if (parsed.copy.kind === 'dir') {
      // CTF: copy each entry inside the source .ds, renaming basenames
      // whose stem matches the source folder's stem.
      // BTi: stem is `null` -- the BIDS-MEG spec keeps filenames
      // verbatim under `<entityStem>_meg/`.
      const srcStem = parsed.copy.stem
      await fs.mkdir(importedDataPath, { recursive: true })
      for (const entry of parsed.copy.entries) {
        const srcAbs = `${srcPath}/${entry.name}`
        const renamed =
          srcStem !== null && entry.name.startsWith(srcStem)
            ? `${entityStem}_meg${entry.name.slice(srcStem.length)}`
            : entry.name
        const destAbs = `${importedDataPath}/${renamed}`
        // OS-native copy — bytes never enter JS memory. The
        // recordCreatedTree(destDir) marker above covers undo, so
        // we don't need per-file ctx.writeBytes tracking (parallels
        // the dcm2niix-NIfTI case in runImport.ts).
        await fs.copyFile(srcAbs, destAbs)
        rawBytesCopied += (await fs.stat(srcAbs)).size
      }
    } else {
      // FIF / KIT: single-file copy. OS-native — no JS-side memory
      // for the payload. Pre-fix this path read the file a second
      // time (the parser had already loaded it once) and shipped the
      // bytes through ctx.writeBytes; for multi-GB recordings that
      // doubled peak memory. The recordCreatedTree marker handles
      // undo so per-file ctx tracking is unnecessary.
      await fs.copyFile(srcPath, importedDataPath)
      rawBytesCopied += (await fs.stat(srcPath)).size
    }

    // Sidecars.
    await ctx.writeText(`${sidecarBase}.json`, writeMegJson(parsed.recording))
    sidecarsWritten.push(`${sidecarBase}.json`)
    await ctx.writeText(
      `${sidecarBase}_channels.tsv`,
      writeChannelsTsv(parsed.recording),
    )
    sidecarsWritten.push(`${sidecarBase}_channels.tsv`)
    if (parsed.recording.coordinates !== null) {
      await ctx.writeText(
        coordsystemBase,
        writeCoordsystemJson(parsed.recording.coordinates),
      )
      sidecarsWritten.push(coordsystemBase)
    }

    const descriptionObj: Record<string, unknown> = {
      Name: datasetName,
      BIDSVersion: opts.bidsVersion,
      DatasetType: 'raw',
      GeneratedBy: [{ Name: 'BIDSvue', Version: 'M10' }],
    }
    if (
      opts.description?.license !== undefined &&
      opts.description.license !== null
    ) {
      descriptionObj.License = opts.description.license
    }
    if (opts.description?.authors !== undefined) {
      const cleaned: string[] = []
      for (const raw of opts.description.authors) {
        const trimmed = raw.trim()
        if (trimmed.length === 0 || trimmed === 'TODO:') continue
        cleaned.push(trimmed)
      }
      if (cleaned.length > 0) descriptionObj.Authors = cleaned
    }
    const descriptionBody = `${JSON.stringify(descriptionObj, null, 4)}\n`
    await ctx.writeText(`${destDir}/dataset_description.json`, descriptionBody)
    sidecarsWritten.push(`${destDir}/dataset_description.json`)

    await ctx.commit()
  } catch (err) {
    // Roll back the typed file-level writes first; then, if THIS call
    // created destDir, wipe the directory scaffolding (mkdir calls at
    // megDir / importedDataPath are NOT tracked by OperationContext,
    // so rollback alone leaves an empty `sub-XX/meg/` tree behind).
    // Mirrors the parse-failure cleanup path above so a mid-write or
    // commit/log-append failure converges to the same "no untracked
    // destination tree" guarantee (round-10 external audit H2).
    await ctx.rollback(err)
    if (destCreatedByThisCall) {
      await fs
        .remove(destDir, { recursive: true })
        .catch((rmErr) =>
          console.warn(
            `[runMegImport] failed to clean up partial destDir after write error: ${rmErr}`,
          ),
        )
    }
    throw err
  }

  return {
    importedDataPath,
    sidecarsWritten,
    rawBytesCopied,
    vendor,
    durationMs: Date.now() - startedAt,
  }
}

async function parseCtfSource(
  srcPath: string,
  opts: RunMegImportOptions,
  fs: MutateFs,
): Promise<ParsedSource> {
  const srcStem = basename(srcPath).replace(/\.ds$/, '')
  const res4Path = `${srcPath}/${srcStem}.res4`
  const hcPath = `${srcPath}/${srcStem}.hc`
  const res4Bytes = await fs.readFile(res4Path)
  const header = parseRes4(res4Bytes)
  const hcText = await fs.readTextFile(hcPath)
  const coordinates = parseCtfHc(hcText)
  const recording = ctfRecordingFromRes4(header, {
    taskName: opts.task,
    powerLineFrequency: opts.powerLineFrequency ?? null,
    dewarPosition: opts.dewarPosition ?? null,
    continuousHeadLocalization: opts.continuousHeadLocalization,
    digitizedLandmarks: opts.digitizedLandmarks,
    digitizedHeadPoints: opts.digitizedHeadPoints,
    coordinates,
  })
  const entries = await fs.readDir(srcPath)
  const sortedEntries = [...entries].sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  return {
    recording,
    copy: { kind: 'dir', entries: sortedEntries, stem: srcStem },
    outputSuffix: '_meg.ds',
  }
}

async function parseFifSource(
  srcPath: string,
  opts: RunMegImportOptions,
  fs: MutateFs,
): Promise<ParsedSource> {
  const bytes = await fs.readFile(srcPath)
  const header = parseFif(bytes)
  const recording = fifRecordingFromHeader(header, {
    taskName: opts.task,
    powerLineFrequency: opts.powerLineFrequency,
    dewarPosition: opts.dewarPosition,
    digitizedHeadPoints: opts.digitizedHeadPoints,
  })
  return {
    recording,
    copy: { kind: 'file' },
    outputSuffix: '_meg.fif',
  }
}

async function parseKitSource(
  srcPath: string,
  opts: RunMegImportOptions,
  fs: MutateFs,
): Promise<ParsedSource> {
  const bytes = await fs.readFile(srcPath)
  const header = parseKit(bytes)
  const recording = kitRecordingFromHeader(header, {
    taskName: opts.task,
    powerLineFrequency: opts.powerLineFrequency,
    dewarPosition: opts.dewarPosition,
    digitizedHeadPoints: opts.digitizedHeadPoints,
  })
  // Preserve the user's source-file extension (`.con` is modern,
  // `.sqd` is legacy; both decode the same). BIDS-MEG allows either.
  // Match detectMegVendor's case-insensitive convention (round-10
  // audit M3): a `.SQD` source still writes `_meg.sqd` not `_meg.con`.
  const suffix = srcPath.toLowerCase().endsWith('.sqd')
    ? '_meg.sqd'
    : '_meg.con'
  return {
    recording,
    copy: { kind: 'file' },
    outputSuffix: suffix,
  }
}

async function parseBtiSource(
  srcPath: string,
  opts: RunMegImportOptions,
  fs: MutateFs,
): Promise<ParsedSource> {
  // Step 1: read the config-file header.
  const configBytes = await fs.readFile(`${srcPath}/config`)
  const cfgHeader = parseBtiConfigHeader(configBytes)

  // Step 2: pick the PDF data file. Real recordings have one primary
  // `c,rfDC` and may have processed companions like `c,rfDC,fn50,o`.
  // We prefer the bare `c,rfDC` when present; otherwise the
  // lexicographically first `c,*` file.
  const entries = await fs.readDir(srcPath)
  const sortedEntries = [...entries].sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  const dataCandidates = sortedEntries
    .map((e) => e.name)
    .filter((n) => n.startsWith('c,'))
  if (dataCandidates.length === 0) {
    throw new Error(`parseBtiSource: no "c,*" data file found in "${srcPath}"`)
  }
  const primaryName = dataCandidates.includes('c,rfDC')
    ? 'c,rfDC'
    : dataCandidates[0]
  // dataCandidates is non-empty (length > 0 check above), so
  // primaryName is always defined; assert for the type-checker.
  if (primaryName === undefined) {
    throw new Error('parseBtiSource: data-file selection logic failed')
  }
  const pdfPath = `${srcPath}/${primaryName}`

  // Step 3: read the PDF data file. The trailer (header) is at the
  // end, so we need the full bytes. For v1 we accept the whole-file
  // read; multi-GB recordings are rare in practice (typical sessions
  // are 10-200 MB). A tail-only range-read adapter is queued for
  // M10-G if real-world fixtures exercise the memory ceiling.
  const pdfBytes = await fs.readFile(pdfPath)
  const pdfHeader = parseBtiPdfTrailer(pdfBytes, 0, pdfBytes.byteLength)

  // Step 4: hs_file (optional). Cardinal landmarks if present.
  let headShape = null
  const hasHsFile = sortedEntries.some((e) => e.name === 'hs_file')
  if (hasHsFile) {
    try {
      const hsBytes = await fs.readFile(`${srcPath}/hs_file`)
      headShape = parseBtiHeadShape(hsBytes)
    } catch (err) {
      // Non-fatal: log and continue without coordinates.
      console.warn(`[parseBtiSource] failed to read hs_file: ${err}`)
    }
  }

  const recording = btiRecordingFromHeaders(cfgHeader, pdfHeader, {
    taskName: opts.task,
    powerLineFrequency: opts.powerLineFrequency ?? null,
    dewarPosition: opts.dewarPosition ?? null,
    digitizedLandmarks: opts.digitizedLandmarks,
    digitizedHeadPoints: opts.digitizedHeadPoints,
    headShape,
  })

  return {
    recording,
    // BTi keeps filenames verbatim (`config`, `c,rfDC`, `hs_file`).
    copy: { kind: 'dir', entries: sortedEntries, stem: null },
    outputSuffix: '_meg',
  }
}

/**
 * Build the BIDS entity stem (`sub-<X>[_ses-<Y>]_task-<T>[_acq-<A>][_run-<R>]`)
 * from the input fields. Pure helper exported for tests.
 */
export function buildEntityStem(opts: {
  subject: string
  session?: string
  task: string
  acquisition?: string
  run?: string
}): string {
  const parts: string[] = [`sub-${opts.subject}`]
  if (opts.session !== undefined && opts.session !== '') {
    parts.push(`ses-${opts.session}`)
  }
  parts.push(`task-${opts.task}`)
  if (opts.acquisition !== undefined && opts.acquisition !== '') {
    parts.push(`acq-${opts.acquisition}`)
  }
  if (opts.run !== undefined && opts.run !== '') {
    parts.push(`run-${opts.run}`)
  }
  return parts.join('_')
}
