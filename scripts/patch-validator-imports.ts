// Postinstall patch for @bids/validator's Deno-style CJS imports.
//
// JSR's dnt-compiled output for the validator uses:
//
//   import { default as ignore } from "ignore"
//
// for CJS/ESM interop. This works under Deno (which gives CJS modules
// an explicit `default` named export) but fails in the Tauri WebKit
// WebView at module-eval time:
//
//   SyntaxError: Importing binding name 'default' cannot be resolved
//   by star export entries.
//
// The simple default-import form `import X from "cjs-pkg"` routes
// through Vite's synthetic default and works. We could rewrite at
// bundle time with a Vite transform plugin, but Vite pre-bundles
// node_modules through esbuild before user plugins see them, so the
// transform never fires. Easier path: rewrite the offending source
// files in node_modules directly, post `bun install`. Idempotent so
// running multiple times is safe.
//
// Files in @bids/validator@2.4.1 + @jsr/bids__schema that use the
// pattern (as of writing):
//   @bids/validator/src/files/ignore.js
//   @bids/validator/src/files/repo.js
//   @bids/validator/src/issues/datasetIssues.js
//   @jsr/bids__schema/mod.js (also uses the `with { type: "json" }`
//     import attribute, which we strip too because some Tauri WebKit
//     builds don't support it yet)
//
// We grep the listed roots rather than enumerating files so future
// validator / schema versions that add more callers stay covered until
// a real fix lands upstream.

import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const TARGET_ROOTS = [
  'node_modules/@bids/validator/src',
  'node_modules/@jsr/bids__schema',
]

// Two related patterns get rewritten:
//
//   import { default as X } from "Y" [with { type: "json" }]
//     -> import X from "Y"
//   export { default as X } from "Y" [with { type: "json" }]
//     -> import _bidsvueDefault_X from "Y"; export { _bidsvueDefault_X as X }
//
// The `import` form routes through Vite's synthetic CJS default and
// works in WebKit; the destructured `{ default as X }` form does not.
// The `export` form has the same problem -- and at least one validator
// dep (@jsr/bids__schema/citation/mod.js) uses it to re-export a JSON
// module. The `with { type: "json" }` attribute is Deno-specific syntax
// some Tauri WebKit builds don't accept; Vite + Rollup handle JSON
// imports as default exports natively, so dropping it is safe.
const IMPORT_PATTERN =
  /import\s*\{\s*default\s+as\s+([A-Za-z_$][\w$]*)\s*\}\s*from\s*(["'])([^"']+)\2(?:\s*with\s*\{[^}]*\})?/g
const EXPORT_PATTERN =
  /export\s*\{\s*default\s+as\s+([A-Za-z_$][\w$]*)\s*\}\s*from\s*(["'])([^"']+)\2(?:\s*with\s*\{[^}]*\})?/g

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walk(path)))
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path)
    }
  }
  return out
}

async function main(): Promise<void> {
  let patched = 0
  for (const root of TARGET_ROOTS) {
    let files: string[]
    try {
      files = await walk(root)
    } catch (err) {
      // bun install may run this hook before deps exist (first install
      // on a fresh checkout, when --frozen-lockfile reads the lockfile
      // from scratch). Best-effort skip; the next postinstall catches
      // it. Likewise on a clean clone where the user hasn't run
      // `bun install` yet.
      if ((err as { code?: string }).code === 'ENOENT') {
        console.warn(`[patch-validator-imports] ${root} not found, skipping`)
        continue
      }
      throw err
    }
    for (const path of files) {
      const before = await readFile(path, 'utf8')
      let after = before.replace(IMPORT_PATTERN, 'import $1 from $2$3$2')
      after = after.replace(
        EXPORT_PATTERN,
        // Synthesise a unique local binding so multiple export rewrites
        // in the same file don't clobber each other.
        (_match, name: string, quote: string, source: string) => {
          const tmp = `__bidsvue_default_${name}`
          return `import ${tmp} from ${quote}${source}${quote}; export { ${tmp} as ${name} }`
        },
      )
      // Defensive guard for utils/logger.js's parseStack(). The
      // upstream code does `const caller = lines[2].trim()` which
      // assumes V8's Error.stack format (header + at least 3 frames).
      // WebKit's stack format has neither the leading "Error" line
      // nor a guaranteed depth, so lines[2] is often undefined and
      // throws TypeError at the FIRST validator-internal logger
      // method access -- regardless of log level, because the proxy
      // handler runs parseStack unconditionally. Replace the unsafe
      // access with a fallback to lines[0] (or 'unknown'). Idempotent
      // and a no-op once patched.
      after = after.replace(
        /const caller = lines\[2\]\.trim\(\);?/,
        "const caller = (lines[2] ?? lines[0] ?? 'unknown').trim();",
      )
      if (after !== before) {
        await writeFile(path, after)
        patched++
        console.log(`[patch-validator-imports] patched ${path}`)
      }
    }
  }
  if (patched === 0) {
    console.log(
      '[patch-validator-imports] no files needed patching (already up to date or pattern not present in this version)',
    )
    return
  }
  console.log(`[patch-validator-imports] ${patched} file(s) patched`)
  // Vite's optimizeDeps cache is keyed by source-file hash but the
  // pre-bundle output is only regenerated on dep-list changes, not on
  // arbitrary node_modules edits. After we rewrite imports in deps,
  // any existing pre-bundle is stale and will keep serving the old
  // (broken) bundle to the dev WebView. Nuking the cache forces Vite
  // to re-optimize on next dev-server start.
  await rm('node_modules/.vite', { recursive: true, force: true })
  console.log(
    '[patch-validator-imports] cleared node_modules/.vite (Vite will re-bundle on next dev start)',
  )
}

await main()
