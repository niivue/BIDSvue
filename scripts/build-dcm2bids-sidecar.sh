#!/usr/bin/env bash
# build-dcm2bids-sidecar.sh — build the dcm2bids Tauri sidecar binary.
#
# Why this exists: the upstream UNFmontreal/Dcm2Bids release ships an
# x86_64-only macOS binary that runs under Rosetta 2 on Apple Silicon
# AND targets a recent macOS deployment target. We rebuild from source
# with Nuitka against a portable CPython that targets macOS 11.0+, so
# the bundled sidecar is native arm64 and works on every Apple Silicon
# Mac (Big Sur+).
#
# Output:
#   resources/darwin/dcm2bids                              (committed,
#       source-of-truth — same convention as dcm2niix / allineate)
#   src-tauri/binaries/dcm2bids-aarch64-apple-darwin       (gitignored,
#       Tauri externalBin naming; copied from resources/darwin/ so the
#       sidecar resolver finds the binary at dev/build time)
#
# Requirements:
#   - macOS arm64 host (M-series)
#   - uv (https://docs.astral.sh/uv/) on PATH for the portable Python
#   - A local clone of UNFmontreal/Dcm2Bids — pass via DCM2BIDS_SRC env
#     var (REQUIRED; no default — round-24 audit cleanup, previous
#     maintainer-specific default would have silently failed in CI)
#
# Usage:
#   DCM2BIDS_SRC=~/src/Dcm2Bids bash scripts/build-dcm2bids-sidecar.sh
#   DCM2BIDS_SRC=/path/to/Dcm2Bids-3.2.0 bash scripts/build-dcm2bids-sidecar.sh
#
# Reproducing on CI: GitHub Actions macos-14 runner (M-series), set up
# uv via the official action, point DCM2BIDS_SRC at a checkout of the
# tagged dcm2bids release, run this script. Codesign + notarize via
# scripts/macos-release.sh.

set -euo pipefail

PY_VERSION="${PY_VERSION:-3.12}"
NUITKA_VERSION="${NUITKA_VERSION:-4.1}"

if [[ "$(uname -sm)" != "Darwin arm64" ]]; then
  echo "error: build-dcm2bids-sidecar.sh requires macOS arm64; got $(uname -sm)" >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "error: uv not on PATH. Install via 'brew install uv' or see https://docs.astral.sh/uv/." >&2
  exit 1
fi

if [[ -z "${DCM2BIDS_SRC:-}" ]]; then
  echo "error: DCM2BIDS_SRC environment variable is required." >&2
  echo "       Set it to a local clone of https://github.com/UNFmontreal/Dcm2Bids." >&2
  echo "       Example: DCM2BIDS_SRC=~/src/Dcm2Bids bash $0" >&2
  exit 1
fi

if [[ ! -d "$DCM2BIDS_SRC/dcm2bids/cli" ]]; then
  echo "error: DCM2BIDS_SRC=$DCM2BIDS_SRC does not look like a Dcm2Bids checkout (no dcm2bids/cli dir)." >&2
  echo "       Set DCM2BIDS_SRC to a clone of https://github.com/UNFmontreal/Dcm2Bids." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCE_BIN="$REPO_ROOT/resources/darwin/dcm2bids"
SIDECAR_DIR="$REPO_ROOT/src-tauri/binaries"
SIDECAR_BIN="$SIDECAR_DIR/dcm2bids-aarch64-apple-darwin"
WORK_DIR="$(mktemp -d -t bidsvue-dcm2bids-build)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> Installing portable CPython $PY_VERSION via uv"
uv python install "$PY_VERSION" >/dev/null
PY_BIN="$(uv python find "$PY_VERSION")"
echo "    using $PY_BIN"
echo "    minOS:  $(vtool -show-build "$PY_BIN" 2>/dev/null | awk '/minos/ {print $2}')"

echo "==> Creating venv in $WORK_DIR/venv"
"$PY_BIN" -m venv "$WORK_DIR/venv"

echo "==> Installing Nuitka $NUITKA_VERSION + dcm2bids runtime deps"
"$WORK_DIR/venv/bin/pip" install --quiet "nuitka==$NUITKA_VERSION" packaging

echo "==> Copying dcm2bids source into work dir"
cp -R "$DCM2BIDS_SRC/dcm2bids" "$WORK_DIR/dcm2bids"

echo "==> Building with Nuitka (onefile + LTO + anti-bloat)"
cd "$WORK_DIR"
"$WORK_DIR/venv/bin/python" -m nuitka \
  --onefile \
  --lto=yes \
  --enable-plugin=anti-bloat \
  --no-deployment-flag=self-execution \
  --output-filename=dcm2bids \
  --output-dir=dist \
  --remove-output \
  --assume-yes-for-downloads \
  dcm2bids/cli/dcm2bids.py

echo "==> Smoke test"
"$WORK_DIR/dist/dcm2bids" --version

echo "==> Staging to $RESOURCE_BIN (committed source-of-truth)"
mkdir -p "$(dirname "$RESOURCE_BIN")"
cp "$WORK_DIR/dist/dcm2bids" "$RESOURCE_BIN"
chmod +x "$RESOURCE_BIN"

echo "==> Mirroring to $SIDECAR_BIN (Tauri sidecar — gitignored)"
mkdir -p "$SIDECAR_DIR"
cp "$RESOURCE_BIN" "$SIDECAR_BIN"
chmod +x "$SIDECAR_BIN"

echo "==> Done."
echo "    arch:   $(lipo -archs "$RESOURCE_BIN")"
echo "    size:   $(ls -lh "$RESOURCE_BIN" | awk '{print $5}')"
echo "    minOS:  $(vtool -show-build "$RESOURCE_BIN" 2>/dev/null | awk '/minos/ {print $2}')"
echo
echo "    Note: binary is unsigned. scripts/macos-release.sh signs it"
echo "    during the bundle/notarize pass."
