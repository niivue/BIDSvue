/**
 * M3 Phase A spike: drive @bids/validator@2.4.1 from a Bun process and log
 * the diagnostic shape. The point of this script is to validate three things
 * before we wire the validator into the renderer:
 *
 *   1. The JSR-published package can be imported from a non-Deno runtime
 *      (Bun) without the Deno-only entry points (`bids-validator.ts` CLI
 *      bootstrap) blowing up on load.
 *   2. The `validate(fileTree, options, config)` API works against an
 *      in-memory FileTree we construct from a real on-disk directory, so
 *      we know the renderer can do the same via Tauri's plugin-fs.
 *   3. The shape of `ValidationResult.issues` is captured so we can design
 *      the bidsvue-side Diagnostic type for Phase B without guessing.
 *
 * Not for production. Has zero hardening (loads whole files into memory,
 * synthesises tiny fixtures, prints to stdout). Run with:
 *
 *   bun run scripts/spike-validator.ts                 # uses synthetic fixtures
 *   bun run scripts/spike-validator.ts /path/to/dataset  # uses a real dataset
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'

// The package's "." export is the Deno CLI bootstrap (calls Deno.exit). We
// import from "./main" which only DEFINES `main()` and re-exports the
// library-shaped `fileListToTree` and `validate`. The transitive imports
// reference Deno only inside function bodies, so module evaluation is safe
// in Bun.
import { fileListToTree, validate } from '@bids/validator/main'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FixtureFile {
  /** Path relative to the fixture root. POSIX separators. */
  rel: string
  content: string
}

const MINIMAL_DATASET_DESCRIPTION = JSON.stringify(
  {
    Name: 'spike fixture',
    BIDSVersion: '1.10.0',
    DatasetType: 'raw',
    Authors: ['BIDSvue spike'],
  },
  null,
  2,
)

const MINIMAL_T1W_JSON = JSON.stringify(
  { Manufacturer: 'spike', MagneticFieldStrength: 3 },
  null,
  2,
)

const PARTICIPANTS_TSV = 'participant_id\tage\nsub-01\t30\n'

const VALID_FIXTURE: FixtureFile[] = [
  { rel: 'dataset_description.json', content: MINIMAL_DATASET_DESCRIPTION },
  { rel: 'participants.tsv', content: PARTICIPANTS_TSV },
  { rel: 'sub-01/anat/sub-01_T1w.json', content: MINIMAL_T1W_JSON },
  // NIfTI content is intentionally not a real volume; the validator may
  // flag the header but should not crash. We're scoping the spike to
  // "does it return diagnostics," not "are the diagnostics accurate."
  { rel: 'sub-01/anat/sub-01_T1w.nii.gz', content: 'not-a-real-nifti' },
]

const INVALID_FIXTURE: FixtureFile[] = [
  // Missing dataset_description.json entirely; the validator's top-level
  // check should flag this and refuse to descend.
  { rel: 'participants.tsv', content: PARTICIPANTS_TSV },
  { rel: 'sub-01/anat/sub-01_T1w.json', content: MINIMAL_T1W_JSON },
  { rel: 'sub-01/anat/sub-01_T1w.nii.gz', content: 'not-a-real-nifti' },
]

async function writeFixture(root: string, files: FixtureFile[]): Promise<void> {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  for (const f of files) {
    const abs = join(root, ...f.rel.split('/'))
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, f.content)
  }
}

// ---------------------------------------------------------------------------
// Real-dataset → File[] adapter
// ---------------------------------------------------------------------------

/**
 * Walk `root` recursively and build a File[] suitable for handing to
 * `fileListToTree`. Each File's `webkitRelativePath` is set to
 * `<datasetName>/<relative path>` because the upstream BIDSFileBrowser
 * constructor strips the first `/`-delimited segment as the dataset root
 * prefix (see node_modules/@bids/validator/src/files/browser.ts).
 *
 * Reads the entire file content into memory because Bun's File() expects a
 * BlobPart array up front. Fine for the spike (small fixtures). The
 * renderer integration will need a lazy-streaming version because BIDS
 * datasets can be many GB.
 */
async function dirToFileList(root: string): Promise<File[]> {
  const files: File[] = []
  const datasetName = basename(root)

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.isFile()) {
        const buf = await readFile(abs)
        const relPath = relative(root, abs).split(sep).join('/')
        const info = await stat(abs)
        const file = new File([buf], entry.name, { lastModified: info.mtimeMs })
        // webkitRelativePath is declared readonly on the DOM File interface
        // but Bun's class doesn't actually enforce that; defineProperty is
        // the belt-and-braces version in case the runtime tightens it.
        Object.defineProperty(file, 'webkitRelativePath', {
          value: `${datasetName}/${relPath}`,
          writable: false,
          configurable: true,
        })
        files.push(file)
      }
    }
  }

  await walk(root)
  return files
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * The validator's ValidatorOptions includes a pile of CLI-shaped fields
 * (verbose, color, format, ...) we don't care about for the spike. Only
 * `datasetPath`, `datasetTypes`, `blacklistModalities`, and `debug` appear
 * to be required by validate() itself. Use sensible defaults; the
 * spike-script is not the place to tune options.
 */
const SPIKE_OPTIONS = {
  datasetPath: '<spike>',
  debug: 'ERROR' as const,
  datasetTypes: ['raw', 'derivative'],
  blacklistModalities: [],
}

async function runOne(label: string, root: string): Promise<void> {
  console.log(`\n=== ${label}  (${root}) ===`)
  const files = await dirToFileList(root)
  console.log(`Built File[] from disk: ${files.length} files`)

  const tree = await fileListToTree(files)
  console.log(`Built FileTree: root=${tree.path} name=${tree.name}`)

  const t0 = performance.now()
  const result = await validate(tree, SPIKE_OPTIONS)
  const elapsed = performance.now() - t0
  console.log(`validate() returned in ${elapsed.toFixed(0)} ms`)

  // The full ValidationResult is large because `result.issues` carries a
  // map of every code-keyed issue plus per-file metadata. Surface the
  // useful summary fields directly and dump the issue codes for shape.
  console.log('Summary:')
  console.log({
    subjects: result.summary.subjects,
    sessions: result.summary.sessions,
    modalities: result.summary.modalities,
    dataTypes: result.summary.dataTypes,
    totalFiles: result.summary.totalFiles,
    schemaVersion: result.summary.schemaVersion,
  })

  // result.issues is a DatasetIssues instance, not a plain map. Inspect
  // its public surface for keys we should index against on the bidsvue
  // side.
  const issues = result.issues as unknown as Record<string, unknown>
  console.log('Issues object keys:', Object.keys(issues).slice(0, 30))
  // Look for common shape patterns: a Map of code -> Issue, or a flat list.
  if (typeof issues.size === 'number') {
    console.log(`Issue count (size): ${(issues as { size: number }).size}`)
  }
  if (Array.isArray((issues as { issues?: unknown[] }).issues)) {
    const arr = (issues as { issues: unknown[] }).issues
    console.log(`Issue count (array): ${arr.length}`)
    console.log('First 5 issues:', arr.slice(0, 5))
  }
  // Iterator probe disabled. `DatasetIssues.entries()` returned a
  // lazy/non-terminating iterable on real datasets and hung the script
  // after the diagnostics print. Production code reads
  // `result.issues.issues` directly, which is the documented shape.
}

async function main(): Promise<void> {
  const cliArg = process.argv[2]
  if (cliArg !== undefined) {
    await runOne('real dataset', cliArg)
    return
  }

  const tmpRoot = join(tmpdir(), `bidsvue-spike-${process.pid}`)
  const valid = join(tmpRoot, 'valid')
  const invalid = join(tmpRoot, 'invalid')
  try {
    await writeFixture(valid, VALID_FIXTURE)
    await writeFixture(invalid, INVALID_FIXTURE)
    await runOne('VALID fixture', valid)
    await runOne('INVALID fixture (no dataset_description.json)', invalid)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }
}

await main()
// Force a clean exit: some validator internals (file readers, schema
// fetch caches) keep handles alive past the last await. The spike is a
// diagnostic harness; we don't need them to drain on their own.
process.exit(0)
