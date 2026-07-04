// Test-only alias. BIDSvue canonicalizes every internal path to POSIX
// forward-slashes by design; tests build expected paths with Node's `path.join`
// (native backslashes on Windows), so comparisons must normalize both sides.
// Alias the PRODUCTION `toPosixSeparators` (audit 2026-07-03 P4: don't
// re-implement it — a divergent copy could drift from the real normalization
// the code under test uses). Mirrors the Rust side's `testpath.rs`. (An
// import + const alias, not an `export … from` barrel, to satisfy biome's
// noBarrelFile lint.)
import { toPosixSeparators } from '$lib/util/paths'

export const toPosix = toPosixSeparators
