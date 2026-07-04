// Windows security/FFI helpers for the AI control channel (M-AI Windows port).
//
// The AI write bridge on Unix relies on three OS primitives that have no
// direct portable analogue: a Unix-domain socket with SO_PEERCRED peer-UID
// auth, `0o700`/`0o600` file modes on the session dir/secrets, and
// `/proc`-style process-start-time for stale-session detection. This module
// provides the Windows equivalents:
//
//   * `SecurityAttributes::current_user_only` — a SECURITY_ATTRIBUTES whose
//     DACL grants access to ONLY the current user's SID (the SO_PEERCRED
//     analogue), for the named-pipe control channel.
//   * `restrict_path_to_current_user` — apply that same protected DACL to a
//     file/dir (the `0o700`/`0o600` analogue) via SetNamedSecurityInfo.
//   * `process_creation_time` — the process creation FILETIME as a u64
//     liveness key (the `/proc/<pid>/stat` starttime analogue).
//
// All of this is `#[cfg(windows)]`-only; the Unix build never compiles it.
// Every `unsafe` block is a thin, checked wrapper over one Win32 call.

#![cfg(windows)]

use std::ffi::c_void;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::path::PathBuf;

use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SetNamedSecurityInfoW, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    GetSecurityDescriptorDacl, GetTokenInformation, TokenUser, DACL_SECURITY_INFORMATION,
    OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

/// SDDL revision constant (SDDL_REVISION_1); windows-sys doesn't re-export it.
const SDDL_REVISION_1: u32 = 1;

/// Build a NUL-terminated UTF-16 buffer from a `&str`.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The canonical filesystem path backing an OPEN file handle
/// (`GetFinalPathNameByHandle`, `\\?\C:\...` verbatim form). Used by the AI
/// read-tool TOCTOU guard to re-check the inode we actually opened against the
/// dataset scope, defeating a post-resolve directory swap (audit round 7).
pub fn final_path_for_handle(f: &std::fs::File) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    let handle = f.as_raw_handle() as HANDLE;
    let flags = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS;
    // First call sizes the buffer (returns length INCLUDING the NUL).
    // SAFETY: a null buffer + 0 length is the documented sizing call.
    let needed = unsafe { GetFinalPathNameByHandleW(handle, std::ptr::null_mut(), 0, flags) };
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buf = vec![0u16; needed as usize];
    // SAFETY: `buf` is `needed` wide chars; the API fills it and returns the
    // written length EXCLUDING the NUL (so `written < needed` on success).
    let written = unsafe { GetFinalPathNameByHandleW(handle, buf.as_mut_ptr(), needed, flags) };
    if written == 0 || written >= needed {
        return Err(io::Error::last_os_error());
    }
    buf.truncate(written as usize);
    Ok(PathBuf::from(std::ffi::OsString::from_wide(&buf)))
}

/// Absolute `%SystemRoot%\System32\<name>` path. Falling back to `C:\Windows`
/// is preferable to asking CreateProcess to search cwd/PATH for security tools.
pub fn system32_exe(name: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join(name)
}

/// Absolute Windows PowerShell path used for `.ps1` shims.
pub fn powershell_exe() -> PathBuf {
    system32_exe("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

/// The current process user's SID as an SDDL string (e.g. `S-1-5-21-...`).
/// Mirrors the Unix `getuid()` identity used by the peer-cred check.
fn current_user_sid_string() -> io::Result<String> {
    // Open our own token for query.
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: GetCurrentProcess returns a pseudo-handle (no close needed);
    // OpenProcessToken writes a real handle we CloseHandle below.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    struct TokenGuard(HANDLE);
    impl Drop for TokenGuard {
        fn drop(&mut self) {
            // SAFETY: `self.0` is the handle OpenProcessToken gave us.
            unsafe { CloseHandle(self.0) };
        }
    }
    let _guard = TokenGuard(token);

    // First call sizes the TOKEN_USER buffer; second fills it.
    let mut len: u32 = 0;
    // SAFETY: passing a null buffer + 0 length is the documented sizing call;
    // it fails with ERROR_INSUFFICIENT_BUFFER and sets `len`.
    unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len) };
    if len == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buf = vec![0u8; len as usize];
    // SAFETY: `buf` is `len` bytes; the API fills a TOKEN_USER at its head.
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buf.as_mut_ptr() as *mut c_void,
            len,
            &mut len,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: on success `buf` begins with a valid TOKEN_USER whose `User.Sid`
    // points into `buf`; we only read it while `buf` is alive.
    let token_user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
    sid_to_string(token_user.User.Sid)
}

/// Verify that a named-pipe client handle is owned by the current user before
/// writing the bearer. This closes the post-teardown pipe-name re-squat gap.
pub fn verify_current_user_owner_handle(handle: HANDLE) -> io::Result<()> {
    let mut owner: *mut c_void = std::ptr::null_mut();
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: `handle` is a live pipe/file handle; GetSecurityInfo allocates
    // the returned security descriptor with LocalAlloc and `owner` points into it.
    let rc = unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut sd,
        )
    };
    if rc != 0 {
        return Err(io::Error::from_raw_os_error(rc as i32));
    }
    struct SdGuard(PSECURITY_DESCRIPTOR);
    impl Drop for SdGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: `sd` was LocalAlloc'd by GetSecurityInfo.
                unsafe { LocalFree(self.0 as *mut c_void) };
            }
        }
    }
    let _guard = SdGuard(sd);
    if owner.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "control pipe has no owner SID",
        ));
    }
    // SAFETY: `owner` points into `sd`, alive until `_guard` drops.
    let owner_sid = sid_to_string(owner)?;
    let current = current_user_sid_string()?;
    if owner_sid != current {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "control pipe owner is not the current user",
        ));
    }
    Ok(())
}

fn sid_to_string(sid: *const c_void) -> io::Result<String> {
    let mut sid_str: *mut u16 = std::ptr::null_mut();
    // SAFETY: caller supplied a valid SID pointer; on success the API LocalAllocs
    // a wide string that we free below.
    if unsafe { ConvertSidToStringSidW(sid as *mut c_void, &mut sid_str) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `sid_str` is a valid NUL-terminated wide string.
    let s = unsafe { widestr_to_string(sid_str) };
    // SAFETY: free the LocalAlloc'd string.
    unsafe { LocalFree(sid_str as *mut c_void) };
    Ok(s)
}

/// Read a NUL-terminated UTF-16 string starting at `ptr` into a Rust String.
/// SAFETY: `ptr` must be a valid, NUL-terminated wide string.
unsafe fn widestr_to_string(ptr: *const u16) -> String {
    let mut len = 0usize;
    while *ptr.add(len) != 0 {
        len += 1;
    }
    let slice = std::slice::from_raw_parts(ptr, len);
    String::from_utf16_lossy(slice)
}

/// A self-relative SECURITY_DESCRIPTOR (LocalAlloc'd) whose protected DACL
/// grants full access to ONLY the current user's SID. `LocalFree`d on drop.
struct CurrentUserDescriptor {
    psd: *mut c_void,
}

impl CurrentUserDescriptor {
    fn new() -> io::Result<Self> {
        let sid = current_user_sid_string()?;
        // `O:{sid}` sets the OWNER explicitly to our user SID; `D:P(...)` is a
        // PROTECTED DACL (no parent inheritance) with a single ACE granting
        // GENERIC_ALL to that SID. Everyone else is denied by omission. This is
        // the Windows analogue of the Unix SO_PEERCRED "same-UID only" check +
        // 0o700/0o600 modes. The explicit owner matters for the pipe: without
        // it, an ELEVATED (Administrators) token defaults the object owner to
        // S-1-5-32-544, and `verify_current_user_owner_handle` (which compares
        // against the TokenUser SID) would then reject every connection —
        // breaking the whole Windows write bridge under elevation (audit
        // 2026-07-03 round 5). `restrict_path_to_current_user` applies only the
        // DACL, so the owner clause is inert there.
        //
        // `OICI` (OBJECT_INHERIT + CONTAINER_INHERIT) makes the ACE inheritable
        // (audit 2026-07-03 round 6): when applied to the session DIR, files
        // created inside it inherit the user-only ACE AT CREATION, closing the
        // window where a credential file briefly carried the parent's default
        // ACL before `write_file_0o600`'s post-hoc restrict ran. Inert on the
        // pipe (no child objects) and on leaf credential files.
        let sddl = format!("O:{sid}D:P(A;OICI;GA;;;{sid})");
        let sddl_w = wide(&sddl);
        let mut psd: *mut c_void = std::ptr::null_mut();
        // SAFETY: `sddl_w` is a valid NUL-terminated wide SDDL string; on
        // success the API LocalAllocs a self-relative SD into `psd`.
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl_w.as_ptr(),
                SDDL_REVISION_1,
                &mut psd,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { psd })
    }
}

impl Drop for CurrentUserDescriptor {
    fn drop(&mut self) {
        if !self.psd.is_null() {
            // SAFETY: `psd` was LocalAlloc'd by ConvertStringSecurityDescriptor…W.
            unsafe { LocalFree(self.psd) };
        }
    }
}

/// A SECURITY_ATTRIBUTES pointing at a current-user-only descriptor, for
/// `CreateNamedPipe` (via tokio's `create_with_security_attributes_raw`).
/// Holds the backing descriptor alive; keep this value alive for as long as
/// the raw pointer is in use (i.e. across every pipe-instance creation).
pub struct SecurityAttributes {
    _desc: CurrentUserDescriptor,
    sa: SECURITY_ATTRIBUTES,
}

// SAFETY: the backing descriptor is a heap allocation owned exclusively by this
// struct; there is no shared/aliased state, so moving it to the relay task's
// thread is sound. The raw pointer is only ever read (by CreateNamedPipe).
unsafe impl Send for SecurityAttributes {}

impl SecurityAttributes {
    pub fn current_user_only() -> io::Result<Self> {
        let desc = CurrentUserDescriptor::new()?;
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: desc.psd,
            bInheritHandle: 0,
        };
        Ok(Self { _desc: desc, sa })
    }

    /// Raw pointer to the SECURITY_ATTRIBUTES for
    /// `ServerOptions::create_with_security_attributes_raw`. Valid only while
    /// `self` is alive and not moved.
    pub fn as_ptr(&self) -> *mut c_void {
        &self.sa as *const SECURITY_ATTRIBUTES as *mut c_void
    }
}

/// Apply a protected, current-user-only DACL to `path` (file or directory) —
/// the Windows analogue of `chmod 0o700`/`0o600`. Best-effort: on a
/// single-user desktop under `%LOCALAPPDATA%` (already user-private) this is
/// defense-in-depth, so callers may ignore the error.
pub fn restrict_path_to_current_user(path: &Path) -> io::Result<()> {
    let desc = CurrentUserDescriptor::new()?;
    let mut present: i32 = 0;
    let mut dacl: *mut windows_sys::Win32::Security::ACL = std::ptr::null_mut();
    let mut defaulted: i32 = 0;
    // SAFETY: `desc.psd` is a valid self-relative SD; extract its DACL pointer
    // (which points into the SD, alive for this scope).
    if unsafe { GetSecurityDescriptorDacl(desc.psd, &mut present, &mut dacl, &mut defaulted) } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // A NULL / absent DACL handed to SetNamedSecurityInfoW means "no
    // protection" — it would GRANT EVERYONE, the exact opposite of our intent.
    // Our SDDL always yields a present, non-null DACL, so this only trips on an
    // unexpected failure; refuse rather than apply a permissive descriptor.
    if present == 0 || dacl.is_null() {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "current-user security descriptor produced no DACL",
        ));
    }
    let mut wpath: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `wpath` is a NUL-terminated wide path; `dacl` is valid for the
    // duration of this call (owned by `desc`). PROTECTED strips inherited ACEs.
    let rc = unsafe {
        SetNamedSecurityInfoW(
            wpath.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl,
            std::ptr::null_mut(),
        )
    };
    if rc != 0 {
        return Err(io::Error::from_raw_os_error(rc as i32));
    }
    Ok(())
}

/// The process creation time as a `u64` liveness key (100-ns FILETIME ticks),
/// or `None` if the process is gone / inaccessible. Two live processes reusing
/// a PID differ here, so it disambiguates a stale session record from a live
/// one — the Windows analogue of Linux `/proc/<pid>/stat` field 22.
pub fn process_creation_time(pid: u32) -> Option<u64> {
    // SAFETY: OpenProcess returns null on failure; PROCESS_QUERY_LIMITED_INFORMATION
    // is the least-privilege right that permits GetProcessTimes.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    struct ProcGuard(HANDLE);
    impl Drop for ProcGuard {
        fn drop(&mut self) {
            // SAFETY: `self.0` is the handle OpenProcess returned.
            unsafe { CloseHandle(self.0) };
        }
    }
    let _guard = ProcGuard(handle);

    let mut creation = windows_sys::Win32::Foundation::FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = creation;
    let mut kernel = creation;
    let mut user = creation;
    // SAFETY: all four FILETIME out-params are valid; `handle` is live.
    let ok = unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    if ok == 0 {
        return None;
    }
    Some(((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
}

/// Windows process-tree owner for AI sessions. Closing the job handle with
/// `KILL_ON_JOB_CLOSE` reaps descendants on every exit path, including a normal
/// CLI exit that leaves a helper or `bidsvue --mcp-server` child behind.
pub struct KillOnCloseJob {
    handle: HANDLE,
}

unsafe impl Send for KillOnCloseJob {}

impl KillOnCloseJob {
    pub fn new() -> io::Result<Self> {
        // SAFETY: null security attrs + null name create an unnamed job object.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` is a valid JOBOBJECT_EXTENDED_LIMIT_INFORMATION.
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            let e = io::Error::last_os_error();
            unsafe { CloseHandle(handle) };
            return Err(e);
        }
        Ok(Self { handle })
    }

    pub fn assign_process(&self, process: HANDLE) -> io::Result<()> {
        // SAFETY: both handles are live; AssignProcessToJobObject does not take
        // ownership of either.
        if unsafe { AssignProcessToJobObject(self.handle, process) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn terminate(&self) {
        // SAFETY: best-effort termination of the owned job tree. A vanished job
        // or process tree returns an error we can ignore during teardown.
        unsafe {
            let _ = TerminateJobObject(self.handle, 1);
        }
    }
}

impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            // SAFETY: `handle` is owned by this guard.
            unsafe { CloseHandle(self.handle) };
        }
    }
}
