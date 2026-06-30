// Pre-bundle the BIDS validator's library API with esbuild.
//
// Why this exists: Vite + Rollup's CJS/ESM interop layer doesn't handle
// the JSR-flavoured imports the validator's source uses ("import
// { default as X } from 'cjs-pkg'", "export { default as X } from
// './schema.json' with { type: 'json' }", and similar). We patched the
// node_modules sources for the patterns we found, but Vite's per-file
// ESM-shim serving still routes through a star-re-export chain that
// WebKit rejects at module-load time with:
//
//   SyntaxError: Importing binding name 'default' cannot be resolved
//   by star export entries.
//
// Esbuild's own CJS interop produces a clean ESM bundle that doesn't
// have this issue. So we run esbuild offline against our existing shim
// (_validatorEntry.ts) and emit a single self-contained ESM file the
// renderer dynamic-imports. Vite serves the bundle as a static asset;
// at runtime the WebView never walks the validator's source graph.
//
// Run via:
//   bun run scripts/bundle-validator.ts        (build the bundle)
// or automatically as part of `bun install` (via postinstall).
//
// Output: src/lib/validation/_validator.bundle.js (gitignored).

import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BuildOptions, build } from 'esbuild'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(here, '..')

// Windows-only retry: when this script runs as bun install's postinstall
// hook, Bun's filesystem activity on node_modules can still be racing with
// esbuild's directory scan. The first scan attempt errors with `Cannot
// read directory "node_modules": The process cannot access the file
// because it is being used by another process.` even though bun install
// has nominally finished. A short backoff (~0.5s, 1s, 1.5s) clears it
// reliably; mac/Linux postinstalls have never hit this so the retry only
// arms on win32.
async function buildWithRetry(opts: BuildOptions): Promise<void> {
  const maxAttempts = process.platform === 'win32' ? 3 : 1
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await build(opts)
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const transient =
        /being used by another process|EBUSY|EPERM|EACCES|ENOENT|Cannot read directory/i.test(
          msg,
        )
      if (attempt === maxAttempts || !transient) throw err
      const delay = 500 * attempt
      console.warn(
        `[bundle-validator] transient esbuild failure on attempt ${attempt}/${maxAttempts}; retrying in ${delay}ms\n${msg}`,
      )
      await new Promise((r) => setTimeout(r, delay))
    }
  }
}

// M3 Phase G schema split: see decisions/M3-validator-integration.md
// ("The schema split" section) for the why.
const schemaSrc = resolve(
  repoRoot,
  'node_modules/@jsr/bids__schema/schema.json',
)
const staticDir = resolve(repoRoot, 'static')
const schemaDest = resolve(staticDir, '_validator.schema.json')
await mkdir(staticDir, { recursive: true })
await copyFile(schemaSrc, schemaDest)

await buildWithRetry({
  entryPoints: [resolve(repoRoot, 'src/lib/validation/_validatorEntry.ts')],
  outfile: resolve(repoRoot, 'src/lib/validation/_validator.bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'safari15',
  // Resolve @bids/validator/internal/* to the validator's on-disk src/
  // tree (same trick our retired Vite plugin used at runtime). esbuild
  // honours these aliases for the standalone build.
  alias: {
    '@bids/validator/internal/files/browser.js': resolve(
      repoRoot,
      'node_modules/@bids/validator/src/files/browser.js',
    ),
    '@bids/validator/internal/files/filetree.js': resolve(
      repoRoot,
      'node_modules/@bids/validator/src/files/filetree.js',
    ),
    '@bids/validator/internal/files/ignore.js': resolve(
      repoRoot,
      'node_modules/@bids/validator/src/files/ignore.js',
    ),
    '@bids/validator/internal/types/filetree.js': resolve(
      repoRoot,
      'node_modules/@bids/validator/src/types/filetree.js',
    ),
    '@bids/validator/internal/validators/bids.js': resolve(
      repoRoot,
      'node_modules/@bids/validator/src/validators/bids.js',
    ),
    // The validator's files/tiff.ts imports @jsr/libs__xml whose WASM
    // parser ships as a data:application/wasm;base64,... URI. esbuild
    // can't bundle that. TIFF parsing is gated by .tif/.btf extension
    // and wrapped in .catch(), so the stub never fires on BIDS-typical
    // datasets.
    '@jsr/libs__xml': resolve(repoRoot, 'src/lib/validation/_xmlStub.ts'),
    // M3 Phase G schema-split: redirect the main BIDS schema package to a
    // shim that fetches the JSON at runtime. esbuild treats alias keys as
    // path prefixes, so the citation subpath needs its own explicit alias
    // pointing back at the real package file — otherwise it would resolve
    // to `<shim>/citation` and fail. The (much smaller) citation schema
    // stays inlined that way.
    '@jsr/bids__schema/citation': resolve(
      repoRoot,
      'node_modules/@jsr/bids__schema/citation/mod.js',
    ),
    '@jsr/bids__schema': resolve(repoRoot, 'src/lib/validation/_schemaShim.ts'),
  },
  loader: {
    // The schema package ships its schema as a JSON sibling. esbuild
    // bundles it inline as a JS object.
    '.json': 'json',
  },
  // Don't externalise anything; we want a single self-contained file
  // the WebView can fetch in one HTTP request.
  external: [],
  // Vite's pre-bundle uses dataurl loader for some assets; mirror that
  // for the rare static asset the validator might reference.
  logLevel: 'info',
  // `BIDSVUE_BUNDLE_DEV=1 bun run scripts/bundle-validator.ts` produces
  // an unminified bundle with source maps so DevTools shows readable
  // function names and validator-source line numbers. Default is the
  // production-shape minified bundle.
  sourcemap: process.env.BIDSVUE_BUNDLE_DEV === '1' ? 'inline' : false,
  minify: process.env.BIDSVUE_BUNDLE_DEV !== '1',
})

const fmt = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`
const bundlePath = resolve(repoRoot, 'src/lib/validation/_validator.bundle.js')
const bundleStat = await stat(bundlePath)
const schemaStat = await stat(schemaDest)
console.log(
  `[bundle-validator] wrote src/lib/validation/_validator.bundle.js (${fmt(bundleStat.size)})`,
)
console.log(
  `[bundle-validator] wrote static/_validator.schema.json (${fmt(schemaStat.size)})`,
)

// Stamp a sibling meta file so the artifact guard
// (scripts/ensure-validator-artifacts.ts) can detect a bundle that's
// out of sync with the currently-installed validator/schema versions —
// e.g. after `bun update @bids/validator` without re-running the
// postinstall. The guard reads `node_modules/.../package.json` and
// compares against this stamp.
// `@bids/validator` is an npm alias for `@jsr/bids__validator`, so the
// install path on disk is the alias name. The schema package keeps its
// native @jsr/bids__schema path.
const validatorVersion = await readPkgVersion(
  resolve(repoRoot, 'node_modules/@bids/validator/package.json'),
)
const schemaVersion = await readPkgVersion(
  resolve(repoRoot, 'node_modules/@jsr/bids__schema/package.json'),
)
const metaPath = resolve(
  repoRoot,
  'src/lib/validation/_validator.bundle.meta.json',
)
await writeFile(
  metaPath,
  `${JSON.stringify(
    { validator: validatorVersion, schema: schemaVersion },
    null,
    2,
  )}\n`,
)
console.log(
  `[bundle-validator] stamped versions: validator ${validatorVersion}, schema ${schemaVersion}`,
)

async function readPkgVersion(pkgJsonPath: string): Promise<string> {
  const raw = await readFile(pkgJsonPath, 'utf8')
  const parsed = JSON.parse(raw) as { version?: unknown }
  if (typeof parsed.version !== 'string') {
    throw new Error(`No "version" field in ${pkgJsonPath}`)
  }
  return parsed.version
}
