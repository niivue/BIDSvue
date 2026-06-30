import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'

const host = process.env.TAURI_DEV_HOST

// The BIDS validator is pre-bundled offline by scripts/bundle-validator.ts
// into src/lib/validation/_validator.bundle.js (gitignored). The renderer
// dynamic-imports that file. We no longer need a Vite plugin to alias
// @bids/validator deep paths -- esbuild handles the JSR-style CJS interop
// at build time and emits a clean ESM artifact the WebView can load
// without going through Vite's per-file shim layer.

export default defineConfig({
  plugins: [sveltekit()],

  // The renderer runs only in Tauri's WebViews (WKWebView / WebView2 /
  // WebKitGTK). All three target Safari 15+ / Chrome 89+ -- past the
  // top-level-await threshold. Vite's default build target is broader
  // (safari14, chrome87, ...) and Rollup rejects TLA against it, so the
  // M3 Phase G validator-bundle shim couldn't build with the defaults.
  // esbuild already targets safari15 inside scripts/bundle-validator.ts;
  // this aligns the Vite/Rollup pass.
  build: {
    target: ['es2022', 'safari15', 'chrome89', 'firefox89'],
    // Raise the chunk-size warning past the BIDS-validator bundle.
    // `src/lib/validation/_validator.bundle.js` is ~9 MB unminified
    // (~1.3 MB gzipped); it's lazy-imported so it doesn't hit the
    // app-boot path. 10 MB still surfaces a future unexpectedly-
    // large chunk that ISN'T the validator.
    chunkSizeWarningLimit: 10_000,
  },

  // Tauri expects a fixed port and obscures useful Rust output if Vite clears the screen.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
})
