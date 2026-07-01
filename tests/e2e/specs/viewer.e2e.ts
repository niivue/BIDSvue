// M5 acceptance: viewer happy-path. Adapted for the committed tiny BIDS
// fixture (sub-01_T1w.nii.gz / sub-02_T1w.nii.gz).
//
//   open dataset (via BIDSVUE_TEST_OPEN_DATASET bypass)
//   -> tree renders
//   -> expand all
//   -> click sub-01_T1w
//   -> NiivueViewer mounts and resolves
//
// Default local mode only proves the load pipeline does not hang: ready
// and attach-error both count as resolved. Release/CI mode sets
// BIDSVUE_E2E_REQUIRE_VIEWER_RENDER=1, which requires the Linux WebKitGTK
// WebGL2 fallback to attach and produce nonblank canvas pixels.

/// <reference types="@wdio/types" />

import { describe, it } from 'mocha'

declare const browser: WebdriverIO.Browser
declare const expect: Chai.ExpectStatic

type CanvasProbe = {
  ok: boolean
  reason?: string
  width?: number
  height?: number
  nonBlack?: number
  bins?: number
  luminanceRange?: number
}

async function probeNiivueCanvasPixels(): Promise<CanvasProbe> {
  const canvasProbe = await browser.execute(() => {
    const canvas = document.querySelector(
      '.niivue canvas',
    ) as HTMLCanvasElement | null
    if (canvas === null) return { ok: false, reason: 'missing-canvas' }

    const rect = canvas.getBoundingClientRect()
    if (rect.width < 10 || rect.height < 10) {
      return {
        ok: false,
        reason: 'canvas-has-no-layout-size',
        width: rect.width,
        height: rect.height,
      }
    }

    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null
    if (gl === null) {
      return {
        ok: false,
        reason: 'webgl2-context-unavailable',
        width: canvas.width,
        height: canvas.height,
      }
    }

    const width = gl.drawingBufferWidth
    const height = gl.drawingBufferHeight
    if (width < 10 || height < 10) {
      return { ok: false, reason: 'empty-drawing-buffer', width, height }
    }

    return { ok: true, width, height }
  })
  if (!canvasProbe.ok) return canvasProbe

  const screenshotBase64 = await browser.takeScreenshot()
  return await browser.execute(async (screenshot: string) => {
    const canvas = document.querySelector(
      '.niivue canvas',
    ) as HTMLCanvasElement | null
    if (canvas === null) return { ok: false, reason: 'missing-canvas' }

    const rect = canvas.getBoundingClientRect()
    if (rect.width < 10 || rect.height < 10) {
      return {
        ok: false,
        reason: 'canvas-has-no-layout-size',
        width: rect.width,
        height: rect.height,
      }
    }

    const image = new Image()
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('screenshot-image-load-failed'))
        image.src = `data:image/png;base64,${screenshot}`
      })
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        width: rect.width,
        height: rect.height,
      }
    }

    const cssWidth =
      window.visualViewport?.width ?? document.documentElement.clientWidth
    const cssHeight =
      window.visualViewport?.height ?? document.documentElement.clientHeight
    const scaleX = cssWidth > 0 ? image.naturalWidth / cssWidth : 1
    const scaleY = cssHeight > 0 ? image.naturalHeight / cssHeight : 1
    const sx = Math.max(0, Math.floor(rect.left * scaleX))
    const sy = Math.max(0, Math.floor(rect.top * scaleY))
    const sw = Math.max(1, Math.floor(rect.width * scaleX))
    const sh = Math.max(1, Math.floor(rect.height * scaleY))

    const scratch = document.createElement('canvas')
    scratch.width = sw
    scratch.height = sh
    const ctx = scratch.getContext('2d', { willReadFrequently: true })
    if (ctx === null) {
      return {
        ok: false,
        reason: '2d-context-unavailable',
        width: sw,
        height: sh,
      }
    }

    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh)
    const pixels = ctx.getImageData(0, 0, sw, sh).data
    const stride = Math.max(1, Math.floor((sw * sh) / 16_384))
    const bins = new Set<number>()
    let nonBlack = 0
    let minLum = 765
    let maxLum = 0
    for (let pixel = 0; pixel < sw * sh; pixel += stride) {
      const offset = pixel * 4
      const r = pixels[offset] ?? 0
      const g = pixels[offset + 1] ?? 0
      const b = pixels[offset + 2] ?? 0
      const lum = r + g + b
      if (lum > 24) nonBlack++
      if (lum < minLum) minLum = lum
      if (lum > maxLum) maxLum = lum
      bins.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4))
    }

    const luminanceRange = maxLum - minLum
    return {
      ok: nonBlack > 16 && bins.size >= 3 && luminanceRange >= 10,
      width: sw,
      height: sh,
      nonBlack,
      bins: bins.size,
      luminanceRange,
    }
  }, screenshotBase64)
}

describe('BIDSvue NiiVue viewer (M5 acceptance)', () => {
  it('mounts the viewer when a NIfTI is selected and the load resolves', async () => {
    const requireRender = process.env.BIDSVUE_E2E_REQUIRE_VIEWER_RENDER === '1'

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

    // The viewer is in one of three states: 'attaching' (transient), 'ready'
    // (controls row visible), or 'attach-error' (error overlay visible). Local
    // permissive mode accepts either terminal state to catch load hangs without
    // requiring GPU support. CI/release mode below turns this into a real render
    // gate.
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

    const errorOverlay = await browser.$('.niivue .error')
    const errorVisible = await errorOverlay.isExisting()
    if (requireRender) {
      const errorText = errorVisible ? await errorOverlay.getText() : ''
      expect(errorVisible, `viewer attach-error: ${errorText}`).to.equal(false)

      let lastProbe: CanvasProbe = { ok: false, reason: 'not-run' }
      try {
        await browser.waitUntil(
          async () => {
            lastProbe = await probeNiivueCanvasPixels()
            return lastProbe.ok
          },
          {
            timeout: 15_000,
            timeoutMsg:
              'NiivueViewer canvas did not render nonblank WebGL2 pixels',
          },
        )
      } catch (err) {
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}; last probe: ${JSON.stringify(lastProbe)}`,
        )
      }
    }

    // If we landed in the ready state, the four axis buttons should all be
    // present. Check just one to keep the assertion small and resistant to
    // label changes. In permissive local mode, skip when the viewer is in
    // attach-error mode.
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
