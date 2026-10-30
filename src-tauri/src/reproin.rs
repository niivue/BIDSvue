//! Native bridge to the `reproin-core` engine (ReproIn post-pass rules).
//! Rust inventories + plans; the renderer applies the ops through its
//! mutation layer (lease, backups, journal, rollback). `DropVolumes` is the
//! one voxel transform: streamed here to a temp sibling the renderer swaps in.

use std::fs;
use std::io::{BufReader, BufWriter, Read};
use std::path::{Path, PathBuf};

use reproin_core::{nifti, want, Data, Op, Options, Vfs, Want};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::trust::TrustStore;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReproinOptions {
    pub keep_derivatives: bool,
    pub shift_dates: bool,
    pub min_volumes: Option<i64>,
}

/// Inventory `root` and plan the post-pass. `exclude_top_level` names are
/// pre-existing destDir children: not walked (never planned against), only
/// present as empty placeholders so the engine sees the root is shared.
/// Returns `{ops, log, failures, roots, fatal}`; write ops carry UTF-8 `text`.
pub fn plan_tree(
    root: &Path,
    exclude_top_level: &[String],
    opts: &ReproinOptions,
) -> Result<Value, String> {
    let parts = root
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let mut tree = Vfs::new(parts);
    walk(root, "", exclude_top_level, &mut tree)
        .map_err(|e| format!("reproin inventory {}: {e}", root.display()))?;
    let d = Options::default();
    let plan = reproin_core::plan(
        tree,
        &Options {
            strict: false,
            keep_derivatives: opts.keep_derivatives,
            min_volumes: opts.min_volumes.unwrap_or(d.min_volumes),
            shift_dates: opts.shift_dates,
        },
    );
    let ops = plan
        .ops
        .iter()
        .map(op_json)
        .collect::<Result<Vec<_>, _>>()?;
    let r = plan.report;
    Ok(json!({
        "ops": ops,
        "log": r.log,
        "failures": r.failures,
        "roots": r.roots,
        "fatal": r.fatal,
    }))
}

/// Symlinks are skipped (never followed, never planned against).
fn walk(dir: &Path, rel: &str, exclude: &[String], v: &mut Vfs) -> std::io::Result<()> {
    for e in fs::read_dir(dir)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().into_owned();
        if rel.is_empty() && exclude.contains(&name) {
            // Pre-existing user data: visible to existence checks with its real
            // kind, never read, and never a subject (an empty `sub-*` would make
            // destDir a BIDS root and trigger scaffolding there).
            let ft = e.file_type()?;
            if ft.is_dir() && !name.starts_with("sub-") {
                v.add_dir(&name);
            } else if !ft.is_dir() {
                v.add_file(&name, e.metadata()?.len(), Data::Opaque);
            }
            continue;
        }
        let r = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        let ft = e.file_type()?;
        if ft.is_symlink() {
            // Fail closed: the mutation layer replaces links on write, which
            // would silently de-annex a git-annex/datalad file.
            return Err(std::io::Error::other(format!(
                "symlink in import tree: {r}"
            )));
        }
        if ft.is_dir() {
            v.add_dir(&r);
            walk(&e.path(), &r, exclude, v)?;
        } else if ft.is_file() {
            let size = e.metadata()?.len();
            let data = match want(&r, size) {
                Want::Full => Data::Full(fs::read(e.path())?),
                Want::Header => Data::Header(read_header(&e.path())?),
                Want::Nothing => Data::Opaque,
            };
            v.add_file(&r, size, data);
        }
    }
    Ok(())
}

fn read_header(p: &Path) -> std::io::Result<Vec<u8>> {
    let f = BufReader::new(fs::File::open(p)?);
    if p.to_string_lossy().ends_with(".gz") {
        return Ok(nifti::gunzip_prefix(f, nifti::HEADER_BYTES));
    }
    let mut b = Vec::new();
    f.take(nifti::HEADER_BYTES as u64).read_to_end(&mut b)?;
    Ok(b)
}

fn op_json(op: &Op) -> Result<Value, String> {
    Ok(match op {
        Op::Mkdir { path } => json!({"op": "mkdir", "path": path}),
        Op::Rename { from, to } => json!({"op": "rename", "from": from, "to": to}),
        Op::Write { path, bytes } => {
            let text = std::str::from_utf8(bytes)
                .map_err(|_| format!("reproin: non-UTF-8 write planned for {path}"))?;
            json!({"op": "write", "path": path, "text": text})
        }
        Op::Delete { path } => json!({"op": "delete", "path": path}),
        Op::RemoveDir { path } => json!({"op": "rmdir", "path": path}),
        Op::DropVolumes { path, indices } => {
            json!({"op": "dropVolumes", "path": path, "indices": indices})
        }
    })
}

/// Stream `path` minus `indices` volumes to a new temp sibling; returns its
/// path (same parent spelling as `path`). The source is never modified.
pub fn drop_volumes_to_temp(path: &Path, indices: &[usize]) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .ok_or_else(|| format!("reproin_drop_volumes: no file name: {}", path.display()))?
        .to_string_lossy();
    // No leading dot: plugin-fs's `<root>/**` scope must be able to rename it.
    let tmp = path.with_file_name(format!("{name}.bidsvue-tmp-{}", uuid::Uuid::new_v4()));
    let run = || -> std::io::Result<()> {
        let src = BufReader::new(fs::File::open(path)?);
        let dst = BufWriter::new(fs::File::create_new(&tmp)?);
        nifti::drop_volumes_file(&name, src, dst, indices)
    };
    run().map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("reproin_drop_volumes {}: {e}", path.display())
    })?;
    Ok(tmp)
}

#[tauri::command]
pub async fn reproin_plan(
    state: tauri::State<'_, TrustStore>,
    root: String,
    exclude_top_level: Vec<String>,
    options: ReproinOptions,
) -> Result<Value, String> {
    let root = crate::validate_authorized_path_canonical(&state, &root, "reproin_plan")?;
    tauri::async_runtime::spawn_blocking(move || plan_tree(&root, &exclude_top_level, &options))
        .await
        .map_err(|e| format!("reproin_plan: {e}"))?
}

#[tauri::command]
pub async fn reproin_drop_volumes(
    state: tauri::State<'_, TrustStore>,
    path: String,
    indices: Vec<usize>,
) -> Result<String, String> {
    // Canonical check: the read follows symlinks. The temp is created beside
    // the lexical path so the renderer's swap uses the spelling it holds.
    crate::validate_authorized_path_canonical(&state, &path, "reproin_drop_volumes")?;
    let lexical = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || drop_volumes_to_temp(&lexical, &indices))
        .await
        .map_err(|e| format!("reproin_drop_volumes: {e}"))?
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> ReproinOptions {
        ReproinOptions {
            keep_derivatives: false,
            shift_dates: false,
            min_volumes: None,
        }
    }

    /// 2x1x1x`nt` uint8 NIfTI-1 whose voxel bytes are the volume index.
    fn nii(nt: u8) -> Vec<u8> {
        let mut h = vec![0u8; 352];
        h[0..4].copy_from_slice(&348i32.to_le_bytes());
        for (i, d) in [4i16, 2, 1, 1, nt as i16, 1, 1, 1].iter().enumerate() {
            h[40 + 2 * i..42 + 2 * i].copy_from_slice(&d.to_le_bytes());
        }
        h[70..72].copy_from_slice(&2i16.to_le_bytes()); // DT_UINT8
        h[72..74].copy_from_slice(&8i16.to_le_bytes());
        for i in 0..5 {
            h[76 + 4 * i..80 + 4 * i].copy_from_slice(&1f32.to_le_bytes());
        }
        h[108..112].copy_from_slice(&352f32.to_le_bytes());
        h[344..348].copy_from_slice(b"n+1\0");
        for v in 0..nt {
            h.extend([v, v]);
        }
        h
    }

    #[cfg(unix)]
    #[test]
    fn symlink_in_import_tree_rejects_the_plan() {
        let t = tempfile::tempdir().unwrap();
        let anat = t.path().join("crlab/sub-01/anat");
        fs::create_dir_all(&anat).unwrap();
        fs::write(t.path().join("real.json"), "{}").unwrap();
        std::os::unix::fs::symlink(t.path().join("real.json"), anat.join("sub-01_T1w.json"))
            .unwrap();
        let e = plan_tree(t.path(), &["real.json".into()], &opts()).unwrap_err();
        assert!(e.contains("symlink in import tree"), "{e}");
    }

    #[test]
    fn excluded_files_and_subjects_never_become_a_root() {
        let t = tempfile::tempdir().unwrap();
        let mine = t.path().join("crlab/generic/sub-01/anat");
        fs::create_dir_all(&mine).unwrap();
        fs::write(mine.join("sub-01_T1w.json"), "{}").unwrap();
        fs::create_dir_all(t.path().join("sub-01")).unwrap();
        fs::write(t.path().join("participants.tsv"), "x").unwrap();
        fs::write(t.path().join("dataset_description.json"), "{}").unwrap();
        let ex = [
            "sub-01".into(),
            "participants.tsv".into(),
            "dataset_description.json".into(),
        ];
        let p = plan_tree(t.path(), &ex, &opts()).unwrap();
        assert_eq!(p["roots"], serde_json::json!(["crlab/generic"]));
        assert_eq!(p["failures"], serde_json::json!([]));
        let paths =
            p["ops"].as_array().unwrap().iter().flat_map(|o| {
                ["path", "from", "to"].map(|k| o[k].as_str().unwrap_or("").to_string())
            });
        assert!(
            paths
                .clone()
                .all(|x| x.is_empty() || x.starts_with("crlab/")),
            "ops stay inside the import"
        );
        assert!(paths
            .into_iter()
            .any(|x| x == "crlab/generic/participants.tsv"));
    }

    #[test]
    fn plan_excludes_pre_existing_children_and_serializes_ops() {
        let t = tempfile::tempdir().unwrap();
        let mine = t.path().join("Study/sub-01/anat");
        fs::create_dir_all(&mine).unwrap();
        fs::write(mine.join("sub-01_T1w.json"), "{}").unwrap();
        let other = t.path().join("Other/sub-02/anat");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("sub-02_T1w.json"), "{}").unwrap();
        let p = plan_tree(t.path(), &["Other".into()], &opts()).unwrap();
        let ops = p["ops"].as_array().unwrap();
        assert!(!ops.is_empty());
        for op in ops {
            let s = op.to_string();
            assert!(!s.contains("Other"), "planned against excluded child: {s}");
        }
        assert!(ops
            .iter()
            .any(|o| o["op"] == "write" && o["text"].is_string()));
        assert_eq!(p["fatal"], Value::Null);
    }

    #[test]
    fn drop_volumes_writes_temp_sibling_and_keeps_source() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("sub-01_asl.nii");
        fs::write(&src, nii(4)).unwrap();
        let tmp = drop_volumes_to_temp(&src, &[0, 2]).unwrap();
        assert_eq!(tmp.parent(), src.parent());
        assert_eq!(fs::read(&src).unwrap(), nii(4));
        let out = fs::read(&tmp).unwrap();
        assert_eq!(i16::from_le_bytes([out[48], out[49]]), 2); // dim[4]
        assert_eq!(&out[352..], &[1, 1, 3, 3]);
        // A truncated image fails without leaving a temp behind.
        let mut short = nii(4);
        short.truncate(355);
        fs::write(&src, short).unwrap();
        assert!(drop_volumes_to_temp(&src, &[0]).is_err());
        assert_eq!(fs::read_dir(t.path()).unwrap().count(), 2);
    }
}
