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

/// <reference types="@wdio/types" />

import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const binaryName = process.platform === 'win32' ? 'bidsvue.exe' : 'bidsvue'
const binaryPath = resolve('src-tauri', 'target', 'debug', binaryName)

// `browser` is a WDIO global available inside hooks at runtime.
declare const browser: WebdriverIO.Browser

const ARTIFACT_DIR = resolve('tests', 'e2e', 'artifacts')

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

  // On a failed test, dump diagnostics to STDOUT (captured verbatim by the
  // CI log — no artifact upload needed) so a bare "element still not
  // existing after 30000ms" timeout becomes actionable. The DOM probe is
  // the key signal: it reveals whether the WebView is stuck on the launch
  // screen, showing a dataset-open error banner, or blank — i.e. WHY the
  // `[role="tree"]` never appeared. A screenshot is also saved under
  // tests/e2e/artifacts/ (wire `actions/upload-artifact` in ci.yml to view
  // it). Every probe is best-effort: tauri-driver's wry/WebKitGTK backend
  // may not implement `getLogs`, and the session may already be torn down,
  // so each step is independently guarded and never masks the real failure.
  afterTest: async (
    test: { title: string },
    _context: unknown,
    result: { passed: boolean; error?: { message?: string } },
  ): Promise<void> => {
    if (result.passed) return
    const tag = `[e2e-diag] ${test.title}`
    console.error(`${tag}: FAILED: ${result.error?.message ?? 'unknown error'}`)
    try {
      const probe = await browser.execute(() => {
        const count = (sel: string) => document.querySelectorAll(sel).length
        const alertEl = document.querySelector(
          '[role="alert"], .error, .warning, .warning-button',
        ) as HTMLElement | null
        return {
          url: location.href,
          title: document.title,
          onLaunchScreen: !!document.querySelector('h1'),
          treeCount: count('[role="tree"]'),
          treeItemCount: count('[role="treeitem"]'),
          errorBanner: alertEl ? alertEl.innerText.slice(0, 800) : null,
          bodyText: (document.body?.innerText ?? '').slice(0, 2000),
        }
      })
      console.error(`${tag}: DOM probe: ${JSON.stringify(probe, null, 2)}`)
    } catch (e) {
      console.error(`${tag}: DOM probe failed: ${String(e)}`)
    }
    try {
      const logs = (await browser.getLogs('browser')) as Array<{
        level?: string
        message?: string
      }>
      console.error(`${tag}: WebView console (${logs.length} entries):`)
      for (const entry of logs) {
        console.error(`  ${entry.level ?? '?'}: ${entry.message ?? ''}`)
      }
    } catch (e) {
      console.error(`${tag}: getLogs unsupported/failed: ${String(e)}`)
    }
    try {
      mkdirSync(ARTIFACT_DIR, { recursive: true })
      const safe = test.title.replace(/[^a-z0-9]+/gi, '_').slice(0, 80)
      await browser.saveScreenshot(resolve(ARTIFACT_DIR, `${safe}.png`))
      console.error(`${tag}: screenshot -> tests/e2e/artifacts/${safe}.png`)
    } catch (e) {
      console.error(`${tag}: screenshot failed: ${String(e)}`)
    }
  },
}
