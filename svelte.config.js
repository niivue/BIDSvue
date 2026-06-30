import adapter from '@sveltejs/adapter-static'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      fallback: 'index.html',
    }),
    // BIDS validator pre-bundling has moved to scripts/bundle-validator.ts
    // (esbuild offline). The renderer imports the resulting bundle at
    // runtime via a relative path -- no alias plumbing required from
    // Vite or TypeScript.
    //
    // `@jsr/libs__xml` is still aliased to a stub because the @jsr
    // package ships its parser as a data:application/wasm;base64,...
    // URI Rollup can't bundle -- esbuild handles it in the offline
    // bundle, but Vite would still try to optimize it as a dep if any
    // app code imported it directly. Belt and braces.
    alias: {
      '@jsr/libs__xml': './src/lib/validation/_xmlStub.ts',
    },
  },
}

export default config
