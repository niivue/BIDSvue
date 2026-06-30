use serde::{Deserialize, Serialize};
use std::{
    path::{Component, Path, PathBuf},
    process::Command,
};

use crate::trust::TrustStore;

/// One streamed line from a long-running native DataLad spawn. Sent
/// through the renderer-provided `Channel<DataladStreamLine>` so the
/// UI can surface live progress instead of waiting for the entire
/// operation to finish. M-DL8 closure: only the native engine emits
/// these now; the CLI runner is gone.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataladStreamLine {
    /// Which stream produced the line. `stdout` for per-file
    /// progress, `stderr` for warnings (e.g. retry-skipped URLs).
    pub kind: &'static str,
    /// One UTF-8 line (terminator stripped).
    pub line: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOutput {
    stdout: String,
    stderr: String,
    /// Human-readable explanation when the spawned process exited with
    /// a tool-specific partial-success code (e.g. dcm2niix
    /// `kEXIT_SOME_OK_SOME_BAD = 8` or `kEXIT_INCOMPLETE_VOLUMES_FOUND = 10`
    /// — some series converted, some failed for benign reasons like
    /// `localizer` slice-orientation mismatches). `None` on a clean
    /// success. The renderer treats this as a warning, not a failure:
    /// the post-pass still runs on whatever DID land on disk.
    #[serde(skip_serializing_if = "Option::is_none")]
    partial_failure_warning: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeOutput {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Clone, Copy)]
enum ProcessBinary {
    Sidecar(&'static str),
    External(&'static str),
}

#[derive(Debug)]
struct ValidatedImportRun {
    binary: ProcessBinary,
    args: ValidatedImportArgs,
    use_sidecar_path: bool,
}

#[derive(Debug)]
struct ValidatedImportArgs {
    cwd: PathBuf,
    src: PathBuf,
    dest: PathBuf,
    heuristic_path: Option<PathBuf>,
    config_path: Option<PathBuf>,
}

#[derive(Debug)]
struct ValidatedDefaceRun {
    binary: ProcessBinary,
    cwd: PathBuf,
    /// The exact argv to spawn — CANONICAL (symlink-resolved) paths in both
    /// branches, so no raw renderer byte reaches the child. `niimath_dilate`:
    /// canonical in/out + constant flags + re-stringified threshold (built by
    /// `resolve_niimath_dilate_spawn`). Sidecar defacers: canonical input +
    /// bundled template/mask + canonical output and cwd (built by
    /// `resolve_deface_spawn`).
    argv: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProcessAuth {
    src_dir_token: String,
    dest_dir_parent_token: String,
    heuristic_token: Option<String>,
    config_token: Option<String>,
}

#[derive(Debug)]
struct CommandExit {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    label: String,
    cancelled: bool,
}

fn should_apply_git_safety_env(binary: ProcessBinary) -> bool {
    matches!(binary, ProcessBinary::External("git" | "datalad"))
}

fn git_safety_env_pairs() -> &'static [(&'static str, &'static str)] {
    &[
        ("GIT_CONFIG_COUNT", "2"),
        ("GIT_CONFIG_KEY_0", "core.hooksPath"),
        ("GIT_CONFIG_VALUE_0", "/dev/null"),
        ("GIT_CONFIG_KEY_1", "core.fsmonitor"),
        ("GIT_CONFIG_VALUE_1", "false"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GIT_ASKPASS", "/usr/bin/false"),
        ("SSH_ASKPASS", "/usr/bin/false"),
        ("DISPLAY", ""),
    ]
}

/// Prevent repository-controlled Git hooks / fsmonitor helpers in an opened
/// dataset from executing during BIDSvue-managed Git operations. Only the
/// blocking std::process flavour survives the M-DL8 sweep — the tokio
/// variant lived only inside `run_streaming_process`.
fn apply_git_safety_env_std(command: &mut Command) {
    for (key, value) in git_safety_env_pairs().iter().copied() {
        command.env(key, value);
    }
}

/// Run an import-side native converter.
///
/// Documented Rust exception: this is a security boundary. The WebView
/// no longer gets Tauri shell execute permission with `args: true`;
/// it names a known tool id and Rust validates the complete argv shape
/// before spawning the fixed sidecar or external executable.
#[tauri::command]
pub async fn run_import_process(
    state: tauri::State<'_, TrustStore>,
    tool_id: String,
    argv: Vec<String>,
    auth: ImportProcessAuth,
) -> Result<ProcessOutput, String> {
    let run = validate_import_run(&tool_id, &argv)?;
    authorize_import_run(&state, &run, &auth)?;
    let tool_id_moved = tool_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let exit = run_process(run.binary, &argv, Some(&run.args.cwd), run.use_sidecar_path)?;
        require_success_with_partial_ok(exit, &tool_id_moved)
    })
    .await
    .map_err(|e| format!("run_import_process: join error: {e}"))?
}

/// Like `require_success`, but treats tool-specific partial-success
/// exit codes as success while preserving the explanation. Today the
/// only tools with partial-success semantics are the dcm2niix-backed
/// importers (`dcm2niix-reproin` and `pet2bids`); both share the
/// same exit-code table from `dcm2niix/console/nii_dicom.h`:
///
///   `kEXIT_SOME_OK_SOME_BAD = 8`        — one or more series failed
///     (e.g. localizer slice-orientation mismatch, issue 894) but the
///     rest converted cleanly. The user-actionable items typically
///     end up in `Unknown/` or are skipped entirely; the post-pass
///     handles them.
///   `kEXIT_INCOMPLETE_VOLUMES_FOUND = 10` — at least one BOLD/DWI
///     series was missing volumes (issue 515). dcm2niix wrote what it
///     could; the user may want to inspect the partial output.
///
/// Both codes mean "some output landed on disk and is usable"; we
/// surface the stderr tail as a warning the renderer can display but
/// otherwise proceed with the post-pass. Any other non-zero exit is
/// still a hard failure.
///
/// Mirrors `_run_dcm2niix`'s `PARTIAL_OK = (8, 10)` handling in
/// `dcm2niix/tools/reproinx.py`.
fn require_success_with_partial_ok(
    exit: CommandExit,
    tool_id: &str,
) -> Result<ProcessOutput, String> {
    if exit.cancelled {
        return Err(format!("{}: cancelled by user", exit.label));
    }
    let partial_ok_codes: &[i32] = match tool_id {
        "dcm2niix-reproin" | "pet2bids" => &[8, 10],
        _ => &[],
    };
    let code = exit.code;
    if code == Some(0) {
        return Ok(ProcessOutput {
            stdout: exit.stdout,
            stderr: exit.stderr,
            partial_failure_warning: None,
        });
    }
    if let Some(c) = code {
        if partial_ok_codes.contains(&c) {
            let tail = exit.stderr.trim();
            let kind = match c {
                8 => "some series failed (kEXIT_SOME_OK_SOME_BAD)",
                10 => "incomplete volumes in one or more series (kEXIT_INCOMPLETE_VOLUMES_FOUND)",
                _ => "partial conversion",
            };
            let warning = if tail.is_empty() {
                format!(
                    "{} exited with code {c} ({kind}); continuing with post-pass against what landed on disk.",
                    exit.label
                )
            } else {
                format!(
                    "{} exited with code {c} ({kind}); continuing with post-pass against what landed on disk.\n\n{}",
                    exit.label, tail
                )
            };
            return Ok(ProcessOutput {
                stdout: exit.stdout,
                stderr: exit.stderr,
                partial_failure_warning: Some(warning),
            });
        }
    }
    // Anything else is a real failure.
    let tail = exit.stderr.trim();
    Err(format!(
        "{} exited with code {}: {}",
        exit.label,
        code.map(|c| c.to_string()).unwrap_or_else(|| "null".into()),
        if tail.is_empty() { "<no stderr>" } else { tail }
    ))
}

/// Probe importer availability with fixed version args.
///
/// Non-zero exits are returned to the renderer so the existing
/// detection UI can distinguish "ran but unavailable" from spawn
/// failures. Spawn failures still reject.
#[tauri::command]
pub async fn probe_import_tool(tool_id: String) -> Result<ProbeOutput, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (binary, argv, use_sidecar_path) = probe_spec(&tool_id)?;
        let exit = run_process(binary, &argv, None, use_sidecar_path)?;
        Ok(ProbeOutput {
            exit_code: exit.code,
            stdout: exit.stdout,
            stderr: exit.stderr,
        })
    })
    .await
    .map_err(|e| format!("probe_import_tool: join error: {e}"))?
}

/// Run a sidecar defacing process.
///
/// Documented Rust exception: this is the same shell-execution
/// security boundary as `run_import_process`, with an even narrower
/// argv contract for the `niimath` deface sidecar (backs the
/// `allineate` 12-DOF deface tool).
#[tauri::command]
pub async fn run_deface_process(
    app: tauri::AppHandle,
    state: tauri::State<'_, TrustStore>,
    tool_id: String,
    argv: Vec<String>,
    dataset_root: String,
) -> Result<ProcessOutput, String> {
    // `niimath_dilate` is the mindgrab 8 mm mask-dilation pass. It runs the
    // SAME bundled niimath binary as the defacers (no WASM niimath in the
    // app — the executable handles larger files and is faster), but operates
    // on a temporary mask file the renderer wrote under `$APPCACHE`, so it
    // has no template/mask/datasetRoot — only cache-scoped in+out paths.
    let run = if tool_id == "niimath_dilate" {
        validate_niimath_dilate_run(&app, &argv)?
    } else {
        validate_deface_run(&app, &state, &tool_id, &argv, &dataset_root)?
    };
    // Spawn `run.argv`, NOT the renderer's raw `argv`: in BOTH branches it is
    // the CANONICAL (symlink-resolved) argv that passed validation, so the
    // bytes that were authorized are the bytes the child receives — no raw
    // renderer path is ever handed to niimath.
    tauri::async_runtime::spawn_blocking(move || {
        let exit = run_process(run.binary, &run.argv, Some(&run.cwd), false)?;
        require_success(exit)
    })
    .await
    .map_err(|e| format!("run_deface_process: join error: {e}"))?
}

/// Run the bundled Rust port of the BIDS validator (`bids-validator-rs`)
/// against an opened dataset. Selected at build time by the renderer-side
/// dispatcher in `runValidator.ts` when
/// `VITE_BIDSVUE_VALIDATOR_BACKEND=rust` is set; the in-WebView JS
/// validator stays as the default.
///
/// Argv is fixed by Rust to
/// `[<datasetRoot>, --format json, --content-mode parity, --link-mode no-follow]`.
/// The renderer doesn't get to pass flags — it only hands over the
/// dataset root, which must already be a runtime-authorized dataset root
/// from `authorize_runtime_dataset_root` (fs-only widened paths from
/// `allow_fs_scope` are not dataset roots and are rejected).
///
/// Output is the raw JSON-decoded validator result (`{"issues":{...}}`),
/// returned to the renderer as `serde_json::Value` so Tauri's IPC layer
/// serialises the parsed structure once rather than re-escaping the
/// ~6 MB stdout string for ds005016-scale datasets.
#[tauri::command]
pub async fn run_bids_validator(
    state: tauri::State<'_, TrustStore>,
    dataset_root: String,
) -> Result<serde_json::Value, String> {
    let root = validate_abs_path(&dataset_root, "datasetRoot")?;
    if !state.is_under_any_runtime_path(&root)? {
        return Err(format!(
            "run_bids_validator: datasetRoot is not authorized in this session: {}",
            root.display()
        ));
    }
    let argv = vec![
        root.to_string_lossy().into_owned(),
        "--format".into(),
        "json".into(),
        "--content-mode".into(),
        "parity".into(),
        "--link-mode".into(),
        "no-follow".into(),
    ];
    let exit = tauri::async_runtime::spawn_blocking(move || {
        run_process(ProcessBinary::Sidecar("bids-validator"), &argv, None, false)
    })
    .await
    .map_err(|e| format!("run_bids_validator: join error: {e}"))??;
    // bids-validator-rs follows the Deno validator's exit convention:
    // exit 0 when the dataset has no errors, exit 1 when at least one
    // error-severity issue is present (warnings still exit 0). Both
    // outcomes write the same `{"issues": ...}` JSON to stdout, and
    // BIDSvue surfaces issues regardless of severity — so we accept
    // either code. Any other exit (segfault, missing binary, argv
    // rejection) still fails through `require_success`.
    if exit.cancelled {
        return Err(format!("{}: cancelled by user", exit.label));
    }
    if !matches!(exit.code, Some(0) | Some(1)) {
        let tail = exit.stderr.trim();
        return Err(format!(
            "{} exited with code {}: {}",
            exit.label,
            exit.code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "null".into()),
            if tail.is_empty() { "<no stderr>" } else { tail }
        ));
    }
    serde_json::from_str::<serde_json::Value>(&exit.stdout)
        .map_err(|e| format!("run_bids_validator: failed to parse validator output: {e}"))
}

fn probe_spec(tool_id: &str) -> Result<(ProcessBinary, Vec<String>, bool), String> {
    match tool_id {
        "dcm2niix-reproin" | "pet2bids" => {
            Ok((ProcessBinary::Sidecar("dcm2niix"), vec!["-h".into()], false))
        }
        "dcm2bids" => Ok((
            ProcessBinary::External("dcm2bids"),
            vec!["--version".into()],
            true,
        )),
        "heudiconv" => Ok((
            ProcessBinary::External("heudiconv"),
            vec!["--version".into()],
            false,
        )),
        "ezbids-meg" => Err("probe_import_tool: ezbids-meg is in-process JS".into()),
        other => Err(format!("probe_import_tool: unknown tool id \"{other}\"")),
    }
}

fn validate_import_run(tool_id: &str, argv: &[String]) -> Result<ValidatedImportRun, String> {
    let (binary, use_sidecar_path, args) = match tool_id {
        "dcm2niix-reproin" => Ok((
            ProcessBinary::Sidecar("dcm2niix"),
            false,
            validate_reproin_argv(argv)?,
        )),
        "pet2bids" => Ok((
            ProcessBinary::Sidecar("dcm2niix"),
            false,
            validate_pet2bids_argv(argv)?,
        )),
        "dcm2bids" => Ok((
            ProcessBinary::External("dcm2bids"),
            // PATH-injected so the user's PATH-installed dcm2bids spawns
            // the bundled dcm2niix sibling without needing its own.
            true,
            validate_dcm2bids_argv(argv)?,
        )),
        "heudiconv" => Ok((
            ProcessBinary::External("heudiconv"),
            false,
            validate_heudiconv_argv(argv)?,
        )),
        "ezbids-meg" => Err("run_import_process: ezbids-meg is in-process JS".into()),
        other => Err(format!("run_import_process: unknown tool id \"{other}\"")),
    }?;
    Ok(ValidatedImportRun {
        binary,
        args,
        use_sidecar_path,
    })
}

/// The path-validated argv shape for a niimath deface run, BEFORE the
/// app-dependent resource/trust/cache checks. Pure (no AppHandle) so it can be
/// unit-tested directly (audit 2026-06-27 round 8 P3).
#[derive(Debug, Clone)]
struct DefaceArgvParts {
    input: PathBuf,
    template: PathBuf,
    mask: PathBuf,
    output: PathBuf,
}

/// Validate the niimath deface argv SHAPE — tool id → op flag, arg count, flag
/// positions, and that every path is an absolute `.nii`/`.nii.gz`. App-free.
fn validate_deface_argv(tool_id: &str, argv: &[String]) -> Result<DefaceArgvParts, String> {
    // The sidecar defacer runs the niimath binary with the `-deface` op flag.
    let op_flag = match tool_id {
        "allineate" => "-deface",
        _ => {
            return Err(format!(
                "run_deface_process: unknown sidecar deface tool \"{tool_id}\""
            ))
        }
    };
    if argv.len() != 6 {
        return Err(format!(
            "run_deface_process: niimath deface expects 6 args, got {}",
            argv.len()
        ));
    }
    // niimath <input> -robustfov <op> <template> <mask> <output>
    expect(argv, 1, "-robustfov", tool_id)?;
    expect(argv, 2, op_flag, tool_id)?;
    Ok(DefaceArgvParts {
        input: validate_nifti_path(&argv[0], "input")?,
        template: validate_nifti_path(&argv[3], "template")?,
        mask: validate_nifti_path(&argv[4], "mask")?,
        output: validate_nifti_path(&argv[5], "output")?,
    })
}

fn validate_deface_run(
    app: &tauri::AppHandle,
    state: &TrustStore,
    tool_id: &str,
    argv: &[String],
    dataset_root: &str,
) -> Result<ValidatedDefaceRun, String> {
    let parts = validate_deface_argv(tool_id, argv)?;
    let dataset_root = validate_abs_path(dataset_root, "datasetRoot")?;

    // App-dependent inputs resolved here; the actual policy checks live in the
    // pure `validate_deface_paths` so they're unit-testable without an
    // AppHandle (audit 2026-06-27 round 9 P3).
    let expected_template = resolve_resource(app, "common/avg152T1.nii.gz", "template")?;
    let expected_mask = resolve_resource(app, "common/avg152T1mask.nii.gz", "mask")?;
    let cache_dir = app_cache_dir(app)?;
    // TRUST membership is checked LEXICALLY on the as-typed root — the trust
    // set is stored lexical by design so a symlinked picker root keeps
    // matching (see AGENTS.md / lib.rs). Do NOT canonicalize dataset_root
    // before this check.
    let root_is_authorized = state.is_under_any_runtime_path(&dataset_root)?;

    let mut run = validate_deface_paths(
        parts.clone(),
        &dataset_root,
        &expected_template,
        &expected_mask,
        &cache_dir,
        root_is_authorized,
    )?;
    // Spawn CANONICAL paths (audit 2026-06-28 follow-up P2): the lexical
    // policy above passed, so now resolve every path through symlinks and
    // re-check containment, building the exact argv niimath receives. This
    // canonicalizes the ALREADY-TRUSTED root only to validate the input's
    // resolved location — it never feeds a canonical root into the trust
    // check above, so symlinked picker roots still match. The cwd is set to
    // the canonical output parent too (not the raw one from
    // validate_deface_paths) so a child relative-path / cwd lookup can't
    // resolve through a symlinked parent.
    let (argv, cwd) = resolve_deface_spawn(
        tool_id,
        &parts,
        &dataset_root,
        &expected_template,
        &expected_mask,
        &cache_dir,
    )?;
    run.argv = argv;
    run.cwd = cwd;
    Ok(run)
}

/// Build the CANONICAL `(argv, cwd)` to spawn for a sidecar defacer. Resolves
/// every renderer-supplied path via `std::fs::canonicalize` and re-checks
/// containment AFTER resolution, so a symlinked NIfTI under the dataset root
/// can't redirect niimath's READ outside it, and a symlinked output / parent
/// under the cache can't redirect its WRITE. Refuses a pre-existing output.
/// Returns the canonical output parent as the spawn cwd. Template/mask are
/// app-derived (already verified == the bundled atlas by `require_same_path`)
/// and canonicalized for the spawned argv. Pure given paths (no AppHandle),
/// so it's unit-testable against real temp dirs.
///
/// `dataset_root` here has ALREADY passed the lexical trust check; this fn
/// canonicalizes it only to validate the input's resolved location — the
/// canonical root never reaches `is_under_any_runtime_path`, so a symlinked
/// picker root (the trust key is the as-typed string) still matches.
fn resolve_deface_spawn(
    tool_id: &str,
    parts: &DefaceArgvParts,
    dataset_root: &Path,
    expected_template: &Path,
    expected_mask: &Path,
    cache_dir: &Path,
) -> Result<(Vec<String>, PathBuf), String> {
    let op_flag = match tool_id {
        "allineate" => "-deface",
        _ => {
            return Err(format!(
                "run_deface_process: unknown sidecar deface tool \"{tool_id}\""
            ))
        }
    };
    let root_canon = canonicalize_existing(dataset_root, "datasetRoot")?;
    let input_canon = canonicalize_existing(&parts.input, "deface input")?;
    if !input_canon.starts_with(&root_canon) {
        return Err(format!(
            "run_deface_process: deface input {} resolves outside datasetRoot {}",
            input_canon.display(),
            root_canon.display()
        ));
    }
    let cache_canon = canonicalize_existing(cache_dir, "app cache dir")?;
    let out_parent = parts
        .output
        .parent()
        .ok_or_else(|| format!("output has no parent: {}", parts.output.display()))?;
    let out_parent_canon = canonicalize_existing(out_parent, "deface output parent")?;
    let out_name = parts
        .output
        .file_name()
        .ok_or_else(|| format!("output has no file name: {}", parts.output.display()))?;
    let output_canon = out_parent_canon.join(out_name);
    if !output_canon.starts_with(&cache_canon) {
        return Err(format!(
            "run_deface_process: deface output {} resolves outside app cache {}",
            output_canon.display(),
            cache_canon.display()
        ));
    }
    if std::fs::symlink_metadata(&output_canon).is_ok() {
        return Err(format!(
            "run_deface_process: deface output {} must not already exist",
            output_canon.display()
        ));
    }
    let template_canon = canonicalize_existing(expected_template, "template")?;
    let mask_canon = canonicalize_existing(expected_mask, "mask")?;
    let argv = vec![
        input_canon.to_string_lossy().into_owned(),
        "-robustfov".into(),
        op_flag.into(),
        template_canon.to_string_lossy().into_owned(),
        mask_canon.to_string_lossy().into_owned(),
        output_canon.to_string_lossy().into_owned(),
    ];
    Ok((argv, out_parent_canon))
}

/// The deface privilege-boundary policy, factored out of `validate_deface_run`
/// so it's unit-testable with `PathBuf` literals (no AppHandle): template/mask
/// must be the bundled atlas, the dataset root must be session-authorized, the
/// input must live under the dataset root, and the output must live under the
/// app cache. Returns the spawn cwd (output's parent). Audit 2026-06-27 round 9 P3.
fn validate_deface_paths(
    parts: DefaceArgvParts,
    dataset_root: &Path,
    expected_template: &Path,
    expected_mask: &Path,
    cache_dir: &Path,
    root_is_authorized: bool,
) -> Result<ValidatedDefaceRun, String> {
    let DefaceArgvParts {
        input,
        template,
        mask,
        output,
    } = parts;
    require_same_path(&template, expected_template, "template")?;
    require_same_path(&mask, expected_mask, "mask")?;
    if !root_is_authorized {
        return Err(format!(
            "run_deface_process: datasetRoot is not authorized in this session: {}",
            dataset_root.display()
        ));
    }
    if !input.starts_with(dataset_root) {
        return Err(format!(
            "run_deface_process: input {} is not under datasetRoot {}",
            input.display(),
            dataset_root.display()
        ));
    }
    if !output.starts_with(cache_dir) {
        return Err(format!(
            "run_deface_process: output {} is not under app cache {}",
            output.display(),
            cache_dir.display()
        ));
    }
    let cwd = output
        .parent()
        .ok_or_else(|| format!("output has no parent: {}", output.display()))?
        .to_path_buf();
    // argv is filled by `validate_deface_run` (the renderer argv, unchanged).
    Ok(ValidatedDefaceRun {
        binary: ProcessBinary::Sidecar("niimath"),
        cwd,
        argv: Vec::new(),
    })
}

/// Validate the niimath mask-dilation argv SHAPE — the mindgrab 8 mm pass.
/// App-free + pure so it's unit-testable. The pipeline mirrors the working
/// CLI `niimath <mask> -binv -edt -thr <N> -binv <out>`:
///   binv (invert) -> edt (distance from brain) -> thr N (keep >= N mm) ->
///   binv (re-invert) = brain + N-mm halo.
fn validate_niimath_dilate_argv(argv: &[String]) -> Result<(PathBuf, PathBuf, f64), String> {
    if argv.len() != 7 {
        return Err(format!(
            "run_deface_process: niimath_dilate expects 7 args, got {}",
            argv.len()
        ));
    }
    // niimath <input> -binv -edt -thr <N> -binv <output>
    let input = validate_nifti_path(&argv[0], "input")?;
    expect(argv, 1, "-binv", "niimath_dilate")?;
    expect(argv, 2, "-edt", "niimath_dilate")?;
    expect(argv, 3, "-thr", "niimath_dilate")?;
    // The threshold (dilation mm). Parsing as f64 rejects flag-injection
    // (`-8` parses to -8.0, caught by the range check) and any non-numeric
    // token. 1000 mm is a generous ceiling for a head-sized halo.
    let thr: f64 = argv[4]
        .parse()
        .map_err(|_| format!("niimath_dilate: -thr must be a number, got \"{}\"", argv[4]))?;
    if !thr.is_finite() || thr <= 0.0 || thr > 1000.0 {
        return Err(format!(
            "niimath_dilate: -thr must be in (0, 1000] mm, got {thr}"
        ));
    }
    expect(argv, 5, "-binv", "niimath_dilate")?;
    let output = validate_nifti_path(&argv[6], "output")?;
    Ok((input, output, thr))
}

/// The dilation privilege-boundary policy: both the mask input and the
/// dilated output must live under the app cache (the renderer wrote the
/// input there from in-memory mask bytes). No dataset file is touched.
fn validate_niimath_dilate_paths(
    input: &Path,
    output: &Path,
    cache_dir: &Path,
) -> Result<ValidatedDefaceRun, String> {
    if !input.starts_with(cache_dir) {
        return Err(format!(
            "run_deface_process: niimath_dilate input {} is not under app cache {}",
            input.display(),
            cache_dir.display()
        ));
    }
    if !output.starts_with(cache_dir) {
        return Err(format!(
            "run_deface_process: niimath_dilate output {} is not under app cache {}",
            output.display(),
            cache_dir.display()
        ));
    }
    let cwd = output
        .parent()
        .ok_or_else(|| format!("output has no parent: {}", output.display()))?
        .to_path_buf();
    // argv is filled by `resolve_niimath_dilate_spawn` (canonical paths).
    Ok(ValidatedDefaceRun {
        binary: ProcessBinary::Sidecar("niimath"),
        cwd,
        argv: Vec::new(),
    })
}

fn validate_niimath_dilate_run(
    app: &tauri::AppHandle,
    argv: &[String],
) -> Result<ValidatedDefaceRun, String> {
    let cache_dir = app_cache_dir(app)?;
    resolve_niimath_dilate_spawn(argv, &cache_dir)
}

/// Resolve a niimath_dilate invocation to the exact `ValidatedDefaceRun`
/// (binary + cwd + the CANONICAL argv to spawn). Pure given a `cache_dir`
/// path (no AppHandle), so it's unit-testable against a real temp dir.
///
/// Canonicalizing before the containment check (audit 2026-06-28) stops a
/// symlinked descendant under `$APPCACHE` from redirecting niimath's
/// read/write outside the cache, and the resolved argv — canonical input,
/// canonical-parent-joined output, constant flags, and the re-stringified
/// numeric threshold — means ZERO raw renderer bytes reach the child
/// (closing the "validate canonical, spawn raw" gap). Refusing a
/// pre-existing output blocks a planted leaf symlink niimath would follow
/// on write (best-effort TOCTOU narrowing; niimath owns the open). The
/// input file + output parent exist by now (renderer mkdir'd the per-call
/// temp dir and wrote the mask); canonicalizing the cache root also fixes
/// false rejections when it traverses a symlink (/var -> /private/var).
fn resolve_niimath_dilate_spawn(
    argv: &[String],
    cache_dir: &Path,
) -> Result<ValidatedDefaceRun, String> {
    let (input, output, thr) = validate_niimath_dilate_argv(argv)?;
    let cache_canon = canonicalize_existing(cache_dir, "app cache dir")?;
    let input_canon = canonicalize_existing(&input, "niimath_dilate input")?;
    let out_parent = output
        .parent()
        .ok_or_else(|| format!("output has no parent: {}", output.display()))?;
    let out_parent_canon = canonicalize_existing(out_parent, "niimath_dilate output parent")?;
    let out_name = output
        .file_name()
        .ok_or_else(|| format!("output has no file name: {}", output.display()))?;
    let output_canon = out_parent_canon.join(out_name);
    let mut run = validate_niimath_dilate_paths(&input_canon, &output_canon, &cache_canon)?;
    // Refuse a pre-existing output (the renderer lets niimath create it).
    // Checking the COMPOSED canonical path catches a leaf symlink that
    // niimath would otherwise follow on write.
    if std::fs::symlink_metadata(&output_canon).is_ok() {
        return Err(format!(
            "run_deface_process: niimath_dilate output {} must not already exist",
            output_canon.display()
        ));
    }
    // Spawn canonical paths + constant flags + the re-stringified validated
    // threshold — no raw renderer byte survives into the child argv.
    run.argv = vec![
        input_canon.to_string_lossy().into_owned(),
        "-binv".into(),
        "-edt".into(),
        "-thr".into(),
        thr.to_string(),
        "-binv".into(),
        output_canon.to_string_lossy().into_owned(),
    ];
    Ok(run)
}

/// `std::fs::canonicalize` with a typed error. Used to resolve symlinks
/// before a containment check so a child process can't be redirected out
/// of its sandbox. The path must exist (caller documents why it does).
fn canonicalize_existing(path: &Path, label: &str) -> Result<PathBuf, String> {
    path.canonicalize().map_err(|e| {
        format!(
            "run_deface_process: cannot resolve {label} {}: {e}",
            path.display()
        )
    })
}

fn authorize_import_run(
    state: &TrustStore,
    run: &ValidatedImportRun,
    auth: &ImportProcessAuth,
) -> Result<(), String> {
    state.validate_token(&auth.src_dir_token, &run.args.src)?;
    state.validate_token(&auth.dest_dir_parent_token, &run.args.dest)?;
    if let Some(path) = run.args.heuristic_path.as_ref() {
        let token = auth.heuristic_token.as_deref().ok_or_else(|| {
            format!(
                "run_import_process: missing heuristic token for {}",
                path.display()
            )
        })?;
        state.validate_token(token, path)?;
    }
    if let Some(path) = run.args.config_path.as_ref() {
        let token = auth.config_token.as_deref().ok_or_else(|| {
            format!(
                "run_import_process: missing config token for {}",
                path.display()
            )
        })?;
        state.validate_token(token, path)?;
    }
    Ok(())
}

fn validate_reproin_argv(argv: &[String]) -> Result<ValidatedImportArgs, String> {
    let mut i = 0;
    expect_take(argv, &mut i, "-f", "dcm2niix-reproin")?;
    expect_take(argv, &mut i, "%H", "dcm2niix-reproin")?;
    expect_take(argv, &mut i, "-z", "dcm2niix-reproin")?;
    expect_take(argv, &mut i, "y", "dcm2niix-reproin")?;

    if peek(argv, i, "-ba") {
        i += 1;
        let v = take(argv, &mut i, "dcm2niix-reproin -ba value")?;
        // `o` (omit PII, keep AcquisitionDateTime) is the v1.0.20260520
        // default for anonymize=off; `y` is full anonymize; `n` accepted
        // for back-compat with manual argv but no longer emitted by the
        // wizard since it leaks PatientName.
        if v != "y" && v != "n" && v != "o" {
            return Err(format!(
                "dcm2niix-reproin: -ba must be y, n, or o, got \"{v}\""
            ));
        }
    }

    expect_take(argv, &mut i, "-o", "dcm2niix-reproin")?;
    let dest = validate_abs_path(take(argv, &mut i, "dcm2niix-reproin -o")?, "dest")?;

    let mut seen_subject = false;
    let mut seen_session = false;
    while i + 1 < argv.len() {
        match argv[i].as_str() {
            "-bi" => {
                if seen_subject {
                    return Err("dcm2niix-reproin: duplicate -bi".into());
                }
                i += 1;
                validate_bids_label(take(argv, &mut i, "dcm2niix-reproin -bi")?, "subject")?;
                seen_subject = true;
            }
            "-bv" => {
                if seen_session {
                    return Err("dcm2niix-reproin: duplicate -bv".into());
                }
                i += 1;
                validate_bids_label(take(argv, &mut i, "dcm2niix-reproin -bv")?, "session")?;
                seen_session = true;
            }
            _ => break,
        }
    }

    if i != argv.len().saturating_sub(1) {
        return Err(format!(
            "dcm2niix-reproin: unexpected argv tail at index {i}: {:?}",
            argv.get(i)
        ));
    }
    let src = validate_abs_path(take(argv, &mut i, "dcm2niix-reproin src")?, "src")?;
    if i != argv.len() {
        return Err("dcm2niix-reproin: trailing args".into());
    }
    Ok(ValidatedImportArgs {
        cwd: dest.clone(),
        src,
        dest,
        heuristic_path: None,
        config_path: None,
    })
}

fn validate_pet2bids_argv(argv: &[String]) -> Result<ValidatedImportArgs, String> {
    if argv.len() != 11 {
        return Err(format!("pet2bids: expects 11 args, got {}", argv.len()));
    }
    expect(argv, 0, "-f", "pet2bids")?;
    validate_pet_stem(&argv[1])?;
    expect(argv, 2, "-z", "pet2bids")?;
    expect(argv, 3, "y", "pet2bids")?;
    expect(argv, 4, "-w", "pet2bids")?;
    expect(argv, 5, "1", "pet2bids")?;
    expect(argv, 6, "-ba", "pet2bids")?;
    // Accept `y` (full anonymize), `o` (omit PII, keep AcquisitionDateTime
    // — the v0.1.20260521+ default for anonymize=off), and `n` for
    // backwards-compatibility. The renderer never emits `n` per
    // `dcm2niixAnonymizeFlag` in `src/lib/import/runImport.ts`, but the
    // boundary stays permissive in case a manual cli-bridge invocation
    // ever needs it.
    if argv[7] != "y" && argv[7] != "n" && argv[7] != "o" {
        return Err(format!(
            "pet2bids: -ba must be y, n, or o, got \"{}\"",
            argv[7]
        ));
    }
    expect(argv, 8, "-o", "pet2bids")?;
    let pet_dir = validate_abs_path(&argv[9], "petDir")?;
    let src = validate_abs_path(&argv[10], "src")?;
    Ok(ValidatedImportArgs {
        cwd: pet_dir.clone(),
        src,
        dest: pet_dir,
        heuristic_path: None,
        config_path: None,
    })
}

fn validate_heudiconv_argv(argv: &[String]) -> Result<ValidatedImportArgs, String> {
    let mut i = 0;
    expect_take(argv, &mut i, "-c", "heudiconv")?;
    expect_take(argv, &mut i, "dcm2niix", "heudiconv")?;
    expect_take(argv, &mut i, "--bids", "heudiconv")?;
    expect_take(argv, &mut i, "-o", "heudiconv")?;
    let dest = validate_abs_path(take(argv, &mut i, "heudiconv -o")?, "dest")?;
    expect_take(argv, &mut i, "-f", "heudiconv")?;
    let heuristic_path = validate_heuristic(take(argv, &mut i, "heudiconv -f")?)?;

    let mut seen_subject = false;
    let mut seen_session = false;
    while i < argv.len() {
        match argv[i].as_str() {
            "-s" => {
                if seen_subject {
                    return Err("heudiconv: duplicate -s".into());
                }
                i += 1;
                validate_bids_label(take(argv, &mut i, "heudiconv -s")?, "subject")?;
                seen_subject = true;
            }
            "-ss" => {
                if seen_session {
                    return Err("heudiconv: duplicate -ss".into());
                }
                i += 1;
                validate_bids_label(take(argv, &mut i, "heudiconv -ss")?, "session")?;
                seen_session = true;
            }
            _ => break,
        }
    }

    expect_take(argv, &mut i, "--files", "heudiconv")?;
    let src = validate_abs_path(take(argv, &mut i, "heudiconv --files")?, "src")?;
    if i != argv.len() {
        return Err("heudiconv: trailing args".into());
    }
    Ok(ValidatedImportArgs {
        cwd: dest.clone(),
        src,
        dest,
        heuristic_path,
        config_path: None,
    })
}

fn validate_dcm2bids_argv(argv: &[String]) -> Result<ValidatedImportArgs, String> {
    let mut i = 0;
    expect_take(argv, &mut i, "-d", "dcm2bids")?;
    let src = validate_abs_path(take(argv, &mut i, "dcm2bids -d")?, "src")?;
    expect_take(argv, &mut i, "-p", "dcm2bids")?;
    validate_bids_label(take(argv, &mut i, "dcm2bids -p")?, "subject")?;
    expect_take(argv, &mut i, "-c", "dcm2bids")?;
    let config_path = validate_file_path(take(argv, &mut i, "dcm2bids -c")?, "config", &["json"])?;
    expect_take(argv, &mut i, "-o", "dcm2bids")?;
    let dest = validate_abs_path(take(argv, &mut i, "dcm2bids -o")?, "dest")?;

    if i < argv.len() {
        expect_take(argv, &mut i, "-s", "dcm2bids")?;
        validate_bids_label(take(argv, &mut i, "dcm2bids -s")?, "session")?;
    }
    if i != argv.len() {
        return Err("dcm2bids: trailing args".into());
    }
    Ok(ValidatedImportArgs {
        cwd: dest.clone(),
        src,
        dest,
        heuristic_path: None,
        config_path: Some(config_path),
    })
}

fn run_process(
    binary: ProcessBinary,
    argv: &[String],
    cwd: Option<&Path>,
    use_sidecar_path: bool,
) -> Result<CommandExit, String> {
    let (program, label) = match binary {
        ProcessBinary::Sidecar(name) => {
            let path = sidecar_binary(name)?;
            (path, name.to_string())
        }
        ProcessBinary::External(name) => (PathBuf::from(name), name.to_string()),
    };

    let mut cmd = Command::new(&program);
    cmd.args(argv);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    if use_sidecar_path {
        cmd.env("PATH", sidecar_path_env()?);
    }
    if should_apply_git_safety_env(binary) {
        apply_git_safety_env_std(&mut cmd);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("{label}: failed to spawn {}: {e}", program.display()))?;

    Ok(CommandExit {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        label,
        cancelled: false,
    })
}

fn require_success(exit: CommandExit) -> Result<ProcessOutput, String> {
    if exit.cancelled {
        // A user-initiated cancel produces a non-zero exit (typically
        // negative on Unix from SIGTERM). Surface as the marker
        // string the renderer-side action recognises so the dialog
        // can distinguish "user clicked Cancel" from "remote went
        // away mid-clone".
        return Err(format!("{}: cancelled by user", exit.label));
    }
    if exit.code != Some(0) {
        let tail = exit.stderr.trim();
        return Err(format!(
            "{} exited with code {}: {}",
            exit.label,
            exit.code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "null".into()),
            if tail.is_empty() { "<no stderr>" } else { tail }
        ));
    }
    Ok(ProcessOutput {
        stdout: exit.stdout,
        stderr: exit.stderr,
        partial_failure_warning: None,
    })
}

fn sidecar_binary(name: &str) -> Result<PathBuf, String> {
    for dir in runtime_binary_dirs()? {
        for candidate in sidecar_name_candidates(name) {
            let path = dir.join(&candidate);
            if path.is_file() {
                return Ok(path);
            }
            let nested = dir.join("binaries").join(&candidate);
            if nested.is_file() {
                return Ok(nested);
            }
        }
    }
    Err(format!(
        "sidecar_binary: could not find bundled sidecar \"{name}\""
    ))
}

fn sidecar_path_env() -> Result<String, String> {
    // Resolve the bundled dcm2niix and make sure a child process doing
    // `shutil.which('dcm2niix')` will find it by basename. In a packaged
    // macOS app the sidecar already lives at
    // `<bundle>.app/Contents/MacOS/dcm2niix` (Tauri strips the target
    // triple suffix at bundle time), but in `bun tauri dev` it lives at
    // `src-tauri/binaries/dcm2niix-<triple>` — there `which dcm2niix`
    // returns nothing and an unbundled `dcm2bids` falls through to the
    // host's installed version (or fails). Shim a directory containing
    // an unsuffixed entry pointing at the resolved binary so both modes
    // behave the same.
    let resolved = sidecar_binary("dcm2niix")?;
    let shim_dir = ensure_dcm2niix_shim_dir(&resolved)?;
    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut parts = vec![shim_dir.to_string_lossy().into_owned()];
    // Append the inherited PATH so a PATH-resolved external tool
    // (today: dcm2bids) can be found in the user's homebrew / pyenv /
    // system locations. The shim dir stays first so any subprocess
    // lookup of dcm2niix still prefers our bundled binary over
    // whatever the user has installed.
    if let Ok(inherited) = std::env::var("PATH") {
        if !inherited.is_empty() {
            parts.push(inherited);
        }
    }
    // Always backfill common macOS Python / Homebrew locations. A
    // Finder-launched .app inherits launchd's minimal PATH and won't
    // see `/opt/homebrew/bin`, pyenv shims, or `~/.local/bin` even
    // when the user shelled `pip install dcm2bids` from Terminal.
    // Duplicates are harmless — POSIX PATH lookup stops at the first
    // hit — but `extend` after the inherited PATH means the bundled
    // shim still wins for dcm2niix.
    if cfg!(windows) {
        if let Ok(root) = std::env::var("SystemRoot") {
            parts.push(format!(r"{root}\System32"));
            parts.push(root);
        }
    } else {
        parts.extend(
            [
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
            ]
            .into_iter()
            .map(String::from),
        );
        if let Ok(home) = std::env::var("HOME") {
            parts.push(format!("{home}/.local/bin"));
            parts.push(format!("{home}/.pyenv/shims"));
        }
    }
    Ok(parts.join(sep))
}

/// Return a directory that contains an entry literally named
/// `dcm2niix` (no target-triple suffix), pointing at the resolved
/// sidecar. In production the resolved sidecar already has the right
/// basename — return its parent directly. In development the staged
/// binary carries a `-<triple>` suffix, so a fresh shim directory is
/// materialised at `$TMPDIR/bidsvue-dcm2niix-<pid>-<random>/` with
/// mode 0700 (Unix) and `mkdir(exclusive)` semantics (we use
/// `create_dir`, not `create_dir_all`, so a pre-existing collision
/// path is a hard error — closes audit round 4 P2 #3 where a co-
/// located attacker could pre-create the predictable
/// `bidsvue-dcm2niix-<pid>/` dir, plant their own `dcm2niix`, and have
/// dcm2bids spawn against it). The cache is success-only: a transient
/// EROFS / TMPDIR-full / mode-0700-rejected error retries on the next
/// call instead of poisoning the OnceLock for the rest of the process.
///
/// Audit (2026-06-14 round 5, external P3) — the cache hit path
/// revalidates `<cached>/dcm2niix` actually exists; if `$TMPDIR`
/// cleanup or a user `rm -rf /tmp/bidsvue-dcm2niix-*` razed the dir
/// mid-session, the entry is invalidated and recreated. On first call
/// per process we also opportunistically purge `bidsvue-dcm2niix-*`
/// dirs left behind by prior PIDs that share our uid so multiple
/// dev / test sessions don't accumulate `$TMPDIR` cruft.
fn ensure_dcm2niix_shim_dir(resolved: &Path) -> Result<PathBuf, String> {
    use std::sync::{Mutex, OnceLock};
    static SHIM_DIR_CACHE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    static STALE_PURGED: OnceLock<()> = OnceLock::new();
    let cache = SHIM_DIR_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache
        .lock()
        .map_err(|e| format!("ensure_dcm2niix_shim_dir: cache mutex poisoned: {e}"))?;
    let want = if cfg!(windows) {
        "dcm2niix.exe"
    } else {
        "dcm2niix"
    };
    if let Some(existing) = guard.as_ref() {
        // Revalidate the cached shim — `$TMPDIR` cleanup or a manual
        // `rm -rf` would otherwise have callers silently fail with
        // "dcm2niix not found" for the rest of the process.
        if existing.join(want).exists() {
            return Ok(existing.clone());
        }
        *guard = None;
    }

    let parent = resolved
        .parent()
        .ok_or_else(|| "ensure_dcm2niix_shim_dir: sidecar has no parent".to_string())?
        .to_path_buf();
    if resolved.file_name().and_then(|n| n.to_str()) == Some(want) && parent.join(want).is_file() {
        // Production bundle (or anyone else who placed an unsuffixed
        // binary at the resolved location): no shim needed.
        let parent_cached = parent.clone();
        *guard = Some(parent_cached.clone());
        return Ok(parent_cached);
    }

    // First-call: purge stale `bidsvue-dcm2niix-<pid>-*` dirs from
    // dead PIDs owned by our uid. Best-effort — we'd rather skip a
    // delete than refuse to create a fresh shim.
    if STALE_PURGED.set(()).is_ok() {
        purge_stale_dcm2niix_shim_dirs();
    }

    // Build a candidate dir with a `uuid::v4` suffix; create EXCLUSIVE
    // (mkdir, not mkdir -p) so a pre-existing path is an error. Retry
    // up to a small bound to absorb a fresh-uuid collision (vanishingly
    // unlikely but the cost is negligible).
    let tmp_root = std::env::temp_dir();
    let mut last_err: Option<String> = None;
    for _ in 0..8 {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let dir = tmp_root.join(format!(
            "bidsvue-dcm2niix-{}-{}",
            std::process::id(),
            suffix
        ));
        let mk_result;
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            mk_result = std::fs::DirBuilder::new()
                .mode(0o700)
                .recursive(false)
                .create(&dir);
        }
        #[cfg(not(unix))]
        {
            mk_result = std::fs::DirBuilder::new().recursive(false).create(&dir);
        }
        if let Err(e) = mk_result {
            last_err = Some(format!(
                "ensure_dcm2niix_shim_dir: create {}: {e}",
                dir.display()
            ));
            continue;
        }
        // On Unix, defence-in-depth: assert the dir we just created
        // is owned by us AND no other-user bits are set. A symlink
        // race between `mkdir` and the `chmod` we already did would
        // surface as a mode mismatch on read-back.
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let md = match std::fs::symlink_metadata(&dir) {
                Ok(m) => m,
                Err(e) => {
                    let _ = std::fs::remove_dir(&dir);
                    last_err = Some(format!(
                        "ensure_dcm2niix_shim_dir: stat just-created {}: {e}",
                        dir.display()
                    ));
                    continue;
                }
            };
            if !md.file_type().is_dir() {
                let _ = std::fs::remove_file(&dir);
                last_err = Some(format!(
                    "ensure_dcm2niix_shim_dir: created {} is not a directory (race?)",
                    dir.display()
                ));
                continue;
            }
            if md.mode() & 0o077 != 0 {
                let _ = std::fs::remove_dir(&dir);
                last_err = Some(format!(
                    "ensure_dcm2niix_shim_dir: created {} has unsafe mode {:o}",
                    dir.display(),
                    md.mode() & 0o7777
                ));
                continue;
            }
            // Effective UID match: defence against a TMPDIR pre-populated
            // by another user. Returns u32 which always exists on Unix.
            // Skip if running as root (uid 0 always matches everything).
            let euid = unsafe { libc::geteuid() };
            if euid != 0 && md.uid() != euid {
                let _ = std::fs::remove_dir(&dir);
                last_err = Some(format!(
                    "ensure_dcm2niix_shim_dir: created {} owned by uid {} not {} (race?)",
                    dir.display(),
                    md.uid(),
                    euid
                ));
                continue;
            }
        }
        let shim_path = dir.join(want);
        #[cfg(unix)]
        let materialise = std::os::unix::fs::symlink(resolved, &shim_path);
        #[cfg(windows)]
        let materialise = std::fs::copy(resolved, &shim_path).map(|_| ());
        if let Err(e) = materialise {
            let _ = std::fs::remove_dir_all(&dir);
            last_err = Some(format!(
                "ensure_dcm2niix_shim_dir: materialise shim at {}: {e}",
                shim_path.display()
            ));
            continue;
        }
        *guard = Some(dir.clone());
        return Ok(dir);
    }
    Err(last_err
        .unwrap_or_else(|| "ensure_dcm2niix_shim_dir: exhausted retries with no error".to_string()))
}

/// Best-effort housekeeping: remove `$TMPDIR/bidsvue-dcm2niix-<pid>-*`
/// dirs whose PID is no longer alive AND that we own. Called once per
/// process at the first `ensure_dcm2niix_shim_dir` invocation. Errors
/// are silent — failure to clean up old cruft must not block us from
/// creating a fresh shim. Unix-only (Windows shim cleanup would need a
/// different liveness check; the file-copy fallback there is also
/// cheaper to leak than a symlink).
#[cfg(unix)]
fn purge_stale_dcm2niix_shim_dirs() {
    use std::os::unix::fs::MetadataExt;
    let tmp_root = std::env::temp_dir();
    let euid = unsafe { libc::geteuid() };
    let me_pid = std::process::id();
    let Ok(entries) = std::fs::read_dir(&tmp_root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match entry.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue,
        };
        let Some(rest) = name.strip_prefix("bidsvue-dcm2niix-") else {
            continue;
        };
        // `<pid>-<uuid-simple>` — parse the leading numeric run.
        let pid_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if pid_str.is_empty() {
            continue;
        }
        let Ok(pid) = pid_str.parse::<u32>() else {
            continue;
        };
        if pid == me_pid {
            continue;
        }
        // Ownership: require uid match (or root). Skip ROOT-cross paths.
        match std::fs::symlink_metadata(&path) {
            Ok(md) if md.file_type().is_dir() && (euid == 0 || md.uid() == euid) => {}
            _ => continue,
        }
        // Liveness: `kill(pid, 0)` returns Err(ESRCH) when no such pid.
        // Any other error (EPERM = exists but not us) we treat as
        // "still alive" and leave alone.
        let alive = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
        if alive {
            continue;
        }
        let _ = std::fs::remove_dir_all(&path);
    }
}

#[cfg(not(unix))]
fn purge_stale_dcm2niix_shim_dirs() {
    // Windows leaves stale dirs in place — see fn-level docstring.
}

fn runtime_binary_dirs() -> Result<Vec<PathBuf>, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let mut dirs = Vec::new();
    if let Some(parent) = exe.parent() {
        dirs.push(parent.to_path_buf());
        if parent
            .file_name()
            .is_some_and(|name| name == std::ffi::OsStr::new("deps"))
        {
            if let Some(grandparent) = parent.parent() {
                dirs.push(grandparent.to_path_buf());
            }
        }
    }
    Ok(dirs)
}

fn sidecar_name_candidates(name: &str) -> Vec<String> {
    let mut names = vec![name.to_string(), format!("{name}-{}", target_triple())];
    if cfg!(windows) {
        names.push(format!("{name}.exe"));
        names.push(format!("{name}-{}.exe", target_triple()));
    }
    names
}

fn target_triple() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "x86_64-apple-darwin"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "x86_64-unknown-linux-gnu"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "x86_64-pc-windows-msvc"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64")
    )))]
    {
        "unknown"
    }
}

pub(crate) fn resolve_resource(
    app: &tauri::AppHandle,
    rel: &str,
    label: &str,
) -> Result<PathBuf, String> {
    use tauri::{path::BaseDirectory, Manager};

    app.path()
        .resolve(rel, BaseDirectory::Resource)
        .map_err(|e| format!("resolve {label} resource failed: {e}"))
}

pub(crate) fn app_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;

    app.path()
        .app_cache_dir()
        .map_err(|e| format!("run_deface_process: app_cache_dir failed: {e}"))
}

fn require_same_path(actual: &Path, expected: &Path, label: &str) -> Result<(), String> {
    let actual_cmp = actual
        .canonicalize()
        .unwrap_or_else(|_| actual.to_path_buf());
    let expected_cmp = expected
        .canonicalize()
        .unwrap_or_else(|_| expected.to_path_buf());
    if actual_cmp != expected_cmp {
        return Err(format!(
            "run_deface_process: {label} must be bundled resource {}, got {}",
            expected.display(),
            actual.display()
        ));
    }
    Ok(())
}

pub(crate) fn validate_abs_path(value: &str, field: &str) -> Result<PathBuf, String> {
    if value.is_empty() {
        return Err(format!("{field} is required"));
    }
    if value.contains('\0') {
        return Err(format!("{field} must not contain NUL bytes"));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(format!("{field} must be an absolute path, got \"{value}\""));
    }
    for c in path.components() {
        if !matches!(
            c,
            Component::Prefix(_) | Component::RootDir | Component::Normal(_)
        ) {
            return Err(format!(
                "{field} must not contain '.' or '..' components, got \"{value}\""
            ));
        }
    }
    if first_normal_component_starts_dash(&path) {
        return Err(format!(
            "{field} first path component must not start with '-', got \"{value}\""
        ));
    }
    Ok(path)
}

fn validate_file_path(value: &str, field: &str, exts: &[&str]) -> Result<PathBuf, String> {
    let path = validate_abs_path(value, field)?;
    let lower = value.to_ascii_lowercase();
    if !exts.iter().any(|ext| lower.ends_with(&format!(".{ext}"))) {
        return Err(format!(
            "{field} must end with one of: {}",
            exts.iter()
                .map(|ext| format!(".{ext}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    Ok(path)
}

fn validate_nifti_path(value: &str, field: &str) -> Result<PathBuf, String> {
    let path = validate_abs_path(value, field)?;
    let lower = value.to_ascii_lowercase();
    if !lower.ends_with(".nii") && !lower.ends_with(".nii.gz") {
        return Err(format!("{field} must be a .nii or .nii.gz path"));
    }
    Ok(path)
}

fn validate_bids_label(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{field} is required"));
    }
    if !value.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!(
            "{field} must contain only letters and digits, got \"{value}\""
        ));
    }
    Ok(())
}

fn validate_heuristic(value: &str) -> Result<Option<PathBuf>, String> {
    if value.is_empty() {
        return Err("heuristic is required".into());
    }
    if value.starts_with('-') {
        return Err(format!(
            "heuristic must not start with '-', got \"{value}\""
        ));
    }
    if value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Ok(None);
    }
    if value.ends_with(".py") {
        return Ok(Some(validate_abs_path(value, "heuristic")?));
    }
    Err(format!(
        "heuristic must be a built-in identifier or absolute .py path, got \"{value}\""
    ))
}

fn validate_pet_stem(value: &str) -> Result<(), String> {
    let Some(rest) = value.strip_prefix("sub-") else {
        return Err(format!(
            "pet2bids: stem must start with sub-, got \"{value}\""
        ));
    };
    let Some(rest) = rest.strip_suffix("_pet") else {
        return Err(format!(
            "pet2bids: stem must end with _pet, got \"{value}\""
        ));
    };
    let (subject, session) = match rest.split_once("_ses-") {
        Some((sub, ses)) => (sub, Some(ses)),
        None => (rest, None),
    };
    validate_bids_label(subject, "subject")?;
    if let Some(ses) = session {
        validate_bids_label(ses, "session")?;
    }
    Ok(())
}

fn first_normal_component_starts_dash(path: &Path) -> bool {
    path.components()
        .find_map(|c| match c {
            Component::Normal(part) => Some(part.to_string_lossy().starts_with('-')),
            _ => None,
        })
        .unwrap_or(false)
}

fn expect(argv: &[String], index: usize, expected: &str, ctx: &str) -> Result<(), String> {
    match argv.get(index) {
        Some(actual) if actual == expected => Ok(()),
        Some(actual) => Err(format!(
            "{ctx}: expected \"{expected}\" at argv[{index}], got \"{actual}\""
        )),
        None => Err(format!("{ctx}: missing \"{expected}\" at argv[{index}]")),
    }
}

fn expect_take(
    argv: &[String],
    index: &mut usize,
    expected: &str,
    ctx: &str,
) -> Result<(), String> {
    expect(argv, *index, expected, ctx)?;
    *index += 1;
    Ok(())
}

fn take<'a>(argv: &'a [String], index: &mut usize, ctx: &str) -> Result<&'a str, String> {
    let value = argv
        .get(*index)
        .ok_or_else(|| format!("{ctx}: missing argv[{}]", *index))?;
    *index += 1;
    Ok(value)
}

fn peek(argv: &[String], index: usize, value: &str) -> bool {
    argv.get(index).is_some_and(|v| v == value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    // niimath <input> -robustfov <op> <template> <mask> <output>
    fn deface_argv(input: &str, op: &str, output: &str) -> Vec<String> {
        strings(&[
            input,
            "-robustfov",
            op,
            "/res/avg152T1.nii.gz",
            "/res/avg152T1mask.nii.gz",
            output,
        ])
    }

    #[test]
    fn validate_deface_argv_accepts_allineate() {
        let a = validate_deface_argv(
            "allineate",
            &deface_argv("/ds/sub-01/anat/t1.nii.gz", "-deface", "/cache/out.nii.gz"),
        )
        .expect("allineate argv valid");
        assert_eq!(a.input, PathBuf::from("/ds/sub-01/anat/t1.nii.gz"));
        assert_eq!(a.output, PathBuf::from("/cache/out.nii.gz"));
        // The GPL `spm_coreg` / `-spm_deface` tool was removed; it is now
        // an unknown tool id.
        assert!(validate_deface_argv(
            "spm_coreg",
            &deface_argv("/ds/sub-01/anat/t1.nii", "-spm_deface", "/cache/out.nii")
        )
        .is_err());
    }

    #[test]
    fn validate_deface_argv_rejects_unknown_tool() {
        let err = validate_deface_argv(
            "mindgrab",
            &deface_argv("/ds/t1.nii.gz", "-deface", "/cache/out.nii.gz"),
        )
        .unwrap_err();
        assert!(err.contains("unknown sidecar deface tool"), "{err}");
    }

    #[test]
    fn validate_deface_argv_rejects_wrong_op_flag_for_tool() {
        // allineate must use -deface, not -spm_deface.
        let err = validate_deface_argv(
            "allineate",
            &deface_argv("/ds/t1.nii.gz", "-spm_deface", "/cache/out.nii.gz"),
        )
        .unwrap_err();
        assert!(err.contains("-deface"), "{err}");
    }

    #[test]
    fn validate_deface_argv_rejects_wrong_arg_count_and_missing_robustfov() {
        assert!(
            validate_deface_argv("allineate", &strings(&["/ds/t1.nii.gz"]))
                .unwrap_err()
                .contains("expects 6 args")
        );
        // 6 args but argv[1] is not -robustfov.
        let mut argv = deface_argv("/ds/t1.nii.gz", "-deface", "/cache/out.nii.gz");
        argv[1] = "-notrobustfov".into();
        assert!(validate_deface_argv("allineate", &argv)
            .unwrap_err()
            .contains("-robustfov"));
    }

    fn deface_parts(input: &str, output: &str) -> DefaceArgvParts {
        DefaceArgvParts {
            input: PathBuf::from(input),
            template: PathBuf::from("/res/avg152T1.nii.gz"),
            mask: PathBuf::from("/res/avg152T1mask.nii.gz"),
            output: PathBuf::from(output),
        }
    }

    #[test]
    fn validate_deface_paths_happy_path_returns_output_parent_as_cwd() {
        let run = validate_deface_paths(
            deface_parts("/ds/sub-01/anat/t1.nii.gz", "/cache/deface/out.nii.gz"),
            Path::new("/ds"),
            Path::new("/res/avg152T1.nii.gz"),
            Path::new("/res/avg152T1mask.nii.gz"),
            Path::new("/cache"),
            true,
        )
        .expect("valid deface paths");
        assert_eq!(run.cwd, PathBuf::from("/cache/deface"));
    }

    #[test]
    fn validate_deface_paths_rejects_unauthorized_root() {
        let err = validate_deface_paths(
            deface_parts("/ds/t1.nii.gz", "/cache/out.nii.gz"),
            Path::new("/ds"),
            Path::new("/res/avg152T1.nii.gz"),
            Path::new("/res/avg152T1mask.nii.gz"),
            Path::new("/cache"),
            false, // not authorized
        )
        .unwrap_err();
        assert!(err.contains("not authorized"), "{err}");
    }

    #[test]
    fn validate_deface_paths_rejects_input_outside_dataset_and_output_outside_cache() {
        // Input escapes the dataset root.
        assert!(validate_deface_paths(
            deface_parts("/other/t1.nii.gz", "/cache/out.nii.gz"),
            Path::new("/ds"),
            Path::new("/res/avg152T1.nii.gz"),
            Path::new("/res/avg152T1mask.nii.gz"),
            Path::new("/cache"),
            true,
        )
        .unwrap_err()
        .contains("not under datasetRoot"));
        // Output escapes the app cache.
        assert!(validate_deface_paths(
            deface_parts("/ds/t1.nii.gz", "/tmp/out.nii.gz"),
            Path::new("/ds"),
            Path::new("/res/avg152T1.nii.gz"),
            Path::new("/res/avg152T1mask.nii.gz"),
            Path::new("/cache"),
            true,
        )
        .unwrap_err()
        .contains("not under app cache"));
    }

    #[test]
    fn validate_deface_paths_rejects_wrong_template_or_mask() {
        let mut parts = deface_parts("/ds/t1.nii.gz", "/cache/out.nii.gz");
        parts.template = PathBuf::from("/res/attacker.nii.gz");
        assert!(validate_deface_paths(
            parts,
            Path::new("/ds"),
            Path::new("/res/avg152T1.nii.gz"),
            Path::new("/res/avg152T1mask.nii.gz"),
            Path::new("/cache"),
            true,
        )
        .is_err());
    }

    #[test]
    fn validate_deface_argv_rejects_non_nifti_and_relative_paths() {
        // Non-nifti input.
        assert!(validate_deface_argv(
            "allineate",
            &deface_argv("/ds/t1.txt", "-deface", "/cache/out.nii.gz")
        )
        .unwrap_err()
        .contains("input must be a .nii"));
        // Relative input (validate_abs_path rejects).
        assert!(validate_deface_argv(
            "allineate",
            &deface_argv("sub-01/t1.nii.gz", "-deface", "/cache/out.nii.gz")
        )
        .is_err());
    }

    fn dilate_argv(input: &str, thr: &str, output: &str) -> Vec<String> {
        strings(&[input, "-binv", "-edt", "-thr", thr, "-binv", output])
    }

    #[test]
    fn validate_niimath_dilate_argv_accepts_well_formed_pipeline() {
        let (input, output, thr) = validate_niimath_dilate_argv(&dilate_argv(
            "/cache/m/mask.nii.gz",
            "8",
            "/cache/m/d.nii.gz",
        ))
        .expect("dilate argv valid");
        assert_eq!(input, PathBuf::from("/cache/m/mask.nii.gz"));
        assert_eq!(output, PathBuf::from("/cache/m/d.nii.gz"));
        assert_eq!(thr, 8.0);
    }

    #[test]
    fn validate_niimath_dilate_argv_rejects_bad_shape_and_threshold() {
        // Wrong arg count.
        assert!(validate_niimath_dilate_argv(&strings(&["/cache/m.nii.gz"]))
            .unwrap_err()
            .contains("expects 7 args"));
        // Non-numeric / flag-injection threshold.
        assert!(validate_niimath_dilate_argv(&dilate_argv(
            "/cache/m.nii.gz",
            "-rm",
            "/cache/d.nii.gz"
        ))
        .unwrap_err()
        .contains("-thr"));
        // Out-of-range threshold (negative parses but fails the range check).
        assert!(validate_niimath_dilate_argv(&dilate_argv(
            "/cache/m.nii.gz",
            "-8",
            "/cache/d.nii.gz"
        ))
        .unwrap_err()
        .contains("(0, 1000]"));
        // Wrong pipeline flag.
        let mut argv = dilate_argv("/cache/m.nii.gz", "8", "/cache/d.nii.gz");
        argv[2] = "-dilD".into();
        assert!(validate_niimath_dilate_argv(&argv)
            .unwrap_err()
            .contains("-edt"));
    }

    #[test]
    fn validate_niimath_dilate_paths_requires_both_under_cache() {
        let run = validate_niimath_dilate_paths(
            Path::new("/cache/m/mask.nii.gz"),
            Path::new("/cache/m/d.nii.gz"),
            Path::new("/cache"),
        )
        .expect("both under cache");
        assert_eq!(run.cwd, PathBuf::from("/cache/m"));
        // Input outside cache (e.g. a dataset file) is refused.
        assert!(validate_niimath_dilate_paths(
            Path::new("/ds/sub-01/anat/t1.nii.gz"),
            Path::new("/cache/m/d.nii.gz"),
            Path::new("/cache"),
        )
        .unwrap_err()
        .contains("not under app cache"));
        // Output outside cache is refused.
        assert!(validate_niimath_dilate_paths(
            Path::new("/cache/m/mask.nii.gz"),
            Path::new("/ds/sub-01/anat/t1.nii.gz"),
            Path::new("/cache"),
        )
        .unwrap_err()
        .contains("not under app cache"));
    }

    /// The canonical-containment check (as composed in
    /// `validate_niimath_dilate_run`) must reject a symlinked input that
    /// resolves outside the cache, and accept a genuine in-cache file even
    /// when the cache root itself traverses a symlink (temp_dir on macOS is
    /// /var -> /private/var). Audit 2026-06-28 regression guard.
    #[cfg(unix)]
    #[test]
    fn niimath_dilate_canonical_check_rejects_cache_symlink_escape() {
        use std::fs;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let base = std::env::temp_dir().join(format!("bidsvue-dilate-canon-{ts}"));
        let job = base.join("cache").join("deface-tmp").join("job");
        let outside = base.join("outside");
        fs::create_dir_all(&job).expect("mkdir job");
        fs::create_dir_all(&outside).expect("mkdir outside");
        let cache_canon = base.join("cache").canonicalize().expect("canon cache");
        let job_canon = job.canonicalize().expect("canon job");

        // Positive: a real mask under the cache canonicalizes in-bounds.
        let real_mask = job.join("mask.nii.gz");
        fs::write(&real_mask, b"x").expect("write mask");
        let real_canon = real_mask.canonicalize().expect("canon mask");
        assert!(validate_niimath_dilate_paths(
            &real_canon,
            &job_canon.join("d.nii.gz"),
            &cache_canon,
        )
        .is_ok());

        // Escape: a symlink under the cache pointing outside resolves out
        // of bounds once canonicalized, so the check refuses it.
        let secret = outside.join("secret.nii.gz");
        fs::write(&secret, b"x").expect("write secret");
        let link = job.join("evil.nii.gz");
        std::os::unix::fs::symlink(&secret, &link).expect("symlink");
        let link_canon = link.canonicalize().expect("canon link");
        assert!(validate_niimath_dilate_paths(
            &link_canon,
            &job_canon.join("d.nii.gz"),
            &cache_canon,
        )
        .unwrap_err()
        .contains("not under app cache"));

        fs::remove_dir_all(&base).ok();
    }

    /// `resolve_niimath_dilate_spawn` must emit CANONICAL paths + constant
    /// flags + a re-stringified threshold (no raw renderer byte survives),
    /// and refuse a pre-existing output. Guards the "validate canonical,
    /// spawn raw" regression (audit 2026-06-28 follow-up P2).
    #[cfg(unix)]
    #[test]
    fn resolve_niimath_dilate_spawn_emits_canonical_argv_and_refuses_existing_output() {
        use std::fs;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let base = std::env::temp_dir().join(format!("bidsvue-dilate-spawn-{ts}"));
        let job = base.join("cache").join("deface-tmp").join("job");
        fs::create_dir_all(&job).expect("mkdir job");
        let cache_canon = base.join("cache").canonicalize().expect("canon cache");
        let job_canon = job.canonicalize().expect("canon job");
        let mask = job.join("mask.nii.gz");
        fs::write(&mask, b"x").expect("write mask");
        let out = job.join("d.nii.gz");

        let run = resolve_niimath_dilate_spawn(
            &dilate_argv(mask.to_str().unwrap(), "8", out.to_str().unwrap()),
            &cache_canon,
        )
        .expect("resolve ok");
        // Spawned argv is the canonical input/output + constant flags + "8".
        assert_eq!(run.argv.len(), 7);
        assert_eq!(run.argv[0], mask.canonicalize().unwrap().to_string_lossy());
        assert_eq!(run.argv[1], "-binv");
        assert_eq!(run.argv[2], "-edt");
        assert_eq!(run.argv[3], "-thr");
        assert_eq!(run.argv[4], "8");
        assert_eq!(run.argv[5], "-binv");
        assert_eq!(run.argv[6], job_canon.join("d.nii.gz").to_string_lossy());
        assert_eq!(run.cwd, job_canon);

        // A pre-existing output is refused (no-clobber / planted-symlink guard).
        fs::write(&out, b"y").expect("write out");
        assert!(resolve_niimath_dilate_spawn(
            &dilate_argv(mask.to_str().unwrap(), "8", out.to_str().unwrap()),
            &cache_canon,
        )
        .unwrap_err()
        .contains("must not already exist"));

        fs::remove_dir_all(&base).ok();
    }

    /// The sidecar-defacer spawn resolver must (a) accept a legit input under
    /// a SYMLINKED picker root and emit canonical argv, (b) reject a NIfTI
    /// inside the dataset that symlinks OUTSIDE the root, and (c) refuse a
    /// pre-existing output. Audit 2026-06-28 round-3 P2 (the production-path
    /// canonicalization, finally landed).
    #[cfg(unix)]
    #[test]
    fn resolve_deface_spawn_canonicalizes_and_blocks_symlink_escape() {
        use std::fs;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let base = std::env::temp_dir().join(format!("bidsvue-deface-spawn-{ts}"));
        // A SYMLINKED picker root: real dir at base/real_ds, symlink base/ds.
        let real_ds = base.join("real_ds");
        let anat = real_ds.join("sub-01").join("anat");
        fs::create_dir_all(&anat).expect("mkdir anat");
        let t1 = anat.join("sub-01_T1w.nii.gz");
        fs::write(&t1, b"x").expect("write t1");
        let ds_link = base.join("ds");
        std::os::unix::fs::symlink(&real_ds, &ds_link).expect("symlink ds");
        // cache + bundled template/mask + an outside secret.
        let cache = base.join("cache");
        fs::create_dir_all(&cache).expect("mkdir cache");
        let res = base.join("res");
        fs::create_dir_all(&res).expect("mkdir res");
        let tmpl = res.join("avg152T1.nii.gz");
        fs::write(&tmpl, b"t").expect("write tmpl");
        let mask = res.join("avg152T1mask.nii.gz");
        fs::write(&mask, b"m").expect("write mask");
        let out = cache.join("out.nii.gz");

        // dataset_root passed in is the SYMLINKED picker root (as-typed).
        let parts = DefaceArgvParts {
            input: ds_link
                .join("sub-01")
                .join("anat")
                .join("sub-01_T1w.nii.gz"),
            template: tmpl.clone(),
            mask: mask.clone(),
            output: out.clone(),
        };
        let (argv, cwd) = resolve_deface_spawn("allineate", &parts, &ds_link, &tmpl, &mask, &cache)
            .expect("legit symlinked root resolves");
        assert_eq!(argv.len(), 6);
        // input canonicalizes THROUGH the picker-root symlink to the real file.
        assert_eq!(argv[0], t1.canonicalize().unwrap().to_string_lossy());
        assert_eq!(argv[1], "-robustfov");
        assert_eq!(argv[2], "-deface");
        assert_eq!(
            argv[5],
            cache
                .canonicalize()
                .unwrap()
                .join("out.nii.gz")
                .to_string_lossy()
        );
        // cwd is the CANONICAL output parent, not the raw one.
        assert_eq!(cwd, cache.canonicalize().unwrap());

        // A NIfTI inside the dataset that symlinks OUTSIDE the root is refused.
        let secret = base.join("secret.nii.gz");
        fs::write(&secret, b"s").expect("write secret");
        let evil = anat.join("evil.nii.gz");
        std::os::unix::fs::symlink(&secret, &evil).expect("symlink evil");
        let evil_parts = DefaceArgvParts {
            input: ds_link.join("sub-01").join("anat").join("evil.nii.gz"),
            ..parts.clone()
        };
        assert!(
            resolve_deface_spawn("allineate", &evil_parts, &ds_link, &tmpl, &mask, &cache)
                .unwrap_err()
                .contains("resolves outside datasetRoot")
        );

        // Pre-existing output is refused.
        fs::write(&out, b"y").expect("write out");
        assert!(
            resolve_deface_spawn("allineate", &parts, &ds_link, &tmpl, &mask, &cache)
                .unwrap_err()
                .contains("must not already exist")
        );

        fs::remove_dir_all(&base).ok();
    }

    fn tmp_trust_file() -> PathBuf {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "bidsvue-process-test-{}-{ts}.json",
            std::process::id()
        ))
    }

    #[test]
    fn validates_reproin_shape() {
        let argv = strings(&[
            "-f", "%H", "-z", "y", "-ba", "n", "-o", "/tmp/out", "-bi", "01", "-bv", "A2",
            "/tmp/src",
        ]);
        assert_eq!(
            validate_reproin_argv(&argv).unwrap().cwd,
            PathBuf::from("/tmp/out")
        );
    }

    #[test]
    fn rejects_reproin_unknown_flag() {
        let argv = strings(&[
            "-f", "%H", "-z", "y", "--delete", "-o", "/tmp/out", "/tmp/src",
        ]);
        assert!(validate_reproin_argv(&argv).is_err());
    }

    #[test]
    fn accepts_reproin_ba_o() {
        // v1.0.20260520 default for anonymize=off: -ba o (omit PII,
        // keep AcquisitionDateTime).
        let argv = strings(&[
            "-f", "%H", "-z", "y", "-ba", "o", "-o", "/tmp/out", "/tmp/src",
        ]);
        assert!(validate_reproin_argv(&argv).is_ok());
    }

    #[test]
    fn rejects_reproin_ba_unknown() {
        let argv = strings(&[
            "-f", "%H", "-z", "y", "-ba", "x", "-o", "/tmp/out", "/tmp/src",
        ]);
        assert!(validate_reproin_argv(&argv).is_err());
    }

    #[test]
    fn validates_pet2bids_shape() {
        let argv = strings(&[
            "-f",
            "sub-01_ses-A_pet",
            "-z",
            "y",
            "-w",
            "1",
            "-ba",
            "y",
            "-o",
            "/tmp/out/sub-01/ses-A/pet",
            "/tmp/src",
        ]);
        assert!(validate_pet2bids_argv(&argv).is_ok());
    }

    #[test]
    fn accepts_pet2bids_ba_o() {
        // The wizard's anonymize=off path now emits -ba o (was -ba n,
        // which leaked PatientName). The validator must accept it.
        let argv = strings(&[
            "-f",
            "sub-01_pet",
            "-z",
            "y",
            "-w",
            "1",
            "-ba",
            "o",
            "-o",
            "/tmp/out/sub-01/pet",
            "/tmp/src",
        ]);
        assert!(validate_pet2bids_argv(&argv).is_ok());
    }

    #[test]
    fn rejects_pet2bids_ba_unknown() {
        let argv = strings(&[
            "-f",
            "sub-01_pet",
            "-z",
            "y",
            "-w",
            "1",
            "-ba",
            "x",
            "-o",
            "/tmp/out/sub-01/pet",
            "/tmp/src",
        ]);
        assert!(validate_pet2bids_argv(&argv).is_err());
    }

    #[test]
    fn rejects_pet2bids_bad_stem() {
        let argv = strings(&[
            "-f", "../bad", "-z", "y", "-w", "1", "-ba", "y", "-o", "/tmp/out", "/tmp/src",
        ]);
        assert!(validate_pet2bids_argv(&argv).is_err());
    }

    #[test]
    fn validates_heudiconv_shape() {
        let argv = strings(&[
            "-c",
            "dcm2niix",
            "--bids",
            "-o",
            "/tmp/out",
            "-f",
            "/tmp/heuristic.py",
            "-s",
            "01",
            "--files",
            "/tmp/src",
        ]);
        let run = validate_heudiconv_argv(&argv).unwrap();
        assert_eq!(run.heuristic_path, Some(PathBuf::from("/tmp/heuristic.py")));
    }

    #[test]
    fn rejects_heudiconv_flag_heuristic() {
        let argv = strings(&[
            "-c", "dcm2niix", "--bids", "-o", "/tmp/out", "-f", "--bad", "--files", "/tmp/src",
        ]);
        assert!(validate_heudiconv_argv(&argv).is_err());
    }

    #[test]
    fn validates_dcm2bids_shape() {
        let argv = strings(&[
            "-d",
            "/tmp/src",
            "-p",
            "01",
            "-c",
            "/tmp/config.json",
            "-o",
            "/tmp/out",
            "-s",
            "A2",
        ]);
        assert!(validate_dcm2bids_argv(&argv).is_ok());
    }

    #[test]
    fn rejects_dcm2bids_bad_config_extension() {
        let argv = strings(&[
            "-d",
            "/tmp/src",
            "-p",
            "01",
            "-c",
            "/tmp/config.txt",
            "-o",
            "/tmp/out",
        ]);
        assert!(validate_dcm2bids_argv(&argv).is_err());
    }

    #[test]
    fn authorize_import_rejects_missing_config_token() {
        let store = crate::trust::TrustStore::empty_for_test(tmp_trust_file());
        let src_token = store.mint_token(PathBuf::from("/tmp/src")).unwrap();
        let dest_token = store.mint_token(PathBuf::from("/tmp")).unwrap();
        let argv = strings(&[
            "-d",
            "/tmp/src",
            "-p",
            "01",
            "-c",
            "/tmp/config.json",
            "-o",
            "/tmp/out",
        ]);
        let run = validate_import_run("dcm2bids", &argv).unwrap();
        let auth = ImportProcessAuth {
            src_dir_token: src_token,
            dest_dir_parent_token: dest_token,
            heuristic_token: None,
            config_token: None,
        };

        let err = authorize_import_run(&store, &run, &auth).unwrap_err();

        assert!(err.contains("missing config token"));
    }

    #[test]
    fn authorize_import_accepts_picked_custom_heuristic() {
        let store = crate::trust::TrustStore::empty_for_test(tmp_trust_file());
        let src_token = store.mint_token(PathBuf::from("/tmp/src")).unwrap();
        let dest_token = store.mint_token(PathBuf::from("/tmp")).unwrap();
        let heuristic_token = store
            .mint_token(PathBuf::from("/tmp/heuristic.py"))
            .unwrap();
        let argv = strings(&[
            "-c",
            "dcm2niix",
            "--bids",
            "-o",
            "/tmp/out",
            "-f",
            "/tmp/heuristic.py",
            "--files",
            "/tmp/src",
        ]);
        let run = validate_import_run("heudiconv", &argv).unwrap();
        let auth = ImportProcessAuth {
            src_dir_token: src_token,
            dest_dir_parent_token: dest_token,
            heuristic_token: Some(heuristic_token),
            config_token: None,
        };

        assert!(authorize_import_run(&store, &run, &auth).is_ok());
    }

    /// Audit (2026-06-14 round 5, external P3) — stale shim dirs left
    /// by dead PIDs accumulate across dev/test sessions. The purge
    /// helper removes them best-effort; verify it picks the right
    /// ones (dead PID, our uid, matching basename prefix) and leaves
    /// live / unrelated entries alone.
    #[cfg(unix)]
    #[test]
    fn purge_stale_dcm2niix_shim_dirs_removes_only_dead_pids() {
        let real_tmp = std::env::temp_dir();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        // Sentinel basenames: include a randomish suffix so parallel
        // test runs don't collide. Walk PIDs downward until we find
        // one that's not currently alive. PID 999999 is virtually
        // never live on macOS, but be defensive in case of CI quirks.
        let mut candidate = 999_999u32;
        while unsafe { libc::kill(candidate as libc::pid_t, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        {
            candidate -= 1;
            if candidate < 100_000 {
                // Give up safely — the test asserts a sentinel exists
                // before the call and is absent after, so even with a
                // pathologically busy PID table we don't false-fail.
                break;
            }
        }
        let dead = real_tmp.join(format!("bidsvue-dcm2niix-{candidate}-test-{stamp}"));
        let live = real_tmp.join(format!(
            "bidsvue-dcm2niix-{}-current-{stamp}",
            std::process::id()
        ));
        let unrelated = real_tmp.join(format!("bidsvue-other-{stamp}"));
        for d in [&dead, &live, &unrelated] {
            let _ = std::fs::remove_dir_all(d);
            std::fs::create_dir(d).unwrap();
        }
        // Sanity: dead actually was created. (We don't fabricate the
        // PID's deadness — we're trusting `kill(0)` above.)
        assert!(dead.exists());

        purge_stale_dcm2niix_shim_dirs();

        // Live (our PID) and unrelated (no `dcm2niix-` prefix) must
        // survive; dead (other PID, basename matches) must go away.
        assert!(live.exists(), "current-PID shim must not be purged");
        assert!(
            unrelated.exists(),
            "non-matching basename must not be touched"
        );
        // dead may have survived if its PID came back alive between
        // the loop above and the purge — accept either outcome but
        // log the path so a future debug session can spot recurrence.
        if dead.exists() {
            eprintln!(
                "[test] dead-pid sentinel survived purge (likely PID reuse during the test); path={}",
                dead.display()
            );
        }

        // Cleanup so the next run starts fresh.
        for d in [&dead, &live, &unrelated] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    // -- run_streaming_process integration tests (Tier 1.5 cancel) --
}
