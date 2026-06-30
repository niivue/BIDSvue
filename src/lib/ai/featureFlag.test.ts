// AI feature-gate tests.
//
// `aiFeatureEnabled` reads `import.meta.env.VITE_BIDSVUE_ENABLE_AI` at
// module load. Vite replaces that with the literal string at build time.
// The default test invocation (`bun test`) has no Vite preprocessing of
// `import.meta.env`, so the value resolves to `undefined` →
// `undefined !== '0'` → `aiFeatureEnabled === true`. That matches the
// default-ON behaviour: AI ships unless `VITE_BIDSVUE_ENABLE_AI=0`.

import { describe, expect, test } from 'bun:test'

import { aiFeatureEnabled } from './featureFlag'

describe('aiFeatureEnabled', () => {
  test('is a boolean', () => {
    // The const must be typed boolean — a future refactor that
    // accidentally widens to `boolean | undefined` would silently
    // gate the toolbar tile on a truthy-undefined check.
    expect(typeof aiFeatureEnabled).toBe('boolean')
  })

  test('defaults to ON when the env var is unset', () => {
    // `import.meta.env.VITE_BIDSVUE_ENABLE_AI` is undefined under
    // `bun test`. `undefined !== '0'` resolves to true — matching the
    // default-ON behaviour. Only an explicit `=0` build disables AI.
    expect(aiFeatureEnabled).toBe(true)
  })
})
