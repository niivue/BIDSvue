// Esbuild-time replacement for `@jsr/bids__schema` (M3 Phase G).
//
// The upstream module's `mod.js` does `import schemaObject from "./schema.json"`
// (after our patch script normalises the JSR-style import attribute) and
// re-exports it as the named `schema`. The schema JSON is ~580 KB raw and
// inlines to ~5 MB of JS-object-literal source inside the validator bundle,
// dominating the bundle's transfer size.
//
// This file is the alias target esbuild substitutes for `@jsr/bids__schema`
// (see scripts/bundle-validator.ts). Instead of inlining the JSON, the bundle
// fetches it at module-evaluation time from the SvelteKit static directory
// (also written by the bundle script). The shim suspends via top-level await
// so consumers — including `setup/options.js`, which reads `schema.objects...`
// at its own top level — see a fully-resolved schema object by the time their
// imports return.
//
// Subpath imports like `@jsr/bids__schema/citation` are NOT aliased: esbuild's
// alias map is exact-match on the specifier, so the (much smaller) citation
// schema stays inlined where the validator's citation.js expects it.
//
// This file is never imported by app code directly — only by the offline
// esbuild step. Treat it as part of the bundle build, not the app.

const response = await fetch('/_validator.schema.json')
if (!response.ok) {
  throw new Error(
    `[validator bundle] failed to load /_validator.schema.json: HTTP ${response.status}`,
  )
}
const schemaObject = await response.json()

export const schema = schemaObject
