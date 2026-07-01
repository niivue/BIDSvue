#!/usr/bin/env bash
# Rewrite a Tauri-generated .deb so its control `Package:` field is `bidsvue`.
#
# Why: Tauri 2.11 derives the Debian `Package` name by kebab-casing
# `productName` ("BIDSvue" -> "bid-svue") and exposes NO config override
# (`bundle.linux.deb` has no name field). "bid-svue" is a poor apt package
# identity, so we fix it post-bundle. The in-app UI name, window title, desktop
# `Name=`, macOS `.app`, and the `/usr/bin/bidsvue` binary are all unaffected —
# only the Debian control `Package` (and the output filename) change.
#
# `dpkg-deb -R` (raw extract) + `-b` (rebuild) needs no root; `--root-owner-group`
# forces the rebuilt members to root:root so we don't ship files owned by the
# build user. Idempotent + asserts the result. (Audit 2026-07-01 P2.1.)
set -euo pipefail

deb="${1:?usage: repackage-deb.sh <path-to-.deb>}"
want_pkg="${2:-bidsvue}"
[ -f "$deb" ] || { echo "repackage-deb: no such file: $deb" >&2; exit 1; }
[ "${#want_pkg}" -ge 2 ] || { echo "repackage-deb: invalid Debian package name: $want_pkg" >&2; exit 1; }
case "$want_pkg" in
  '' | [!a-z0-9]* | *[!a-z0-9+.-]*)
    echo "repackage-deb: invalid Debian package name: $want_pkg" >&2
    exit 1
    ;;
esac
deb="$(realpath "$deb")"

cur="$(dpkg-deb -f "$deb" Package)"
ver="$(dpkg-deb -f "$deb" Version)"
arch="$(dpkg-deb -f "$deb" Architecture)"
out="$(dirname "$deb")/${want_pkg}_${ver}_${arch}.deb"

if [ "$cur" = "$want_pkg" ]; then
  if [ "$out" != "$deb" ]; then
    [ ! -e "$out" ] || { echo "repackage-deb: output already exists: $out" >&2; exit 1; }
    mv "$deb" "$out"
    echo "repackage-deb: Package already '$want_pkg'; renamed artifact to $out"
  else
    echo "repackage-deb: Package already '$want_pkg'; nothing to do."
  fi
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
dpkg-deb -R "$deb" "$work"
sed -i "s/^Package: .*/Package: ${want_pkg}/" "$work/DEBIAN/control"

[ ! -e "$out" ] || [ "$out" = "$deb" ] || { echo "repackage-deb: output already exists: $out" >&2; exit 1; }
dpkg-deb --root-owner-group -b "$work" "$out" >/dev/null

got="$(dpkg-deb -f "$out" Package)"
[ "$got" = "$want_pkg" ] || { echo "repackage-deb: assertion failed, Package='$got'" >&2; exit 1; }

# Drop the mis-named original so only the corrected artifact remains.
[ "$out" != "$deb" ] && rm -f "$deb"
echo "repackage-deb: '$cur' -> '$want_pkg'  ($out)"
