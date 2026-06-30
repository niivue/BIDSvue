// M5 acceptance: viewer happy-path. Adapted for the committed tiny BIDS
// fixture (sub-01_T1w.nii.gz / sub-02_T1w.nii.gz).
//
//   open dataset (via BIDSVUE_TEST_OPEN_DATASET bypass)
//   -> tree renders
//   -> expand all
//   -> click sub-01_T1w
//   -> NiivueViewer mounts and resolves to either ready (controls
//      visible) or attach-error (WebGL2 unavailable in headless CI)
//
// The dual-success assertion is intentional: in production we expect
// the viewer to attach cleanly; in xvfb / headless CI environments
// WebGL2 may be unavailable and the component's documented fallback
// path is to surface .error and hide the canvas. Either resolves the
// loading state — what we want to *prevent* is an indefinite "Loading
// volume…" spinner, which would indicate the load pipeline hung.

/// <reference types="@wdio/types" />

import { describe, it } from 'mocha'

declare const browser: WebdriverIO.Browser
declare const expect: Chai.ExpectStatic

describe('BIDSvue NiiVue viewer (M5 acceptance)', () => {
  it('mounts the viewer when a NIfTI is selected and the load resolves', async () => {
    // Tree should be ready from the launch bypass; wait for it
    // defensively in case spec ordering changes.
    const tree = await browser.$('[role="tree"]')
    await tree.waitForExist({ timeout: 30_000 })

    // Expand everything so the .nii.gz rows are reachable. The
    // toolbar buttons' title text is the stable selector (same as the
    // happy-path spec). Expand-all is idempotent; if a prior spec
    // already expanded the tree this is a no-op.
    const expandAllBtn = await browser.$('button[title*="Expand every folder"]')
    await expandAllBtn.waitForClickable({ timeout: 10_000 })
    await expandAllBtn.click()

    // The fixture has sub-01_T1w.{nii.gz,json} which the pairing
    // logic coalesces into a single group whose label is the
    // distinguishing suffix "T1w". Match by visible text — the
    // grouping rule is documented in CLAUDE.md and we'd want this
    // test to fail loudly if it ever changed.
    const t1Row = await browser.$('[role="treeitem"]*=T1w')
    await t1Row.waitForExist({ timeout: 10_000 })
    await t1Row.click()

    // The NiivueViewer's outer container mounts as soon as the
    // Preview pane routes to it (kind === 'nifti'). Existence is
    // independent of WebGL — even an attach-error path keeps this
    // div rendered with the .error overlay on top.
    const niivue = await browser.$('.niivue')
    await niivue.waitForExist({ timeout: 10_000 })

    // The viewer is in one of three states: 'attaching' (transient),
    // 'ready' (controls row visible), or 'attach-error' (error
    // overlay visible). The transient state should resolve within
    // a generous bound; if it doesn't, the load pipeline is hung
    // and the user would see an indefinite spinner.
    await browser.waitUntil(
      async () => {
        const controls = await browser.$('[aria-label="NiiVue controls"]')
        const error = await browser.$('.niivue .error')
        return (await controls.isExisting()) || (await error.isExisting())
      },
      {
        timeout: 30_000,
        timeoutMsg:
          'NiivueViewer never resolved to ready or attach-error within 30 s',
      },
    )

    // If we landed in the ready state, the four axis buttons should
    // all be present. Check just one to keep the assertion small and
    // resistant to label changes. Skip when the viewer is in
    // attach-error mode (WebGL unavailable in CI) — the surface
    // wasn't expected to render under that condition.
    const errorOverlay = await browser.$('.niivue .error')
    const errorVisible = await errorOverlay.isExisting()
    if (!errorVisible) {
      const multiBtn = await browser.$(
        '[aria-label="NiiVue controls"] button[role="radio"]',
      )
      expect(await multiBtn.isExisting()).to.equal(
        true,
        'expected at least one axis button in the control row',
      )
    }
  })
})
