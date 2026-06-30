# BIDSvue end-to-end tests

This directory contains the M2 Phase I E2E test surface, expanded in M3 Phase A.5 with a committed BIDS fixture, a test-mode bypass for the native file picker, and a CI job that runs it on every push.

The tests drive a built Tauri binary via the WebDriver protocol using [`tauri-driver`](https://v2.tauri.app/develop/tests/webdriver/) and [WebdriverIO](https://webdriver.io/).

**Why WebdriverIO and not Playwright** — the M2 plan originally listed Playwright. Tauri 2's WebDriver bridge (`tauri-driver`) speaks the W3C WebDriver protocol, which Playwright does not natively consume. WebdriverIO does, and it's the runner Tauri's own docs recommend.

## What this exercises

The default spec (`specs/happy-path.e2e.ts`) opens [`tests/fixtures/tiny-bids/`](../fixtures/tiny-bids/) via the `BIDSVUE_TEST_OPEN_DATASET` bypass (see [`src-tauri/src/lib.rs::test_open_dataset`](../../src-tauri/src/lib.rs)) and then drives the tree:

> open dataset (via bypass) → tree renders → Expand All → assert subjects visible → Collapse All → assert back near root

The bypass exists because `tauri-driver` can't drive the native file picker. In production the env var is never set and the bypass returns null, so the launch screen / auto-open-last-dataset flow runs as normal.

## CI

The Ubuntu CI job (`.github/workflows/ci.yml#e2e`) runs this suite headlessly via `xvfb-run`. Linux-only for now; Windows / macOS E2E coverage can land alongside any platform-specific issue that shows up.

## One-time local setup

```bash
# 1. Install tauri-driver (Rust toolchain required)
cargo install tauri-driver --locked

# 2. Build a debug Tauri binary that the driver can launch
cargo build --manifest-path src-tauri/Cargo.toml
```

The WDIO runner stack (`@wdio/cli` + plugins, plus `@types/mocha`) is now committed as `devDependencies` and lands automatically on `bun install`. The driver's binary path defaults to `src-tauri/target/debug/bidsvue` (Linux/macOS) or `src-tauri/target/debug/bidsvue.exe` (Windows) -- if you build a release variant instead, edit [`wdio.conf.ts`](wdio.conf.ts).

## Running locally

```bash
# In one shell: start tauri-driver. It must inherit the bypass env var so
# the binary it spawns reads it back from std::env.
BIDSVUE_TEST_OPEN_DATASET="$(pwd)/tests/fixtures/tiny-bids" tauri-driver

# In another shell:
bun run test:e2e
```

On a headless Linux box (SSH session, no display), wrap the first line:

```bash
BIDSVUE_TEST_OPEN_DATASET="$(pwd)/tests/fixtures/tiny-bids" \
  xvfb-run --auto-servernum tauri-driver
```

## Why platform-specific quirks matter

The Tauri webview is WKWebView on macOS, WebView2 on Windows, and webkit2gtk on Linux. Each handles modifier keys, drag events, scroll, focus, and native menus a little differently. WebdriverIO abstracts most of this but expect a handful of platform-conditional assertions over time.
