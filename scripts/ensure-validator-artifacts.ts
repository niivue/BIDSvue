// Verify the offline-built validator artifacts exist and match the
// currently-installed validator/schema versions. If they're missing or
// stale, rebuild them by invoking `scripts/bundle-validator.ts`.
//
// Why this exists: the validator bundle is gitignored and produced by
// `postinstall` (see package.json). That works on a clean `bun install`,
// but a fresh checkout where lifecycle scripts were skipped
// (`bun install --ignore-scripts`, a CI cache restore that didn't run
// scripts, or a partial install that errored before reaching the
// postinstall step) leaves the renderer importing a missing module at
// runtime with a "validator unavailable" status. A version bump of
// `@bids/validator` or `@jsr/bids__schema` without re-running postinstall
// produces the more confusing case where the bundle loads but uses old
// rules / schema.
//
// Run via:
//   bun run scripts/ensure-validator-artifacts.ts
// or automatically as part of `predev` / `prebuild` / `check`.
//
// Exits 0 when the artifacts are present and current (or were rebuilt
// successfully). Exits non-zero with a clear remediation hint when
// rebuilding fails.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(here, '..')

const bundlePath = resolve(repoRoot, 'src/lib/validation/_validator.bundle.js')
const schemaPath = resolve(repoRoot, 'static/_validator.schema.json')
const metaPath = resolve(
  repoRoot,
  'src/lib/validation/_validator.bundle.meta.json',
)
// `@bids/validator` is an npm alias for `@jsr/bids__validator` (see
// package.json — `"npm:@jsr/bids__validator@2.4.1"`), so the install
// path on disk is the alias name, not the JSR-prefixed name. The
// schema package keeps its native @jsr/bids__schema path.
const validatorPkg = resolve(
  repoRoot,
  'node_modules/@bids/validator/package.json',
)
const schemaPkg = resolve(
  repoRoot,
  'node_modules/@jsr/bids__schema/package.json',
)
const bundlerScript = resolve(repoRoot, 'scripts/bundle-validator.ts')

// Compile-time validator backend selector. v0.1 ships with the bundled
// `bids-validator-rs` sidecar as the default backend so beta testers
// exercise it; the JS validator stays as the opt-in fallback for parity
// comparisons. When the active build is the (default) Rust backend,
// the JS validator bundle is dead-code-eliminated by Vite/Rollup, so
// there's no point regenerating it. We short-circuit here so `predev`
// / `prebuild` / `check` don't pay the ~3 s esbuild cost (and don't
// materialise the ~9 MB on disk) when nothing imports the bundle.
//
// We still emit a placeholder `_validator.bundle.meta.json` and a stub
// `_validator.bundle.js`. The meta file is statically imported by
// `src/lib/about/appInfo.ts` (so the About dialog can surface a single
// `bidsValidator` field for both backends); the stub `.js` keeps any
// dead-but-resolved dynamic `import('./_validator.bundle.js')` in
// `runValidatorJs.ts` from breaking the build before Rollup's DCE
// drops the chunk in rust mode. Both stubs are tiny.
const backend = process.env.VITE_BIDSVUE_VALIDATOR_BACKEND ?? 'rust'
if (backend === 'rust') {
  const { copyFile, writeFile, mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(metaPath), { recursive: true })
  await writeFile(
    metaPath,
    `${JSON.stringify(
      {
        validator: 'bids-validator-rs',
        schema: '1.2.1',
        backend: 'rust',
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  if (!existsSync(bundlePath)) {
    await writeFile(
      bundlePath,
      // Stub: if anything reaches this module at runtime the dispatcher
      // is broken. Throw a loud error so the regression doesn't
      // silently fall back to a no-op.
      "throw new Error('[bidsvue] JS validator bundle was not built (VITE_BIDSVUE_VALIDATOR_BACKEND=rust). Rebuild with backend=js to use the in-WebView validator.');\n",
      'utf8',
    )
  }
  // `static/_validator.schema.json` is used by the sidecar editor's
  // schemaLoader.ts and isn't tied to the validator backend — it
  // describes the BIDS metadata fields the editor offers completion
  // for. Always emit it (the JS bundler does this as a side-effect;
  // we have to do it explicitly when we skip the bundler).
  const schemaSrc = resolve(
    repoRoot,
    'node_modules/@jsr/bids__schema/schema.json',
  )
  const schemaDest = resolve(repoRoot, 'static/_validator.schema.json')
  if (existsSync(schemaSrc)) {
    await mkdir(dirname(schemaDest), { recursive: true })
    await copyFile(schemaSrc, schemaDest)
  } else if (!existsSync(schemaDest)) {
    console.error(
      '[ensure-validator-artifacts] @jsr/bids__schema is not installed and no schema is staged.\n' +
        'Run `bun install` first.',
    )
    process.exit(1)
  }
  console.log(
    '[ensure-validator-artifacts] backend=rust; skipping JS validator bundle build (wrote stubs + schema)',
  )
  process.exit(0)
}

if (!existsSync(validatorPkg) || !existsSync(schemaPkg)) {
  console.error(
    '[ensure-validator-artifacts] @bids/validator or @jsr/bids__schema is not installed.\n' +
      'Run `bun install` first.',
  )
  process.exit(1)
}

const installed = {
  validator: await readPkgVersion(validatorPkg),
  schema: await readPkgVersion(schemaPkg),
}

let reason: string | null = null
if (!existsSync(bundlePath)) {
  reason = 'missing src/lib/validation/_validator.bundle.js'
} else if (!existsSync(schemaPath)) {
  reason = 'missing static/_validator.schema.json'
} else if (!existsSync(metaPath)) {
  reason = 'missing src/lib/validation/_validator.bundle.meta.json'
} else {
  const meta = await readMeta(metaPath)
  if (meta === null) {
    reason = 'meta file is unreadable or malformed'
  } else if (meta.validator !== installed.validator) {
    reason = `@bids/validator version drift (bundle ${meta.validator}, installed ${installed.validator})`
  } else if (meta.schema !== installed.schema) {
    reason = `@jsr/bids__schema version drift (bundle ${meta.schema}, installed ${installed.schema})`
  }
}

if (reason === null) {
  console.log(
    `[ensure-validator-artifacts] OK (validator ${installed.validator}, schema ${installed.schema})`,
  )
  process.exit(0)
}

console.log(`[ensure-validator-artifacts] rebuilding bundle: ${reason}`)
const result = spawnSync('bun', ['run', bundlerScript], {
  cwd: repoRoot,
  stdio: 'inherit',
})
if (result.error) {
  console.error(
    `[ensure-validator-artifacts] failed to spawn bun: ${result.error.message}`,
  )
  process.exit(1)
}
if (result.status !== 0) {
  console.error(
    '[ensure-validator-artifacts] bundle-validator.ts failed.\n' +
      'Run `bun run scripts/bundle-validator.ts` manually to debug.',
  )
  process.exit(result.status ?? 1)
}

async function readPkgVersion(pkgJsonPath: string): Promise<string> {
  const raw = await readFile(pkgJsonPath, 'utf8')
  const parsed = JSON.parse(raw) as { version?: unknown }
  if (typeof parsed.version !== 'string') {
    throw new Error(`No "version" field in ${pkgJsonPath}`)
  }
  return parsed.version
}

async function readMeta(
  path: string,
): Promise<{ validator: string; schema: string } | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as {
      validator?: unknown
      schema?: unknown
    }
    if (
      typeof parsed.validator !== 'string' ||
      typeof parsed.schema !== 'string'
    ) {
      return null
    }
    return { validator: parsed.validator, schema: parsed.schema }
  } catch {
    return null
  }
}
