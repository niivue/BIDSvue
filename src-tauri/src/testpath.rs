//! Portable absolute-path builder for unit tests.
//!
//! Many `process` / `trust` tests feed synthetic POSIX absolute paths
//! (`/Users/a/data`, `/tmp/out`, `/ds/sub-01/...`) into validators that
//! require an OS-absolute input (`Path::is_absolute`, lexical containment,
//! component walks). A leading-slash string IS absolute on Unix but is NOT
//! absolute on Windows (a drive-relative path), so those tests would falsely
//! fail on Windows even though the product code is correct.
//!
//! `abs` maps such a POSIX spec to a platform-absolute path: unchanged on
//! Unix, drive-letter-prefixed on Windows (`/Users/a` -> `C:/Users/a`). The
//! paths are purely lexical fixtures — no file at them is ever opened — so a
//! synthetic `C:` prefix is safe even when the drive contents differ. Forward
//! slashes are kept: Rust's Windows path parser treats `/` and `\` as
//! equivalent separators, every validator under test splits on both, and
//! keeping `/` avoids JSON backslash-escaping in the trust-file round-trip
//! fixtures. The result is byte-stable, so string round-trip assertions
//! (`list_trusted` -> JSON -> reload) compare equal to `abs(..)` on both OSes.
#![cfg(test)]

use std::path::PathBuf;

/// Build a platform-absolute path from a POSIX-style, leading-slash spec.
pub(crate) fn abs(posix: &str) -> String {
    debug_assert!(
        posix.starts_with('/'),
        "testpath::abs expects a POSIX absolute spec, got {posix:?}"
    );
    #[cfg(windows)]
    {
        format!("C:{posix}")
    }
    #[cfg(not(windows))]
    {
        posix.to_string()
    }
}

/// `abs` as a `PathBuf`.
pub(crate) fn absp(posix: &str) -> PathBuf {
    PathBuf::from(abs(posix))
}
