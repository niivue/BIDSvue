#!/usr/bin/env bash
# macos-release.sh — build, codesign, notarize, and staple a macOS distribution
# of BIDSvue. End-to-end: produces a notarized + stapled .dmg suitable for
# direct download.
#
# TODO(BIDSvue rebrand, 2026-05-21): re-establish the macOS signing identity
# under the BIDSvue project before the first signed release. The current
# pipeline reuses the prior project's Developer ID + notary profile; new repo
# needs a fresh Developer ID Application cert, a new `notarytool` keychain
# profile (default name `bidsvue-notary`), and — once auto-updater work
# resumes for v0.2 — a public minisign key committed to the repo for the
# updater's bundle-signature verification. See ROADMAP.md §1.
#
# Required environment:
#   APPLE_ID_APP           Codesigning identity for the .app, exactly as it
#                          appears in `security find-identity -v -p codesigning`.
#                          Format: "Developer ID Application: Name (TEAMID)"
#
# Required one-time local setup:
#   xcrun notarytool store-credentials bidsvue-notary \
#     --apple-id <id> --team-id <team> --password <app-specific-password>
#
# Optional environment:
#   BIDSVUE_MACOS_RELEASE_ENV
#                          Path to a local shell env file. Defaults to
#                          .env.macos-release, which is gitignored. The file is
#                          sourced before preflight so local Apple credentials
#                          and release overrides can stay outside Git.
#   BIDSVUE_NOTARY_PROFILE Keychain profile name created by notarytool.
#                          Defaults to "bidsvue-notary".
#   APPLE_ID_INSTALL       Installer cert. Currently unused (DMG flow does not
#                          need it). Kept in the contract so the same env file
#                          can drive a future .pkg pipeline.
#   BIDSVUE_SKIP_BUILD=1   Skip `tauri build`; useful when re-notarizing an
#                          already-built bundle. The script still asserts the
#                          embedded app version matches package metadata.
#   BIDSVUE_ALLOW_FILE_DEPS=1
#                          Opt out of the "no local-path deps in package.json"
#                          gate. Use ONLY for the M-PHY0 beta cycle while
#                          `@niivue/niivue` rc.8+ is still unreleased on npm —
#                          the DMG that comes out is technically reproducible
#                          (vite statically bundles the rc.8 bytes), but anyone
#                          else trying to rebuild it needs the same in-tree
#                          NiiVue commit at the same absolute path. Drop this
#                          override the moment rc.8 lands on npm.
#   BIDSVUE_DISABLE_AI=1
#                          Ship a no-AI DMG. AI is compiled into every build
#                          and ENABLED by default; this sets
#                          `VITE_BIDSVUE_ENABLE_AI=0` so the renderer
#                          dead-codes the AI tile + AIWindow out of the bundle.
#                          Default (unset) ships the AI assistant enabled.
#
# Build target: macOS arm64 only. This is a permanent project choice
# (Apple is dropping x86_64; neuroimaging hardware skews recent), not
# a v1.1 deferral. The script hard-asserts `uname -m == arm64`, stages
# the tracked aarch64-apple-darwin sidecars into
# `src-tauri/binaries/`, and passes `--target aarch64-apple-darwin`
# explicitly so a future toolchain default cannot drift.
#
# Usage:
#   scripts/macos-release.sh
#
# Output:
#   src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/BIDSvue_<version>_<arch>.dmg
#   (notarized + stapled; verified with spctl and stapler validate)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '[release] %s\n' "$*"; }
err() { printf '[release] %s\n' "$*" >&2; }

# --- local env file ----------------------------------------------------------

release_env_file="${BIDSVUE_MACOS_RELEASE_ENV:-$REPO_ROOT/.env.macos-release}"
if [[ -f "$release_env_file" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$release_env_file"
  set +a
  if [[ "$release_env_file" == "$REPO_ROOT/"* ]]; then
    log "loaded local release env: ${release_env_file#"$REPO_ROOT/"}"
  else
    log "loaded local release env: $release_env_file"
  fi
fi

# Compatibility with the pre-public-repo local env file names. Keep the
# canonical names below because Tauri/notarytool examples use them.
if [[ -z "${APPLE_ID:-}" && -n "${APPLE_ID_USER:-}" ]]; then
  export APPLE_ID="$APPLE_ID_USER"
fi
if [[ -z "${APPLE_PASSWORD:-}" && -n "${APP_SPECIFIC_PASSWORD:-}" ]]; then
  export APPLE_PASSWORD="$APP_SPECIFIC_PASSWORD"
fi

# --- preflight: release metadata --------------------------------------------

NOTARY_PROFILE="${BIDSVUE_NOTARY_PROFILE:-bidsvue-notary}"

required_vars=(APPLE_ID_APP)
missing=()
for v in "${required_vars[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    missing+=("$v")
  fi
done
if (( ${#missing[@]} > 0 )); then
  err "missing required env vars: ${missing[*]}"
  err "set APPLE_ID_APP to the exact Developer ID Application identity"
  exit 1
fi

status_output="$(git status --porcelain --untracked-files=normal)"
if [[ -n "$status_output" ]]; then
  if [[ "${BIDSVUE_ALLOW_DIRTY_RELEASE:-0}" == "1" ]]; then
    log "working tree is not clean (BIDSVUE_ALLOW_DIRTY_RELEASE=1, proceeding):"
    printf '%s\n' "$status_output" | sed 's/^/[release]   /' >&2
  else
    err "working tree is not clean; commit or stash, or set BIDSVUE_ALLOW_DIRTY_RELEASE=1"
    err "(rapid-development re-cuts: BIDSVUE_ALLOW_DIRTY_RELEASE=1 bun run release:macos)"
    printf '%s\n' "$status_output" >&2
    exit 1
  fi
fi

versions="$(
  bun -e '
    const fs = require("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
    const tauri = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
    const cargo = fs.readFileSync("src-tauri/Cargo.toml", "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (!pkg || !tauri || !cargo) process.exit(2);
    console.log(pkg);
    console.log(tauri);
    console.log(cargo);
  '
)"
package_version="$(printf '%s\n' "$versions" | sed -n '1p')"
tauri_version="$(printf '%s\n' "$versions" | sed -n '2p')"
cargo_version="$(printf '%s\n' "$versions" | sed -n '3p')"
if [[ "$package_version" != "$tauri_version" || "$package_version" != "$cargo_version" ]]; then
  err "version mismatch: package.json=$package_version tauri.conf.json=$tauri_version Cargo.toml=$cargo_version"
  exit 1
fi
APP_VERSION="$package_version"

# Block release if any dependency OR override uses a local-path spec (file:/,
# link:, or a relative ./ or ../ path). Dev-loop convenience like
# `"@niivue/niivue": "file:../mono/packages/niivue"` (M-PHY0 —
# the in-tree NiiVue rc.8 build) MUST be repointed to an npm-published version
# before notarisation, otherwise the DMG silently embeds a developer-local
# build that no other machine can reproduce. `overrides` is included because
# M-PHY0 also wires `@niivue/dev-images` through a sibling `file:` path; a
# future re-pin that flips niivue back to npm but leaves the override in place
# would still ship developer-local bytes.
local_path_offenders="$(
  bun -e '
    const fs = require("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const depBuckets = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
    const re = /^(file:|link:|\.\.?\/)/;
    const offenders = [];
    for (const bucket of depBuckets) {
      const deps = pkg[bucket];
      if (!deps) continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (typeof spec === "string" && re.test(spec)) {
          offenders.push(`${bucket}.${name}=${spec}`);
        }
      }
    }
    const overrides = pkg.overrides;
    if (overrides && typeof overrides === "object") {
      for (const [name, spec] of Object.entries(overrides)) {
        if (typeof spec === "string" && re.test(spec)) {
          offenders.push(`overrides.${name}=${spec}`);
        }
      }
    }
    if (offenders.length > 0) {
      console.log(offenders.join("\n"));
      process.exit(1);
    }
  ' 2>&1 || true
)"
if [[ -n "$local_path_offenders" ]]; then
  if [[ "${BIDSVUE_ALLOW_FILE_DEPS:-0}" == "1" ]]; then
    log "package.json has local-path specs (BIDSVUE_ALLOW_FILE_DEPS=1, proceeding); shipping in-tree bytes:"
    printf '%s\n' "$local_path_offenders" | sed 's/^/[release]   /' >&2
    log "WARNING: nobody else can reproduce this DMG without the same in-tree dep at the same path"
    log "WARNING: drop BIDSVUE_ALLOW_FILE_DEPS the moment the upstream dep ships on npm"
  else
    err "package.json still has local-path specs (file:/link:/./..) in dependencies or overrides; refusing to notarise:"
    printf '%s\n' "$local_path_offenders" | sed 's/^/[release]   /' >&2
    err "re-pin to npm-published versions before release (e.g. NiiVue rc.8+ once published)"
    err "(beta cycle override: BIDSVUE_ALLOW_FILE_DEPS=1 bun run release:macos)"
    exit 1
  fi
fi

# bunfig.toml#install.linker = "hoisted" is a dev-loop workaround paired with
# the `file:` niivue dep (M-PHY0) — it forces bun to hoist transitive deps
# (esbuild, @jsr/bids__schema) the file: install would otherwise leave in
# .bun/. Once niivue flips back to npm, the hoisting workaround MUST go too,
# otherwise production installs silently diverge from a clean clone. The
# BIDSVUE_ALLOW_FILE_DEPS=1 opt-out lifts the gate during the M-PHY0 beta cycle.
if [[ -f bunfig.toml ]]; then
  if grep -qE '^[[:space:]]*linker[[:space:]]*=[[:space:]]*"hoisted"' bunfig.toml; then
    if [[ "${BIDSVUE_ALLOW_FILE_DEPS:-0}" == "1" ]]; then
      log "bunfig.toml#install.linker = \"hoisted\" present (BIDSVUE_ALLOW_FILE_DEPS=1, proceeding)"
    else
      err "bunfig.toml#install.linker = \"hoisted\" is a dev-loop workaround paired with the M-PHY0 file: niivue dep; refusing to notarise:"
      err "  delete bunfig.toml (or drop the [install] linker setting) once @niivue/niivue is back on an npm spec"
      err "  (beta cycle override: BIDSVUE_ALLOW_FILE_DEPS=1 bun run release:macos)"
      exit 1
    fi
  fi
fi

# --- extract team ID from signing identity -----------------------------------

# Expected form: "Developer ID Application: Name Surname (XXXXXXXXXX)"
if [[ "$APPLE_ID_APP" =~ \(([A-Z0-9]{10})\)[[:space:]]*$ ]]; then
  APPLE_TEAM_ID="${BASH_REMATCH[1]}"
else
  err "could not parse 10-char team id from APPLE_ID_APP=\"$APPLE_ID_APP\""
  err "expected format: \"Developer ID Application: Name (XXXXXXXXXX)\""
  exit 1
fi

# --- preflight: host arch ----------------------------------------------------

host_arch="$(uname -m)"
if [[ "$host_arch" != "arm64" ]]; then
  err "macOS release builds are arm64 only (host reports $host_arch)"
  err "see AGENTS.md / LIMITATIONS.md — x86_64 macOS is intentionally not a target"
  exit 1
fi
log "host arch:       $host_arch"
log "version:         $APP_VERSION"

# --- preflight: datalad-rs submodule present --------------------------------

# The native DataLad / git-annex engine lives in the vendored
# rordenlab/datalad-rs submodule (path dep, workspace member). It is NOT
# fetched during build, so a fresh / submodule-less checkout would fail
# `cargo build` cryptically. Fail loud with the remediation instead.
if [[ ! -f "src-tauri/crates/datalad-rs/Cargo.toml" ]]; then
  err "missing datalad-rs submodule at src-tauri/crates/datalad-rs"
  err "run: git submodule update --init --recursive"
  exit 1
fi
log "datalad-rs:      submodule present"

# --- preflight: stage bundled sidecars for externalBin ----------------------

# Tauri's bundle.externalBin reads from src-tauri/binaries/<basename>-<triple>
# (gitignored). The tracked source-of-truth lives in resources/darwin/<basename>.
# Stage the arm64 sidecars before tauri build so a clean checkout produces a
# reproducible DMG; fail loud if any source is missing.
mkdir -p src-tauri/binaries
sidecar_basenames=(dcm2niix niimath bids-validator)
sidecar_triple="aarch64-apple-darwin"
for basename in "${sidecar_basenames[@]}"; do
  src="resources/darwin/$basename"
  dst="src-tauri/binaries/$basename-$sidecar_triple"
  if [[ ! -f "$src" ]]; then
    err "missing tracked sidecar: $src"
    err "refresh via the recipe in src-tauri/AGENTS.md (cp from upstream build/bin/)"
    exit 1
  fi
  cp "$src" "$dst"
  chmod +x "$dst"
done
log "staged sidecars: ${sidecar_basenames[*]} ($sidecar_triple)"

# --- preflight: mindgrab weights present -------------------------------------

# tauri.conf.json glob-bundles resources/common/mindgrab/*.safetensors as
# bundle.resources; the weight blob is gitignored (~574 KB binary). Fail
# loud if absent so the DMG isn't quietly built without the WebGPU deface
# capability.
mindgrab_weights="resources/common/mindgrab/net_mindgrab.safetensors"
if [[ ! -f "$mindgrab_weights" ]]; then
  err "missing mindgrab weights: $mindgrab_weights"
  err "see resources/common/mindgrab/README.md for how to obtain them"
  exit 1
fi
log "mindgrab weights present ($(du -h "$mindgrab_weights" | cut -f1))"

# --- preflight: tools + identity ---------------------------------------------

command -v xcrun     >/dev/null || { err "xcrun not found (install Xcode Command Line Tools)"; exit 1; }
command -v bun       >/dev/null || { err "bun not found on PATH"; exit 1; }
command -v codesign  >/dev/null || { err "codesign not found"; exit 1; }
command -v spctl     >/dev/null || { err "spctl not found"; exit 1; }

if ! security find-identity -v -p codesigning | grep -qF "$APPLE_ID_APP"; then
  err "codesigning identity not found in any unlocked keychain: $APPLE_ID_APP"
  err "available signing identities:"
  security find-identity -v -p codesigning >&2
  err "if the cert is installed but the keychain is locked, run: security unlock-keychain login.keychain"
  exit 1
fi

log "team id:         $APPLE_TEAM_ID"
log "signing as:      $APPLE_ID_APP"
log "notary profile:  $NOTARY_PROFILE"

# --- export env for tauri build ----------------------------------------------

# This is the name Tauri's macOS bundler reads for Developer ID signing.
# Notarization is handled below through a notarytool keychain profile so
# Apple credentials never enter argv and are not exported to the build env.
export APPLE_SIGNING_IDENTITY="$APPLE_ID_APP"
export APPLE_TEAM_ID

# --- M-AI1 feature-gate guard ------------------------------------------------
#
# AI is compiled into EVERY build (there is no Cargo `ai` feature — the
# `--mcp-server` subcommand + the `src/ai/` module tree always compile).
# DMG builds therefore ship with the AI assistant ENABLED by default; the
# renderer `VITE_BIDSVUE_ENABLE_AI` gate (default ON) decides whether the
# AI UI is exposed.
#
# `BIDSVUE_DISABLE_AI=1` ships a no-AI DMG: it sets
# `VITE_BIDSVUE_ENABLE_AI=0`, which dead-codes the toolbar tile +
# `<AIWindow />` mount + About-dialog AI rows out of the renderer bundle.
# The Rust AI surface is still present in the binary but is never reached
# (no UI invokes it).
disable_ai="${BIDSVUE_DISABLE_AI:-0}"
tauri_args=(tauri build --bundles app,dmg --target "$sidecar_triple")
if [[ "$disable_ai" == "1" ]]; then
  log "BIDSVUE_DISABLE_AI=1 — building a no-AI DMG (renderer UI dead-coded + Rust AI surface gated off)"
  # VITE_BIDSVUE_ENABLE_AI=0 dead-codes the AI UI; BIDSVUE_DISABLE_AI=1 is
  # read by the Rust `ai::ai_disabled_at_build()` gate (option_env! at
  # compile time) so the AI Tauri commands + `--mcp-server` refuse. Both
  # must reach the build subprocesses — export them.
  export VITE_BIDSVUE_ENABLE_AI=0
  export BIDSVUE_DISABLE_AI=1
else
  log "AI assistant enabled by default (set BIDSVUE_DISABLE_AI=1 for a no-AI DMG)"
  export VITE_BIDSVUE_ENABLE_AI=1
fi

# --- build -------------------------------------------------------------------

if [[ "${BIDSVUE_SKIP_BUILD:-0}" == "1" ]]; then
  log "BIDSVUE_SKIP_BUILD=1 — skipping tauri build"
else
  log "running: bun x ${tauri_args[*]}"
  bun x "${tauri_args[@]}"
fi

# --- locate artifacts --------------------------------------------------------

# `tauri build --target <triple>` puts artifacts under
# target/<triple>/release/bundle/ rather than target/release/bundle/.
bundle_dir="src-tauri/target/$sidecar_triple/release/bundle"

app_path="$(find "$bundle_dir/macos" -maxdepth 1 -name '*.app' -type d -print -quit 2>/dev/null || true)"
dmg_path="$(find "$bundle_dir/dmg"   -maxdepth 1 -name '*.dmg' -type f -print -quit 2>/dev/null || true)"

if [[ -z "$app_path" || ! -d "$app_path" ]]; then
  err "could not locate .app under $bundle_dir/macos"
  exit 1
fi
if [[ -z "$dmg_path" || ! -f "$dmg_path" ]]; then
  err "could not locate .dmg under $bundle_dir/dmg"
  exit 1
fi

log "artifacts:"
log "  app: $app_path"
log "  dmg: $dmg_path"

info_plist="$app_path/Contents/Info.plist"
bundle_short_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info_plist" 2>/dev/null || true)"
if [[ "$bundle_short_version" != "$APP_VERSION" ]]; then
  err "version mismatch in Info.plist: expected $APP_VERSION, got ${bundle_short_version:-<missing>}"
  err "refusing to notarize stale artifact"
  exit 1
fi
dmg_name="$(basename "$dmg_path")"
if [[ "$dmg_name" != *"$APP_VERSION"* ]]; then
  err "DMG filename does not include expected version $APP_VERSION: $dmg_name"
  exit 1
fi

# --- verify the .app codesignature -------------------------------------------

log "verifying .app codesignature (deep + strict)"
codesign --verify --deep --strict --verbose=2 "$app_path"

# --- notarize the dmg --------------------------------------------------------

# Apple stapling note: Tauri has already notarized + stapled the .app inside
# the dmg, so an extracted copy is also offline-Gatekeeper-clean. Here we
# notarize the dmg itself so a direct dmg download verifies without network.
#
# Credentials: prefer the env-var trio (APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID)
# that tauri-bundler already uses to notarize the .app — reusing them keeps
# one auth path and avoids requiring a one-time `notarytool store-credentials`
# setup. Fall back to the keychain profile (BIDSVUE_NOTARY_PROFILE,
# default "bidsvue-notary") if any of the env vars are missing.
notary_log="$(mktemp -t bidsvue-notary.XXXXXX.plist)"
trap 'rm -f "$notary_log"' EXIT

if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  log "notary credentials: env-var trio (APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID)"
  notary_auth=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_PASSWORD")
else
  log "notary credentials: keychain profile \"$NOTARY_PROFILE\""
  err_hint=$(
    cat <<EOF
no Apple notary credentials available:
  set APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID in your shell, OR
  one-time: xcrun notarytool store-credentials "$NOTARY_PROFILE" \\
              --apple-id <id> --team-id <team> --password <app-specific-password>
EOF
  )
  # `security find-generic-password` can't see notarytool credentials on
  # modern Xcode (Apple changed the storage backend); call notarytool
  # itself, which is the canonical consumer of the profile.
  if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
    err "$err_hint"
    exit 1
  fi
  notary_auth=(--keychain-profile "$NOTARY_PROFILE")
fi

log "submitting dmg to Apple notary service (this typically takes 2-10 minutes)"
xcrun notarytool submit "$dmg_path" \
  "${notary_auth[@]}" \
  --wait \
  --output-format plist > "$notary_log"

status="$(/usr/libexec/PlistBuddy -c 'Print :status' "$notary_log" 2>/dev/null || echo unknown)"
submission_id="$(/usr/libexec/PlistBuddy -c 'Print :id' "$notary_log" 2>/dev/null || echo unknown)"

log "notarization status: $status (id=$submission_id)"
if [[ "$status" != "Accepted" ]]; then
  err "notarization failed; fetching detailed log"
  xcrun notarytool log "$submission_id" "${notary_auth[@]}" >&2 || true
  exit 1
fi

# --- staple ------------------------------------------------------------------

log "stapling notary ticket onto dmg"
xcrun stapler staple "$dmg_path"
xcrun stapler validate "$dmg_path"

log "Gatekeeper assessment:"
spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg_path" || {
  err "spctl assessment failed — investigate before distributing"
  exit 1
}

# --- summary -----------------------------------------------------------------

dmg_size="$(du -h "$dmg_path" | cut -f1)"
app_size="$(du -sh "$app_path" | cut -f1)"
printf '\n'
log "done."
log "  dmg:        $dmg_path ($dmg_size)"
log "  app:        $app_path ($app_size)"
log "  signed by:  $APPLE_ID_APP"
log "  notarized:  $status (submission $submission_id)"
log "  stapled:    yes (verified)"
