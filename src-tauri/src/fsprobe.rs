//! Symlink-capability probe for a clone destination.
//!
//! git-annex stores large files as symlinks into `.git/annex/objects`,
//! so whether a DataLad clone is usable — and whether it is usable on
//! anything but the machine that made it — depends on the destination
//! filesystem. The bad case is silent: macOS emulates symlinks on
//! exFAT/FAT with a magic-header regular file, so the clone looks
//! correct on the Mac that created it and reads as an unreadable
//! ~140-byte text file on Linux or Windows.
//!
//! Three outcomes, because a single "crippled" bit hides the
//! distinction that matters to the user:
//!
//! - [`SymlinkSupport::Native`] — real symlinks; the clone is portable.
//! - [`SymlinkSupport::Emulated`] — symlinks round-trip but the volume
//!   has no working POSIX permission bits (exFAT/FAT under macOS). The
//!   clone works here and is macOS-only on disk.
//! - [`SymlinkSupport::Unsupported`] — symlinks cannot be created at
//!   all (Windows without Developer Mode/admin, exFAT under Linux).
//!   Broken even locally: checkout writes each link target as text.
//!
//! The Native/Emulated discriminator is whether the write bit can
//! actually be removed from a regular file — the same signal git-annex
//! reports as "Filesystem does not allow removing write bit from files"
//! immediately before it declares a crippled filesystem. We deliberately
//! do NOT probe fifo support (git-annex's other crippled signal):
//! Windows has no fifos at all, so it would flag an NTFS volume whose
//! symlinks are perfectly good.
//!
//! Every probe artifact is created inside the caller-picked directory
//! and removed again; an unwritable directory yields `Err` rather than a
//! verdict, so the caller can stay silent instead of blaming symlinks
//! for a permissions problem.

use std::path::Path;

/// Verdict for one directory. Serializes as `"native"` / `"emulated"` /
/// `"unsupported"` for the renderer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SymlinkSupport {
    Native,
    Emulated,
    Unsupported,
}

#[cfg(unix)]
fn create_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}

#[cfg(not(any(unix, windows)))]
fn create_symlink(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other(
        "symlinks unsupported on this platform",
    ))
}

/// True when the write bit could be removed from `path` and the change
/// actually stuck. exFAT under macOS mounts `noowners`, so the `chmod`
/// either fails outright or silently no-ops — both read as "did not
/// stick", which is what we want.
fn write_bit_removable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let mut perms = meta.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o444);
        if std::fs::set_permissions(path, perms).is_err() {
            return false;
        }
        let Ok(after) = std::fs::metadata(path) else {
            return false;
        };
        after.permissions().mode() & 0o222 == 0
    }
    #[cfg(not(unix))]
    {
        perms.set_readonly(true);
        if std::fs::set_permissions(path, perms).is_err() {
            return false;
        }
        let Ok(after) = std::fs::metadata(path) else {
            return false;
        };
        after.permissions().readonly()
    }
}

/// Restore write permission so cleanup can unlink the file (Windows
/// refuses to delete a read-only file, and a read-only file in a
/// read-only-ish tree is a poor thing to leave behind either way).
fn restore_writable(path: &Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(0o644);
        }
        #[cfg(not(unix))]
        {
            perms.set_readonly(false);
        }
        let _ = std::fs::set_permissions(path, perms);
    }
}

/// Classify `dir`'s ability to hold real, portable symlinks.
///
/// `Err` means the probe could not run at all (unwritable directory) —
/// NOT that symlinks are unavailable. Callers should treat it as
/// "undetermined" and say nothing.
pub fn probe_symlink_support(dir: &Path) -> Result<SymlinkSupport, String> {
    let stamp = std::process::id();
    let target = dir.join(format!(".bidsvue-symlink-probe-{stamp}"));
    let link = dir.join(format!(".bidsvue-symlink-probe-{stamp}.link"));

    // Leftovers from a killed earlier probe would poison the result.
    let _ = std::fs::remove_file(&link);
    restore_writable(&target);
    let _ = std::fs::remove_file(&target);

    std::fs::write(&target, b"bidsvue symlink probe")
        .map_err(|e| format!("probe_symlink_support: write {}: {e}", target.display()))?;

    let verdict = classify(&target, &link);

    restore_writable(&target);
    let _ = std::fs::remove_file(&link);
    let _ = std::fs::remove_file(&target);
    Ok(verdict)
}

/// Inner classification, split out so the caller above owns cleanup on
/// every path.
fn classify(target: &Path, link: &Path) -> SymlinkSupport {
    // A bare file name keeps the link relative, matching how git-annex
    // writes its pointers.
    let Some(target_name) = target.file_name() else {
        return SymlinkSupport::Unsupported;
    };
    if create_symlink(Path::new(target_name), link).is_err() {
        return SymlinkSupport::Unsupported;
    }
    // Creation succeeding is not enough — require that it reads back as
    // a symlink AND round-trips to the target we asked for. A filesystem
    // that silently stored a regular file lands here.
    match std::fs::symlink_metadata(link) {
        Ok(meta) if meta.file_type().is_symlink() => {}
        _ => return SymlinkSupport::Unsupported,
    }
    match std::fs::read_link(link) {
        Ok(got) if got.as_os_str() == target_name => {}
        _ => return SymlinkSupport::Unsupported,
    }
    if write_bit_removable(target) {
        SymlinkSupport::Native
    } else {
        SymlinkSupport::Emulated
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique scratch dir under the system temp root; avoids taking a
    /// dev-dependency just for this.
    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bidsvue-fsprobe-{}-{}-{tag}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn temp_dir_reports_native_symlinks() {
        // The CI/dev temp dir is a real POSIX/NTFS-with-privilege
        // filesystem, so this pins the happy path.
        let dir = scratch("native");
        let got = probe_symlink_support(&dir).unwrap();
        assert_eq!(got, SymlinkSupport::Native);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn probe_leaves_no_artifacts_behind() {
        let dir = scratch("clean");
        probe_symlink_support(&dir).unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name())
            .collect();
        assert!(leftovers.is_empty(), "probe left {leftovers:?} behind");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn probe_is_repeatable_in_the_same_directory() {
        // Second call must not trip over the first call's artifacts.
        let dir = scratch("repeat");
        let first = probe_symlink_support(&dir).unwrap();
        let second = probe_symlink_support(&dir).unwrap();
        assert_eq!(first, second);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_directory_is_an_error_not_a_verdict() {
        // Undetermined must stay distinguishable from "no symlinks", so
        // the renderer can stay silent rather than warn wrongly.
        let dir = scratch("missing").join("does-not-exist");
        assert!(probe_symlink_support(&dir).is_err());
    }

    #[test]
    fn serializes_as_lowercase_for_the_renderer() {
        assert_eq!(
            serde_json::to_string(&SymlinkSupport::Emulated).unwrap(),
            "\"emulated\""
        );
        assert_eq!(
            serde_json::to_string(&SymlinkSupport::Unsupported).unwrap(),
            "\"unsupported\""
        );
    }
}
