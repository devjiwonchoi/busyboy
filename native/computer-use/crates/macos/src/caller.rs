//! Verifies the process on the other end of the helper socket before any bytes are read.
//!
//! Portions adapted from Peekaboo (https://github.com/openclaw/Peekaboo, MIT) at 14a4418.
//! Copyright (c) 2025 Peter Steinberger.
//!
//! The chain (SPEC §2.6):
//! 1. read the peer's audit token from the socket;
//! 2. require the peer's euid to equal ours;
//! 3. look up the peer's code object from the audit token;
//! 4. check its dynamic validity against the BusyBoy requirement;
//! 5. check the static (on-disk) validity against the same requirement, and require the
//!    static code-directory hash to equal the kernel's live hash for that process;
//! 6. reject anything else.
//!
//! Unlike Peekaboo, there is no "empty permit list admits everyone" mode: the permit
//! list is a compile-time constant and a const assertion keeps it non-empty.

use std::ffi::{c_int, c_void};
use std::os::fd::RawFd;
use std::ptr::{self, NonNull};

use objc2_core_foundation::{CFData, CFDictionary, CFRetained, CFString, CFType};

/// Team that signs BusyBoy and the helper.
pub const TEAM_ID: &str = "5PA4R2B5FF";

/// Signing identifiers allowed to talk to the helper. Add entries deliberately.
pub const PERMITTED_IDENTIFIERS: &[&str] = &["dev.jiwon.busyboy"];

const _: () = assert!(!PERMITTED_IDENTIFIERS.is_empty(), "the caller permit list must never be empty");

/// Code-directory hash length (`CS_CDHASH_LEN`).
const CDHASH_LEN: usize = 20;
/// `csops` operation that copies the running process's code-directory hash.
const CS_OPS_CDHASH: u32 = 5;
/// `errSecSuccess`.
const ERR_SEC_SUCCESS: i32 = 0;
/// `kSecCSSigningInformation`: include certificate and team data.
const SIGNING_INFORMATION: u32 = 1 << 1;
/// Static check flags: default, which also validates the bundle's sealed resources.
/// BusyBoy is an Electron app whose code lives in `Contents/Resources/app.asar`, which
/// the code-directory hash does not cover, so skipping resources would let a modified
/// bundle through. The desktop connects about once per helper launch, so the cost of a
/// full scan per connection is acceptable.
const STATIC_CHECK_FLAGS: u32 = 0;

/// Kernel audit token (`audit_token_t`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AuditToken {
    pub val: [u32; 8],
}

#[link(name = "bsm")]
unsafe extern "C" {
    fn audit_token_to_pid(token: AuditToken) -> libc::pid_t;
    fn audit_token_to_euid(token: AuditToken) -> libc::uid_t;
}

// libSystem syscall wrapper; reports what the kernel enforces for the live process.
unsafe extern "C" {
    fn csops_audittoken(
        pid: libc::pid_t,
        ops: u32,
        useraddr: *mut c_void,
        usersize: usize,
        token: *mut AuditToken,
    ) -> c_int;
}

#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    static kSecGuestAttributeAudit: &'static CFString;
    static kSecCodeInfoIdentifier: &'static CFString;
    static kSecCodeInfoTeamIdentifier: &'static CFString;
    static kSecCodeInfoUnique: &'static CFString;

    fn SecCodeCopyGuestWithAttributes(
        host: *const c_void,
        attributes: *const c_void,
        flags: u32,
        guest: *mut *const c_void,
    ) -> i32;
    fn SecCodeCheckValidity(code: *const c_void, flags: u32, requirement: *const c_void) -> i32;
    fn SecCodeCopyStaticCode(code: *const c_void, flags: u32, static_code: *mut *const c_void) -> i32;
    fn SecStaticCodeCheckValidity(static_code: *const c_void, flags: u32, requirement: *const c_void) -> i32;
    fn SecRequirementCreateWithString(text: *const c_void, flags: u32, requirement: *mut *const c_void) -> i32;
    fn SecCodeCopySigningInformation(code: *const c_void, flags: u32, information: *mut *const c_void) -> i32;
}

/// A verified peer, for logging.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub pid: i32,
    pub identifier: Option<String>,
    pub team: Option<String>,
}

/// Why a peer was rejected. Only for logs; the peer gets no bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RejectReason {
    TokenUnavailable(i32),
    TokenSize(usize),
    WrongUser { peer_euid: u32 },
    GuestLookup(i32),
    Requirement(i32),
    DynamicInvalid(i32),
    StaticLookup(i32),
    StaticInvalid(i32),
    HashUnavailable,
    HashMismatch,
    NotLauncher,
}

impl std::fmt::Display for RejectReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RejectReason::TokenUnavailable(errno) => write!(f, "audit token unavailable (errno {errno})"),
            RejectReason::TokenSize(size) => write!(f, "audit token has wrong size {size}"),
            RejectReason::WrongUser { peer_euid } => write!(f, "peer euid {peer_euid} differs from ours"),
            RejectReason::GuestLookup(status) => write!(f, "code lookup failed ({status})"),
            RejectReason::Requirement(status) => write!(f, "requirement could not be built ({status})"),
            RejectReason::DynamicInvalid(status) => write!(f, "live code fails the requirement ({status})"),
            RejectReason::StaticLookup(status) => write!(f, "static code lookup failed ({status})"),
            RejectReason::StaticInvalid(status) => write!(f, "on-disk code fails the requirement ({status})"),
            RejectReason::HashUnavailable => f.write_str("code-directory hash unavailable"),
            RejectReason::HashMismatch => f.write_str("on-disk code-directory hash differs from the live one"),
            RejectReason::NotLauncher => f.write_str("peer is not the recorded launcher"),
        }
    }
}

/// A rejected peer with whatever identity we could read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    pub pid: Option<i32>,
    pub identifier: Option<String>,
    pub team: Option<String>,
    pub reason: RejectReason,
}

impl std::fmt::Display for Rejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let pid = self.pid.map_or("?".to_owned(), |pid| pid.to_string());
        let identifier = self.identifier.as_deref().unwrap_or("-");
        let team = self.team.as_deref().unwrap_or("-");
        write!(f, "pid={pid} identifier={identifier} team={team}: {}", self.reason)
    }
}

/// The code-signing requirement every caller must satisfy.
pub fn requirement_text() -> String {
    let identifiers: Vec<String> = PERMITTED_IDENTIFIERS.iter().map(|id| format!("identifier \"{id}\"")).collect();
    let identifiers =
        if identifiers.len() == 1 { identifiers[0].clone() } else { format!("({})", identifiers.join(" or ")) };
    format!("anchor apple generic and certificate leaf[subject.OU] = \"{TEAM_ID}\" and {identifiers}")
}

/// Reads the peer's audit token. Never reads socket data.
pub fn peer_token(fd: RawFd) -> Result<AuditToken, RejectReason> {
    let mut token = AuditToken::default();
    let mut size = size_of::<AuditToken>() as libc::socklen_t;
    // SAFETY: `token` is a writable 32-byte buffer and `size` holds its length.
    let result = unsafe {
        libc::getsockopt(fd, libc::SOL_LOCAL, libc::LOCAL_PEERTOKEN, (&raw mut token).cast(), &mut size)
    };
    if result != 0 {
        return Err(RejectReason::TokenUnavailable(std::io::Error::last_os_error().raw_os_error().unwrap_or(0)));
    }
    if size as usize != size_of::<AuditToken>() {
        return Err(RejectReason::TokenSize(size as usize));
    }
    Ok(token)
}

pub fn token_pid(token: AuditToken) -> i32 {
    // SAFETY: pure accessor on a plain struct.
    unsafe { audit_token_to_pid(token) }
}

pub fn token_euid(token: AuditToken) -> u32 {
    // SAFETY: pure accessor on a plain struct.
    unsafe { audit_token_to_euid(token) }
}

/// Process start time in microseconds since the epoch, or `None` if the pid is gone.
pub fn process_start_time(pid: i32) -> Option<u64> {
    // SAFETY: zeroed is a valid bit pattern for this plain C struct.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = size_of::<libc::proc_bsdinfo>() as c_int;
    // SAFETY: `info` is a writable buffer of `size` bytes.
    let written = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size) };
    if written != size {
        return None;
    }
    Some(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
}

/// Owned CF object returned by a Security "Copy"/"Create" call.
fn adopt(raw: *const c_void) -> Option<CFRetained<CFType>> {
    // SAFETY: Security returns +1 references from Copy/Create calls; we adopt that reference.
    NonNull::new(raw.cast_mut().cast::<CFType>()).map(|ptr| unsafe { CFRetained::from_raw(ptr) })
}

fn raw(object: &CFRetained<CFType>) -> *const c_void {
    CFRetained::as_ptr(object).as_ptr().cast_const().cast()
}

/// Identifier, team, and code-directory hash from a code's signing information.
struct SigningInfo {
    identifier: Option<String>,
    team: Option<String>,
    cdhash: Option<Vec<u8>>,
}

fn signing_info(code: &CFRetained<CFType>) -> Option<SigningInfo> {
    let mut out: *const c_void = ptr::null();
    // SAFETY: `code` is a live SecCode/SecStaticCode; `out` receives a +1 dictionary.
    let status = unsafe { SecCodeCopySigningInformation(raw(code), SIGNING_INFORMATION, &mut out) };
    let info = adopt(out)?;
    if status != ERR_SEC_SUCCESS {
        return None;
    }
    let dict = info.downcast_ref::<CFDictionary>()?;
    let lookup = |key: &CFString| -> Option<&CFType> {
        // SAFETY: `dict` is a CFDictionary with CFString keys; the value is borrowed from it.
        let value = unsafe { dict.value((key as *const CFString).cast()) };
        // SAFETY: a non-null dictionary value is a CF object kept alive by `dict`.
        (!value.is_null()).then(|| unsafe { &*value.cast::<CFType>() })
    };
    // SAFETY: the key statics are immutable CFStrings exported by Security.
    let (id_key, team_key, unique_key) =
        unsafe { (kSecCodeInfoIdentifier, kSecCodeInfoTeamIdentifier, kSecCodeInfoUnique) };
    let text = |key| lookup(key).and_then(|value| value.downcast_ref::<CFString>()).map(|value| value.to_string());
    Some(SigningInfo {
        identifier: text(id_key),
        team: text(team_key),
        cdhash: lookup(unique_key).and_then(|value| value.downcast_ref::<CFData>()).map(|data| data.to_vec()),
    })
}

/// The kernel's code-directory hash for the process behind `token`.
fn live_cdhash(mut token: AuditToken) -> Option<[u8; CDHASH_LEN]> {
    let mut hash = [0u8; CDHASH_LEN];
    // SAFETY: `hash` is a writable buffer of CDHASH_LEN bytes and `token` is a valid token.
    let result = unsafe {
        csops_audittoken(token_pid(token), CS_OPS_CDHASH, hash.as_mut_ptr().cast(), hash.len(), &mut token)
    };
    (result == 0 && hash.iter().any(|byte| *byte != 0)).then_some(hash)
}

fn requirement() -> Result<CFRetained<CFType>, RejectReason> {
    let text = CFString::from_str(&requirement_text());
    let mut out: *const c_void = ptr::null();
    // SAFETY: `text` is a live CFString; `out` receives a +1 SecRequirement.
    let status = unsafe { SecRequirementCreateWithString(CFRetained::as_ptr(&text).as_ptr().cast(), 0, &mut out) };
    let requirement = adopt(out);
    match requirement {
        Some(requirement) if status == ERR_SEC_SUCCESS => Ok(requirement),
        _ => Err(RejectReason::Requirement(status)),
    }
}

/// Runs the full verification chain on an accepted connection.
pub fn verify_peer(fd: RawFd) -> Result<Caller, Rejection> {
    let reject = |pid, info: Option<&SigningInfo>, reason| Rejection {
        pid,
        identifier: info.and_then(|info| info.identifier.clone()),
        team: info.and_then(|info| info.team.clone()),
        reason,
    };

    let token = peer_token(fd).map_err(|reason| reject(None, None, reason))?;
    let pid = token_pid(token);
    // SAFETY: geteuid has no preconditions.
    let euid = unsafe { libc::geteuid() };
    if token_euid(token) != euid {
        return Err(reject(Some(pid), None, RejectReason::WrongUser { peer_euid: token_euid(token) }));
    }

    let token_data = CFData::from_bytes(
        // SAFETY: AuditToken is plain old data with no padding.
        unsafe { std::slice::from_raw_parts((&raw const token).cast::<u8>(), size_of::<AuditToken>()) },
    );
    // SAFETY: the key is an immutable CFString exported by Security.
    let audit_key = unsafe { kSecGuestAttributeAudit };
    let attributes = CFDictionary::<CFString, CFData>::from_slices(&[audit_key], &[&*token_data]);
    let mut out: *const c_void = ptr::null();
    // SAFETY: `attributes` is a live CFDictionary; `out` receives a +1 SecCode.
    let status = unsafe {
        SecCodeCopyGuestWithAttributes(ptr::null(), CFRetained::as_ptr(&attributes).as_ptr().cast(), 0, &mut out)
    };
    let Some(code) = adopt(out).filter(|_| status == ERR_SEC_SUCCESS) else {
        return Err(reject(Some(pid), None, RejectReason::GuestLookup(status)));
    };

    let mut out: *const c_void = ptr::null();
    // SAFETY: `code` is a live SecCode; `out` receives a +1 SecStaticCode.
    let status = unsafe { SecCodeCopyStaticCode(raw(&code), 0, &mut out) };
    let Some(static_code) = adopt(out).filter(|_| status == ERR_SEC_SUCCESS) else {
        return Err(reject(Some(pid), None, RejectReason::StaticLookup(status)));
    };
    // Unvalidated, only for logs until the checks below pass.
    let info = signing_info(&static_code);
    let info = info.as_ref();

    let requirement = requirement().map_err(|reason| reject(Some(pid), info, reason))?;

    let live_before = live_cdhash(token);

    // SAFETY: `code` and `requirement` are live Security objects.
    let status = unsafe { SecCodeCheckValidity(raw(&code), 0, raw(&requirement)) };
    if status != ERR_SEC_SUCCESS {
        return Err(reject(Some(pid), info, RejectReason::DynamicInvalid(status)));
    }

    // SAFETY: `static_code` and `requirement` are live Security objects.
    let status = unsafe { SecStaticCodeCheckValidity(raw(&static_code), STATIC_CHECK_FLAGS, raw(&requirement)) };
    if status != ERR_SEC_SUCCESS {
        return Err(reject(Some(pid), info, RejectReason::StaticInvalid(status)));
    }

    // Re-read after validation so the hashes describe the code that was just checked.
    let validated = signing_info(&static_code);
    let static_hash = validated.as_ref().and_then(|info| info.cdhash.clone());
    let live_after = live_cdhash(token);
    let (Some(static_hash), Some(live_before), Some(live_after)) = (static_hash, live_before, live_after) else {
        return Err(reject(Some(pid), info, RejectReason::HashUnavailable));
    };
    if static_hash.as_slice() != live_before.as_slice() || live_before != live_after {
        return Err(reject(Some(pid), info, RejectReason::HashMismatch));
    }

    let validated = validated.as_ref();
    Ok(Caller {
        pid,
        identifier: validated.and_then(|info| info.identifier.clone()),
        team: validated.and_then(|info| info.team.clone()),
    })
}

/// The process that launched the helper, recorded by the first stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LauncherIdentity {
    pub pid: i32,
    pub start_time: u64,
}

impl LauncherIdentity {
    /// `<pid>:<start_time>`, the value passed between stages.
    pub fn encode(self) -> String {
        format!("{}:{}", self.pid, self.start_time)
    }

    pub fn decode(value: &str) -> Option<Self> {
        let (pid, start_time) = value.split_once(':')?;
        let pid: i32 = pid.parse().ok()?;
        if pid <= 0 {
            return None;
        }
        Some(LauncherIdentity { pid, start_time: start_time.parse().ok()? })
    }

    /// The parent of this process, if its start time can be read.
    pub fn of_parent() -> Option<Self> {
        // SAFETY: getppid has no preconditions.
        let pid = unsafe { libc::getppid() };
        if pid <= 1 {
            return None;
        }
        Some(LauncherIdentity { pid, start_time: process_start_time(pid)? })
    }
}

/// Dev builds only: accepts exactly the recorded launcher, matched by pid and start time.
#[cfg(feature = "dev-callers")]
pub fn verify_launcher(fd: RawFd, launcher: LauncherIdentity) -> Result<Caller, Rejection> {
    let token = peer_token(fd).map_err(|reason| Rejection { pid: None, identifier: None, team: None, reason })?;
    let pid = token_pid(token);
    let reject = |reason| Rejection { pid: Some(pid), identifier: None, team: None, reason };
    // SAFETY: geteuid has no preconditions.
    if token_euid(token) != unsafe { libc::geteuid() } {
        return Err(reject(RejectReason::WrongUser { peer_euid: token_euid(token) }));
    }
    if pid != launcher.pid || process_start_time(pid) != Some(launcher.start_time) {
        return Err(reject(RejectReason::NotLauncher));
    }
    Ok(Caller { pid, identifier: None, team: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;

    #[test]
    fn requirement_pins_team_and_every_identifier() {
        assert_eq!(
            requirement_text(),
            r#"anchor apple generic and certificate leaf[subject.OU] = "5PA4R2B5FF" and identifier "dev.jiwon.busyboy""#
        );
        for id in PERMITTED_IDENTIFIERS {
            assert!(!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c)));
        }
        assert!(requirement().is_ok(), "requirement text must compile");
    }

    #[test]
    fn reads_peer_token_of_a_socket_pair() {
        let (a, _b) = UnixStream::pair().unwrap();
        let token = peer_token(a.as_raw_fd()).unwrap();
        assert_eq!(token_pid(token), std::process::id() as i32);
        // SAFETY: geteuid has no preconditions.
        assert_eq!(token_euid(token), unsafe { libc::geteuid() });
    }

    #[test]
    fn rejects_an_ad_hoc_signed_peer() {
        // The test binary itself is only linker (ad-hoc) signed.
        let (a, _b) = UnixStream::pair().unwrap();
        let rejection = verify_peer(a.as_raw_fd()).unwrap_err();
        assert_eq!(rejection.pid, Some(std::process::id() as i32));
        assert!(matches!(rejection.reason, RejectReason::DynamicInvalid(_)), "{rejection}");
    }

    #[test]
    fn launcher_identity_round_trips() {
        let launcher = LauncherIdentity { pid: 42, start_time: 1_700_000_000_123_456 };
        assert_eq!(LauncherIdentity::decode(&launcher.encode()), Some(launcher));
        assert_eq!(LauncherIdentity::decode("0:1"), None);
        assert_eq!(LauncherIdentity::decode("x"), None);
        assert!(process_start_time(std::process::id() as i32).is_some());
    }
}
