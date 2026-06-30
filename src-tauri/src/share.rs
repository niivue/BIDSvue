//! Per-backend share-token storage (M1 of the cloud-share feature).
//!
//! Mirrors the [TrustStore] pattern: a Rust-managed file under
//! `<app_data_dir>/share/<backend>/jwt` that the renderer reaches only
//! through `share_token_put` / `share_token_get` / `share_token_delete`
//! Tauri commands. The capability allowlist denies `$APPDATA/share/**`
//! to plugin-fs so a compromised renderer cannot peek at, forge, or
//! exfiltrate tokens directly.
//!
//! Why not reuse the trust file? Tokens are arbitrary bearer credentials
//! (brainlife JWT today, OAuth refresh tokens / API keys later) so they
//! need stronger handling than the public path list the trust file
//! holds: per-backend separation so a `share_token_delete('brainlife')`
//! never disturbs other backends, write-only-then-replace so a partial
//! write cannot corrupt a sibling backend's token, and a strict size +
//! charset envelope so a malformed renderer call cannot push garbage
//! into the file system.
//!
//! The Rust surface is intentionally tiny:
//!   * absolute-only paths derived from `<app_data_dir>` + a fixed
//!     `share` segment + the backend slug (no renderer-supplied paths)
//!   * backend slug must be in a static allowlist
//!   * value must be <= [MAX_TOKEN_BYTES] and free of newlines / NUL
//!   * atomic temp + rename + fsync, file mode 0600 on Unix

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

/// Shared `reqwest::Client` reused across OpenNeuro uploads.
///
/// The earlier shape built a fresh client per file (`reqwest::Client::builder()...build()`
/// inside `upload_openneuro_file`), which drops connection pooling
/// between the OpenNeuro shard endpoint and re-runs TLS handshake +
/// DNS + config plumbing for every file in a batch. With a typical
/// BIDS dataset's tens of files the cost was small but visible; with
/// many-file datasets it hurt.
///
/// `Client` is internally `Arc`d, so cloning it is cheap. We expose
/// the helper instead of stashing it in Tauri-managed state to keep
/// the per-command surface narrow — the share module owns its HTTP
/// client lifecycle, lazily built on first use. Audit P3.17 (2026-05-25).
fn shared_upload_client() -> Result<reqwest::Client, String> {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = CLIENT.get() {
        return Ok(c.clone());
    }
    let c = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(UPLOAD_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("openneuro_upload_file: reqwest build failed: {e}"))?;
    let _ = CLIENT.set(c.clone());
    Ok(c)
}

/// Backend slugs we are willing to write a token file for. Kept in sync
/// with the renderer's `ShareBackend.id` union in `src/lib/share/types.ts`
/// — **adding a backend on the TS side without updating this list breaks
/// fake-sign-in / production flow silently**, see CLAUDE.md "Cloud-share
/// rules" for the parity invariant.
///
/// The static allowlist is the load-bearing defense against a renderer
/// passing `../` or unusual path components — even a base64-looking
/// string would fail validation here.
///
/// `stub` is dev-only: gated behind `debug_assertions` so production
/// builds (release tauri builds, signed DMG) reject it cleanly. The
/// renderer-side registry hides the stub tile from stable too, but
/// defence-in-depth here means even a hand-tampered renderer cannot
/// pollute the on-disk share/ directory with stub tokens.
#[cfg(debug_assertions)]
const SHARE_BACKENDS: &[&str] = &["brainlife", "ebrains", "openneuro", "stub"];
#[cfg(not(debug_assertions))]
const SHARE_BACKENDS: &[&str] = &["brainlife", "ebrains", "openneuro"];

/// 8 KiB is well past any JWT (the largest brainlife JWT observed in the
/// wild is ~1 KiB) and any OAuth refresh token. Rejecting larger values
/// closes a small DoS-via-disk-fill surface.
const MAX_TOKEN_BYTES: usize = 8 * 1024;

/// Per-backend leaf filename. `jwt` today; if a future backend stores a
/// JSON envelope instead we can revisit the layout.
const TOKEN_LEAF: &str = "jwt";

/// Compute the on-disk path for `backend`'s token, validating that the
/// slug is in the allowlist. Pure / synchronous — no IO. The returned
/// path is `<app_data_dir>/share/<backend>/jwt`.
fn token_path(app_data_dir: &Path, backend: &str) -> Result<PathBuf, String> {
    if !SHARE_BACKENDS.contains(&backend) {
        return Err(format!(
            "share token: backend slug not in allowlist: {backend}"
        ));
    }
    Ok(app_data_dir.join("share").join(backend).join(TOKEN_LEAF))
}

/// Validate the token value envelope before any disk IO.
///
/// `\r` / `\n` rejection prevents a future caller from accidentally
/// composing the value into a header line or shell argv where the
/// extra newline would be interpreted. NUL rejection matches the
/// posture in `append_log_line` and `write_text_atomic_app_data`.
fn validate_value(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("share token: value must not be empty".into());
    }
    if value.len() > MAX_TOKEN_BYTES {
        return Err(format!(
            "share token: value exceeds {MAX_TOKEN_BYTES}-byte limit ({} bytes)",
            value.len()
        ));
    }
    if value.contains('\n') || value.contains('\r') || value.contains('\0') {
        return Err("share token: value must not contain newline or NUL".into());
    }
    Ok(())
}

/// Atomic write to `<app_data_dir>/share/<backend>/jwt`. Creates parent
/// dirs as needed. On Unix sets file mode 0600 so even with multi-user
/// `$HOME/Library/Application Support` quirks the token isn't world-
/// readable. Best-effort fsync on the parent so a torn write surfaces
/// as ENOENT rather than a phantom file with the wrong contents.
pub fn put(app_data_dir: &Path, backend: &str, value: &str) -> Result<(), String> {
    validate_value(value)?;
    let path = token_path(app_data_dir, backend)?;

    let parent = path
        .parent()
        .ok_or_else(|| format!("share token: token path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| {
        format!(
            "share token: create_dir_all({}) failed: {e}",
            parent.display()
        )
    })?;
    let tmp = parent.join(format!(
        "{TOKEN_LEAF}.tmp.{}.{}",
        std::process::id(),
        nanos()
    ));

    {
        let mut open_opts = std::fs::OpenOptions::new();
        open_opts.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            open_opts.mode(0o600);
        }
        let mut handle = open_opts
            .open(&tmp)
            .map_err(|e| format!("share token: open({}) failed: {e}", tmp.display()))?;
        if let Err(e) = handle.write_all(value.as_bytes()) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("share token: write({}) failed: {e}", tmp.display()));
        }
        if let Err(e) = handle.sync_all() {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("share token: sync({}) failed: {e}", tmp.display()));
        }
    }

    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "share token: rename({} -> {}) failed: {e}",
            tmp.display(),
            path.display()
        ));
    }
    if let Ok(dir) = std::fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Returns `Ok(None)` on ENOENT and trims a trailing newline if a
/// well-meaning user hand-edited the file. Validates the surviving
/// contents against the same envelope `put` enforces; a corrupted /
/// truncated file surfaces as an error so callers can prompt for a
/// fresh sign-in rather than silently using junk.
pub fn get(app_data_dir: &Path, backend: &str) -> Result<Option<String>, String> {
    let path = token_path(app_data_dir, backend)?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(format!("share token: read({}) failed: {e}", path.display()));
        }
    };
    let trimmed = raw.trim_end_matches(['\n', '\r']);
    if trimmed.is_empty() {
        return Err(format!(
            "share token: stored value at {} is empty",
            path.display()
        ));
    }
    if trimmed.len() > MAX_TOKEN_BYTES {
        return Err(format!(
            "share token: stored value at {} exceeds {MAX_TOKEN_BYTES}-byte limit",
            path.display()
        ));
    }
    if trimmed.contains('\n') || trimmed.contains('\r') || trimmed.contains('\0') {
        return Err(format!(
            "share token: stored value at {} contains forbidden control characters",
            path.display()
        ));
    }
    Ok(Some(trimmed.to_string()))
}

/// Silent on ENOENT (matches the renderer's "log out idempotently"
/// expectation). The directory is intentionally left in place so a
/// subsequent `put` does not re-incur the mkdir + dir-fsync cost.
pub fn delete(app_data_dir: &Path, backend: &str) -> Result<(), String> {
    let path = token_path(app_data_dir, backend)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!(
            "share token: remove({}) failed: {e}",
            path.display()
        )),
    }
}

fn nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// OpenNeuro file-upload helper.
//
// The OpenNeuro web UI POSTs each file to
// `https://openneuro.org/uploads/<endpoint>/<datasetId>/<uploadId>/<:-encoded-path>`
// with `Authorization: Bearer <short-lived-token-from-prepareUpload>`.
// The server returns 200 but its `Access-Control-Allow-Origin` header
// does NOT include the Tauri WebView origin, so a renderer-side
// `fetch()` is blocked by CORS. Routing the POST through Rust's
// `reqwest` bypasses the same-origin policy (CORS is a browser-context
// rule; Rust's HTTP client is unaffected).
//
// The renderer hands us only a `file_path` — Rust opens the file
// directly. This avoids the 1 GB-class IPC byte copy that a
// `body: Vec<u8>` argument would incur. The caller is responsible
// for ensuring `file_path` is under a runtime-authorized dataset
// root; that check lives in `lib.rs`'s `validate_authorized_path`
// helper, which the Tauri command wrapper invokes before reaching
// `upload_openneuro_file`.
// ---------------------------------------------------------------------------

/// Strict URL prefix the OpenNeuro upload endpoint must match.
const OPENNEURO_UPLOAD_URL_PREFIX: &str = "https://openneuro.org/uploads/";

/// Maximum URL length we'll accept. OpenNeuro paths are short; capping
/// at 4 KiB closes any "stuff a huge URL into the heap" surface.
const MAX_UPLOAD_URL_BYTES: usize = 4096;

/// Maximum body bytes per POST. Set at 5 GiB — well above the largest
/// realistic single-file BIDS payload (uncompressed 4-D BOLD scans
/// typically peak in the 1–2 GiB range) and below `usize::MAX` on
/// 64-bit platforms so the in-memory buffering can't silently overflow.
const MAX_UPLOAD_BYTES: u64 = 5 * 1024 * 1024 * 1024;

/// Per-request timeout for the file POST. OpenNeuro's `/uploads/`
/// endpoint times the request from request-start; 1 h is generous for
/// multi-GB uploads on slow uplinks, and short enough that a hung
/// transport doesn't pin the IPC handle forever.
const UPLOAD_REQUEST_TIMEOUT_SECS: u64 = 3600;

/// Validate the URL shape before reaching out. Mirrors the renderer's
/// `buildUploadFileUrl` output: must start with the OpenNeuro uploads
/// prefix, must be ASCII control-char-free, must be a single line.
fn validate_upload_url(url: &str) -> Result<(), String> {
    if url.is_empty() {
        return Err("openneuro_upload_file: url must not be empty".into());
    }
    if url.len() > MAX_UPLOAD_URL_BYTES {
        return Err(format!(
            "openneuro_upload_file: url exceeds {MAX_UPLOAD_URL_BYTES}-byte limit"
        ));
    }
    if !url.starts_with(OPENNEURO_UPLOAD_URL_PREFIX) {
        return Err(format!(
            "openneuro_upload_file: url must start with {OPENNEURO_UPLOAD_URL_PREFIX}"
        ));
    }
    if url
        .bytes()
        .any(|b| b == b'\0' || b == b'\r' || b == b'\n' || b == b'\t')
    {
        return Err("openneuro_upload_file: url must not contain control characters".into());
    }
    Ok(())
}

/// Re-validate the bearer envelope at the Rust boundary. Mirrors
/// `validate_value` for the share-token store: non-empty, size capped,
/// no newlines / NUL.
fn validate_bearer(jwt: &str) -> Result<(), String> {
    if jwt.is_empty() {
        return Err("openneuro_upload_file: jwt must not be empty".into());
    }
    if jwt.len() > MAX_TOKEN_BYTES {
        return Err(format!(
            "openneuro_upload_file: jwt exceeds {MAX_TOKEN_BYTES}-byte limit"
        ));
    }
    if jwt.contains('\n') || jwt.contains('\r') || jwt.contains('\0') {
        return Err("openneuro_upload_file: jwt must not contain newline or NUL".into());
    }
    Ok(())
}

/// Per-file upload result returned to the renderer.
///
/// `sha256_hex` is computed over the bytes as they are streamed to the
/// network — same byte sequence the server receives, byte-for-byte. The
/// renderer persists this in `share.json` so the manifest is identical
/// to what hit the wire (closes the "hash recorded for bytes that were
/// not uploaded" gap: re-reading the file later, after the user has
/// saved a sidecar or renamed an entity, would record a different SHA
/// than what OpenNeuro actually stored).
#[derive(serde::Serialize)]
pub struct OpenNeuroUploadOutcome {
    pub sha256_hex: String,
    pub bytes_uploaded: u64,
}

/// Stream `file_path` to `url` as the POST body, hashing each chunk as
/// it flows past so the returned SHA-256 is the SHA-256 of exactly the
/// bytes the OpenNeuro server received. Called by the Tauri command in
/// `lib.rs` after path validation.
///
/// Streaming (rather than `std::fs::read(...)` + body) is load-bearing
/// for beta: a 2 GB BOLD scan would otherwise inflate the Rust process
/// heap by 2 GB during the upload. With streaming the working set is a
/// 1 MiB chunk + the network buffer.
///
/// On non-2xx the returned error includes up to the first 400 bytes of
/// the server's reply body (after JWT-like substring scrubbing) so the
/// renderer can surface a useful failure reason.
pub async fn upload_openneuro_file(
    url: &str,
    jwt: &str,
    file_path: &Path,
) -> Result<OpenNeuroUploadOutcome, String> {
    validate_upload_url(url)?;
    validate_bearer(jwt)?;

    // Pre-size guard. The streaming body would happily ship a 100 GB
    // file but the OpenNeuro server has its own per-request limit and
    // the WebView can't usefully resume from mid-POST, so refuse
    // oversize here with a clear error rather than wait for a timeout.
    let metadata = tokio::fs::metadata(file_path).await.map_err(|e| {
        format!(
            "openneuro_upload_file: stat({}) failed: {e}",
            file_path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "openneuro_upload_file: {} is not a regular file",
            file_path.display()
        ));
    }
    let content_len = metadata.len();
    if content_len > MAX_UPLOAD_BYTES {
        return Err(format!(
            "openneuro_upload_file: {} exceeds {MAX_UPLOAD_BYTES}-byte upload cap (got {content_len} bytes)",
            file_path.display(),
        ));
    }

    // Stream the body via `futures::stream::unfold`: we yield one Bytes
    // chunk per pump iteration, updating the in-state hasher as we go.
    // 1 MiB chunks keep the working set small while amortising syscall
    // overhead on multi-GB files.
    const CHUNK_BYTES: usize = 1024 * 1024;
    let file = tokio::fs::File::open(file_path).await.map_err(|e| {
        format!(
            "openneuro_upload_file: open({}) failed: {e}",
            file_path.display()
        )
    })?;
    let display_path = file_path.display().to_string();

    struct PumpState {
        file: tokio::fs::File,
        hasher: Sha256,
        bytes_read: u64,
        finished: bool,
    }
    let pump_state = std::sync::Arc::new(tokio::sync::Mutex::new(PumpState {
        file,
        hasher: Sha256::new(),
        bytes_read: 0,
        finished: false,
    }));
    let pump_state_for_stream = pump_state.clone();
    let display_for_stream = display_path.clone();

    let body_stream = futures_util::stream::unfold((), move |()| {
        let state = pump_state_for_stream.clone();
        let display = display_for_stream.clone();
        async move {
            let mut guard = state.lock().await;
            if guard.finished {
                return None;
            }
            let mut buf = vec![0u8; CHUNK_BYTES];
            match guard.file.read(&mut buf).await {
                Ok(0) => {
                    guard.finished = true;
                    // Audit security P2 (2026-05-25): if the file
                    // shrank during upload, we hit EOF before
                    // Content-Length bytes have been streamed. Without
                    // an explicit error the body stream just ends and
                    // hyper waits for the missing bytes until the
                    // 1-hour request timeout fires. Surface a
                    // synchronous io::Error so the POST aborts now.
                    if guard.bytes_read < content_len {
                        let short = guard.bytes_read;
                        return Some((
                            Err(std::io::Error::new(
                                std::io::ErrorKind::UnexpectedEof,
                                format!(
                                    "openneuro_upload_file: {display} shrank during upload \
                                     (Content-Length {content_len} bytes, read {short})"
                                ),
                            )),
                            (),
                        ));
                    }
                    None
                }
                Ok(n) => {
                    guard.hasher.update(&buf[..n]);
                    guard.bytes_read = guard.bytes_read.saturating_add(n as u64);
                    // If the file GREW during upload, the stream would
                    // otherwise keep yielding beyond Content-Length —
                    // the server would either reject or silently drop
                    // the tail. Cap at content_len to match the
                    // declared length; surface as an error so the
                    // caller knows the upload doesn't represent the
                    // current file.
                    if guard.bytes_read > content_len {
                        guard.finished = true;
                        let overrun = guard.bytes_read;
                        return Some((
                            Err(std::io::Error::new(
                                std::io::ErrorKind::Other,
                                format!(
                                    "openneuro_upload_file: {display} grew during upload \
                                     (Content-Length {content_len} bytes, would stream {overrun})"
                                ),
                            )),
                            (),
                        ));
                    }
                    buf.truncate(n);
                    let chunk: Result<bytes::Bytes, std::io::Error> = Ok(bytes::Bytes::from(buf));
                    Some((chunk, ()))
                }
                Err(e) => {
                    guard.finished = true;
                    Some((
                        Err(std::io::Error::new(
                            e.kind(),
                            format!("read({display}) failed: {e}"),
                        )),
                        (),
                    ))
                }
            }
        }
    });
    let body = reqwest::Body::wrap_stream(body_stream);

    let client = shared_upload_client()?;

    let request = client
        .post(url)
        .header("Authorization", format!("Bearer {jwt}"))
        .header("Content-Type", "application/octet-stream")
        // Pre-declare the body length so OpenNeuro's nginx layer doesn't
        // 411-reject the request (chunked transfer-encoding works too,
        // but explicit Content-Length matches the web UI's request shape
        // exactly and avoids any path through the server that might
        // treat chunked uploads differently).
        .header("Content-Length", content_len.to_string())
        .body(body);

    let response = request
        .send()
        .await
        .map_err(|e| format!("openneuro_upload_file: network error contacting {url}: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        // Audit 2026-06-11 P2: `&body[..400]` panics when the 400th
        // byte splits a multibyte UTF-8 character (responses with
        // non-ASCII content + an OpenNeuro error). Walk char boundaries
        // backwards from byte 400 to find the nearest safe split.
        let truncated = if body.len() > 400 {
            let mut end = 400;
            while end > 0 && !body.is_char_boundary(end) {
                end -= 1;
            }
            &body[..end]
        } else {
            body.as_str()
        };
        let scrubbed = scrub_jwt_like(truncated);
        return Err(format!(
            "openneuro_upload_file: OpenNeuro returned HTTP {} for {url}{}",
            status.as_u16(),
            if scrubbed.is_empty() {
                String::new()
            } else {
                format!(" — {scrubbed}")
            }
        ));
    }

    // Consume the response body (typically `{}`) so the connection
    // closes cleanly. Errors here are non-fatal; the upload itself
    // already succeeded.
    let _ = response.text().await;

    // Pull the final digest out of the pump state via the mutex. Lock
    // contention is impossible here: reqwest's body stream has been
    // fully drained (we already consumed the response above), so no
    // other task is touching the state. We extract bytes_read + finalise
    // the hasher under the lock then drop the guard before returning.
    //
    // The pump's `finished` flag is set inside the `Ok(0)` EOF arm of
    // the unfold. With a single-chunk file (anything ≤ CHUNK_BYTES),
    // reqwest can complete the request after the first chunk satisfies
    // Content-Length and never poll the stream a second time — so the
    // EOF arm never runs and `finished` stays false even though the
    // body was delivered intact. Regression history (2026-05-26): a
    // 364-byte BIDS `CHANGES` file triggered this hard-error on every
    // upload. The integrity guard that actually matters is
    // `bytes_read == content_len` below; `finished == false` is fine
    // as long as we delivered the right byte count. We do still treat
    // `finished == false AND bytes_read < content_len` as a real
    // failure (it means reqwest abandoned the body mid-stream before
    // the file ran out, which the shrink-guard in the EOF arm would
    // have caught had the pump been polled to completion).
    let (hex, bytes_read, pump_finished) = {
        let mut guard = pump_state.lock().await;
        let bytes_read = guard.bytes_read;
        let pump_finished = guard.finished;
        // `Sha256::finalize` consumes the hasher; swap a fresh one in so
        // the mutable borrow lets us call it.
        let hasher = std::mem::replace(&mut guard.hasher, Sha256::new());
        (bytes_to_hex(&hasher.finalize()), bytes_read, pump_finished)
    };
    if bytes_read != content_len {
        return Err(format!(
            "openneuro_upload_file: file size changed during upload (stat said {content_len} bytes, streamed {bytes_read} of {display_path}{})",
            if pump_finished { "" } else { "; pump did not observe EOF" }
        ));
    }
    Ok(OpenNeuroUploadOutcome {
        sha256_hex: hex,
        bytes_uploaded: bytes_read,
    })
}

/// Streaming SHA-256 over a single local file. Used by the cloud-share
/// manifest walker so multi-GB BOLD scans don't slurp through the
/// WebView's WebCrypto heap. The renderer-side `walkManifest` falls
/// back to WebCrypto when this command is unavailable (e.g. in `bun
/// test` outside the Tauri runtime).
pub async fn hash_file_sha256(path: &Path) -> Result<String, String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("hash_file_sha256: stat({}) failed: {e}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "hash_file_sha256: {} is not a regular file",
            path.display()
        ));
    }
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("hash_file_sha256: open({}) failed: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| format!("hash_file_sha256: read({}) failed: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(bytes_to_hex(&hasher.finalize()))
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Strip anything that looks like a three-segment dotted base64url
/// run from a server-controlled string, so a misconfigured nginx /
/// CDN error page that echoes the inbound `Authorization` header
/// can't leak the bearer back to the renderer.
fn scrub_jwt_like(s: &str) -> String {
    // Hand-rolled scan instead of pulling in `regex` for one pattern.
    // A "JWT-like" run is `[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`.
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        if let Some(end) = match_jwt_like(&bytes[i..]) {
            out.push_str("<redacted-token>");
            i += end;
        } else {
            // Push the next UTF-8 character (preserves multi-byte runs).
            let ch_end = next_char_end(&bytes[i..]);
            out.push_str(&s[i..i + ch_end]);
            i += ch_end;
        }
    }
    out
}

/// Returns `Some(len)` if `bytes[..len]` matches the JWT-like pattern.
fn match_jwt_like(bytes: &[u8]) -> Option<usize> {
    let mut i = 0;
    for _segment in 0..3 {
        let start = i;
        while i < bytes.len() && is_base64url_byte(bytes[i]) {
            i += 1;
        }
        if i - start < 16 {
            return None;
        }
        if _segment < 2 {
            if i >= bytes.len() || bytes[i] != b'.' {
                return None;
            }
            i += 1;
        }
    }
    Some(i)
}

fn is_base64url_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

/// Conservative next-char advance. Handles UTF-8 multi-byte runs so
/// the scrubber doesn't split a glyph in half when copying through.
fn next_char_end(bytes: &[u8]) -> usize {
    if bytes.is_empty() {
        return 0;
    }
    let lead = bytes[0];
    let width = if lead < 0x80 {
        1
    } else if lead & 0xE0 == 0xC0 {
        2
    } else if lead & 0xF0 == 0xE0 {
        3
    } else if lead & 0xF8 == 0xF0 {
        4
    } else {
        1 // Invalid UTF-8 byte — advance one to make progress.
    };
    width.min(bytes.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_app_data() -> PathBuf {
        // Combine pid + nanos + a process-wide atomic counter so two
        // parallel tests can never collide even if macOS's SystemTime
        // resolution returns the same nanos value for both.
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "bidsvue-share-test-{}-{}-{seq}",
            std::process::id(),
            nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn put_then_get_roundtrips() {
        let dir = tmp_app_data();
        put(&dir, "brainlife", "abc.def.ghi").unwrap();
        let got = get(&dir, "brainlife").unwrap();
        assert_eq!(got, Some("abc.def.ghi".to_string()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn get_missing_returns_none() {
        let dir = tmp_app_data();
        let got = get(&dir, "brainlife").unwrap();
        assert!(got.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn put_replaces_existing_value() {
        let dir = tmp_app_data();
        put(&dir, "brainlife", "old.token").unwrap();
        put(&dir, "brainlife", "new.token").unwrap();
        let got = get(&dir, "brainlife").unwrap();
        assert_eq!(got, Some("new.token".to_string()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_removes_file_and_is_idempotent() {
        let dir = tmp_app_data();
        put(&dir, "brainlife", "x").unwrap();
        delete(&dir, "brainlife").unwrap();
        assert!(get(&dir, "brainlife").unwrap().is_none());
        // Idempotent: second delete still ok.
        delete(&dir, "brainlife").unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn backends_are_isolated() {
        let dir = tmp_app_data();
        put(&dir, "brainlife", "bl-token").unwrap();
        put(&dir, "ebrains", "eb-token").unwrap();
        assert_eq!(get(&dir, "brainlife").unwrap().as_deref(), Some("bl-token"));
        assert_eq!(get(&dir, "ebrains").unwrap().as_deref(), Some("eb-token"));
        delete(&dir, "brainlife").unwrap();
        assert!(get(&dir, "brainlife").unwrap().is_none());
        // Sibling not disturbed.
        assert_eq!(get(&dir, "ebrains").unwrap().as_deref(), Some("eb-token"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unknown_backend_is_rejected() {
        let dir = tmp_app_data();
        let err = put(&dir, "evil-backend", "x").unwrap_err();
        assert!(err.contains("not in allowlist"), "got: {err}");
        let err = get(&dir, "../etc").unwrap_err();
        assert!(err.contains("not in allowlist"), "got: {err}");
        let err = delete(&dir, "brainlife/../trust").unwrap_err();
        assert!(err.contains("not in allowlist"), "got: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_value_is_rejected() {
        let dir = tmp_app_data();
        let err = put(&dir, "brainlife", "").unwrap_err();
        assert!(err.contains("empty"), "got: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn newline_in_value_is_rejected() {
        let dir = tmp_app_data();
        let err = put(&dir, "brainlife", "abc\ndef").unwrap_err();
        assert!(err.contains("newline"), "got: {err}");
        let err = put(&dir, "brainlife", "abc\rdef").unwrap_err();
        assert!(err.contains("newline"), "got: {err}");
        let err = put(&dir, "brainlife", "abc\0def").unwrap_err();
        assert!(err.contains("newline") || err.contains("NUL"), "got: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn oversize_value_is_rejected() {
        let dir = tmp_app_data();
        let big = "x".repeat(MAX_TOKEN_BYTES + 1);
        let err = put(&dir, "brainlife", &big).unwrap_err();
        assert!(err.contains("limit"), "got: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn get_trims_trailing_newline_from_hand_edit() {
        let dir = tmp_app_data();
        let path = token_path(&dir, "brainlife").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "abc.def\n").unwrap();
        assert_eq!(get(&dir, "brainlife").unwrap().as_deref(), Some("abc.def"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn get_rejects_corrupted_stored_value() {
        let dir = tmp_app_data();
        let path = token_path(&dir, "brainlife").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "good-prefix\nrest").unwrap();
        let err = get(&dir, "brainlife").unwrap_err();
        assert!(err.contains("control"), "got: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn token_file_is_mode_0600_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_app_data();
        put(&dir, "brainlife", "x").unwrap();
        let path = token_path(&dir, "brainlife").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0600, got {mode:o}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn validate_upload_url_accepts_canonical_paths() {
        validate_upload_url(
            "https://openneuro.org/uploads/2/ds007828/443ee8bd/dataset_description.json",
        )
        .unwrap();
        validate_upload_url(
            "https://openneuro.org/uploads/2/ds007828/443ee8bd/sub-01:anat:sub-01_T1w.nii.gz",
        )
        .unwrap();
    }

    #[test]
    fn validate_upload_url_rejects_wrong_prefix_and_dangerous_chars() {
        assert!(validate_upload_url("https://openneuro.org/datasets/ds000001").is_err());
        assert!(validate_upload_url("http://openneuro.org/uploads/x/y/z/file").is_err());
        assert!(validate_upload_url("https://openneuro.org.evil.example/uploads/x").is_err());
        assert!(
            validate_upload_url("https://openneuro.org/uploads/2/ds007828/443ee8bd/a\nb").is_err()
        );
        assert!(validate_upload_url("").is_err());
    }

    #[test]
    fn validate_bearer_rejects_newlines_and_oversize() {
        assert!(validate_bearer("").is_err());
        assert!(validate_bearer("abc\ndef").is_err());
        assert!(validate_bearer("abc\rdef").is_err());
        assert!(validate_bearer("abc\0def").is_err());
        let big = "x".repeat(MAX_TOKEN_BYTES + 1);
        assert!(validate_bearer(&big).is_err());
        validate_bearer("abc.def.ghi").unwrap();
    }

    #[test]
    fn scrub_jwt_like_redacts_three_segment_runs() {
        let header = "a".repeat(20);
        let payload = "b".repeat(20);
        let sig = "c".repeat(20);
        let jwt = format!("{header}.{payload}.{sig}");
        let echoed = format!("Authorization: Bearer {jwt} (got 401)");
        let scrubbed = scrub_jwt_like(&echoed);
        assert!(!scrubbed.contains(&jwt), "scrubbed: {scrubbed}");
        assert!(scrubbed.contains("<redacted-token>"));
    }

    #[test]
    fn scrub_jwt_like_leaves_normal_text_alone() {
        let s = "OpenNeuro returned HTTP 401 — token invalid";
        assert_eq!(scrub_jwt_like(s), s);
    }

    #[test]
    fn scrub_jwt_like_preserves_utf8_multibyte() {
        let s = "ÉÚÑ — résumé";
        assert_eq!(scrub_jwt_like(s), s);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn hash_file_sha256_matches_known_digest() {
        // SHA-256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
        let dir = tmp_app_data();
        let path = dir.join("payload.bin");
        std::fs::write(&path, b"hello world").unwrap();
        let hex = hash_file_sha256(&path).await.unwrap();
        assert_eq!(
            hex, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
            "got {hex}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn hash_file_sha256_streams_multi_chunk_file() {
        // 3 MiB of zero bytes — exercises the chunked-read loop.
        let dir = tmp_app_data();
        let path = dir.join("zeros.bin");
        let zeros = vec![0u8; 3 * 1024 * 1024];
        std::fs::write(&path, &zeros).unwrap();
        let hex = hash_file_sha256(&path).await.unwrap();
        // Pre-computed sha256 of 3 MiB of zero bytes.
        assert_eq!(
            hex, "bbd05cf6097ac9b1f89ea29d2542c1b7b67ee46848393895f5a9e43fa1f621e5",
            "got {hex}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn hash_file_sha256_rejects_non_regular_file() {
        let dir = tmp_app_data();
        let err = hash_file_sha256(&dir).await.unwrap_err();
        assert!(err.contains("not a regular file"), "got: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
