// Shared E2E helpers for driving the TreeView toolbar.
//
// The tree has no single "expand all" control — only a progressive
// "Expand next level" chevron that opens one more depth per click and
// disables itself (isFullyExpanded) once nothing deeper remains. Both
// the happy-path and viewer specs need the fully-expanded tree, so the
// click-until-disabled loop lives here rather than being duplicated.

/// <reference types="@wdio/types" />

const EXPAND_SELECTOR = 'button[aria-label="Expand next level"]'

// Drive the progressive Expand-Next-Level chevron until it greys out
// (disabled === isFullyExpanded). The loose ceiling keeps a future,
// deeper fixture from looping forever; each click opens one more depth.
export async function expandTreeFully(
  browser: WebdriverIO.Browser,
): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const btn = await browser.$(EXPAND_SELECTOR)
    const disabled = await btn.getAttribute('disabled')
    if (disabled !== null) break
    await btn.waitForClickable({ timeout: 10_000 })
    await btn.click()
  }
}
