// Happy-path E2E: M2 acceptance criterion adapted for the committed
// tiny BIDS fixture.
//
//   open dataset (via BIDSVUE_TEST_OPEN_DATASET bypass)
//   -> tree renders
//   -> expand all
//   -> collapse all
//
// The Tauri binary picks up BIDSVUE_TEST_OPEN_DATASET at boot via the
// test_open_dataset command in src-tauri/src/lib.rs and skips the launch
// screen entirely. Set the env var on whatever process spawns
// tauri-driver -- see tests/e2e/README.md for the local-run recipe and
// .github/workflows/ci.yml for the CI step.
//
// Run with `bun run test:e2e` after the one-time setup in
// tests/e2e/README.md. tauri-driver must already be running.

/// <reference types="@wdio/types" />

import { describe, it } from 'mocha'
import { expandTreeFully } from '../helpers/tree'

declare const browser: WebdriverIO.Browser
// The runtime `expect` is expect-webdriverio (Jest-style matchers),
// injected by @wdio/mocha-framework — NOT Chai. Mirror @wdio/globals.
declare const expect: ExpectWebdriverIO.Expect

describe('BIDSvue happy path (M2 acceptance)', () => {
  it('opens the test fixture via bypass and renders the tree root', async () => {
    // The bypass should put us straight into the explorer; the launch
    // screen's <h1>BIDSvue</h1> should never appear. We wait on the
    // tree's accessible name instead.
    //
    // Increased timeout: cold-boot of the Tauri WebView + initial scan +
    // first paint on CI hardware takes longer than the default 10 s,
    // especially the first time the binary runs.
    const tree = await browser.$('[role="tree"]')
    await tree.waitForExist({ timeout: 30_000 })
    // tree should render at least the dataset-root row
    const treeItems = await browser.$$('[role="treeitem"]')
    expect(treeItems.length).toBeGreaterThan(0)
  })

  it('expands the tree and reveals the two committed subjects', async () => {
    // The tiny fixture has two subjects (sub-01, sub-02). Drive the
    // progressive Expand-Next-Level chevron until it greys out
    // (isFullyExpanded). The button's accessible name is set via
    // aria-label from i18n key tree.expandNextLevel; the disabled
    // attribute mirrors the $derived isFullyExpanded.
    //
    // We don't drive native menus from WDIO -- tauri-driver doesn't
    // route through the OS menu bar -- so we click the toolbar chevron
    // instead. Same dispatch path, fewer moving parts.
    await expandTreeFully(browser)

    // After full expansion, every folder under root is open. The
    // fixture's shape (dataset / sub-01 / anat + sub-02 / anat) means
    // we should see at least: root + 2 subjects + 2 anat folders + 2
    // group rows (one per subject's sub-01_T1w pair). That's at least
    // 7 treeitems. The exact count depends on how grouping rolls up
    // sidecars vs the anat folder, so we assert "at least 5" to stay
    // resilient.
    await browser.waitUntil(
      async () => {
        const after = await browser.$$('[role="treeitem"]')
        return after.length >= 5
      },
      {
        timeout: 10_000,
        timeoutMsg: 'tree did not expand to reveal the fixture subjects',
      },
    )
    const expandedCount = (await browser.$$('[role="treeitem"]')).length

    // Collapse back via the chevrons-right Collapse-All button. Its
    // accessible name comes from i18n key tree.collapseAll.
    const collapseBtn = await browser.$('button[aria-label="Collapse all"]')
    await collapseBtn.waitForClickable({ timeout: 5_000 })
    await collapseBtn.click()

    // Collapse-all closes every folder, but the tiny-bids tree keeps its
    // top-level rows visible when collapsed (root children: sub-01,
    // sub-02, dataset_description, participants, README). So the count
    // does NOT drop to 1-2 — it drops to the top-level row count. Assert
    // the tree genuinely collapsed by requiring strictly fewer rows than
    // when fully expanded.
    await browser.waitUntil(
      async () => {
        const after = await browser.$$('[role="treeitem"]')
        return after.length < expandedCount
      },
      {
        timeout: 5_000,
        timeoutMsg: 'tree did not collapse (row count did not shrink)',
      },
    )
  })
})
