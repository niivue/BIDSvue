// WebdriverIO config for Tauri E2E tests. Drives the BIDSvue desktop app
// through tauri-driver (which speaks W3C WebDriver) and exercises the
// rendered UI as a real user would.
//
// Prerequisites (see tests/e2e/README.md):
//   - `cargo install tauri-driver --locked`
//   - `bun add -D @wdio/cli @wdio/local-runner @wdio/mocha-framework @wdio/spec-reporter`
//   - `bun tauri build --debug` (or release) so the binary exists
//
// This file intentionally uses dynamic `as unknown as` casts for the
// browser-binary path because WDIO's type defs don't know about Tauri's
// custom capability namespace.

import { resolve } from 'node:path'

const binaryName = process.platform === 'win32' ? 'bidsvue.exe' : 'bidsvue'
const binaryPath = resolve('src-tauri', 'target', 'debug', binaryName)

export const config = {
  runner: 'local' as const,
  specs: [resolve('tests', 'e2e', 'specs', '**', '*.e2e.ts')],

  maxInstances: 1,

  // Single capability: a Tauri WebView session at our built binary.
  // Mirrors the official tauri-docs WDIO example exactly -- DO NOT add
  // `browserName: 'wry'` here: newer tauri-driver releases enforce W3C
  // capability matching and reject the unknown browserName, surfacing as
  // `WebDriverError: Failed to match capabilities` at session creation.
  // The Selenium example sets `browserName('wry')` because Selenium's
  // Capabilities builder requires it; WDIO doesn't.
  capabilities: [
    {
      maxInstances: 1,
      'tauri:options': { application: binaryPath },
    } as unknown as WebdriverIO.Capabilities,
  ],

  logLevel: 'info' as const,
  bail: 0,
  baseUrl: '',
  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,

  // Point at the tauri-driver port. tauri-driver default is 4444.
  // 127.0.0.1 (not 'localhost') because some Linux setups resolve
  // localhost to ::1 (IPv6) while tauri-driver binds IPv4 only.
  hostname: '127.0.0.1',
  port: 4444,
  path: '/',

  framework: 'mocha' as const,
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd' as const,
    timeout: 60_000,
  },
}
