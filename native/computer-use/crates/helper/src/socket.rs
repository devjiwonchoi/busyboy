//! Socket directory checks, the single-instance probe, and binding (SPEC §2.5).

use std::ffi::CString;
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::exit;

/// `umask` is process-wide. Anything in this process that creates files while a bind is
/// in progress must hold this lock (in the helper, binding happens before other threads).
pub static UMASK_LOCK: Mutex<()> = Mutex::new(());

pub const SOCKET_NAME: &str = "helper.sock";

/// `sun_path` is 104 bytes including the trailing NUL.
pub const MAX_SOCKET_PATH: usize = 103;

#[derive(Debug)]
pub enum SocketError {
    /// The directory exists with another owner, a group/other mode, or is not a directory.
    UnsafeDir(String),
    /// Anything else that stops us from listening.
    Setup(String),
    /// A live helper already answers on the socket.
    AlreadyRunning,
}

impl SocketError {
    pub fn exit_code(&self) -> i32 {
        match self {
            SocketError::UnsafeDir(_) => exit::UNSAFE_SOCKET_DIR,
            SocketError::Setup(_) => exit::SOCKET_SETUP,
            SocketError::AlreadyRunning => exit::ALREADY_RUNNING,
        }
    }
}

impl std::fmt::Display for SocketError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SocketError::UnsafeDir(why) => write!(f, "unsafe_socket_dir: {why}"),
            SocketError::Setup(why) => write!(f, "socket setup failed: {why}"),
            SocketError::AlreadyRunning => f.write_str("another helper is already serving the socket"),
        }
    }
}

fn setup(context: &str, error: io::Error) -> SocketError {
    SocketError::Setup(format!("{context}: {error}"))
}

pub fn euid() -> u32 {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() }
}

/// `~/Library/Application Support/BusyBoy/ComputerUse/run`.
pub fn default_dir(home: &Path) -> PathBuf {
    home.join("Library/Application Support/BusyBoy/ComputerUse/run")
}

/// Picks the socket path: `primary/helper.sock`, or `<tmpdir>/busyboy-cu-<euid>/helper.sock`
/// when the primary path does not fit in `sun_path`.
pub fn choose_path(primary: &Path, tmpdir: Option<&Path>, euid: u32) -> Result<PathBuf, SocketError> {
    let candidate = primary.join(SOCKET_NAME);
    if candidate.as_os_str().len() <= MAX_SOCKET_PATH {
        return Ok(candidate);
    }
    let fallback = tmpdir
        .map(|tmpdir| tmpdir.join(format!("busyboy-cu-{euid}")).join(SOCKET_NAME))
        .filter(|path| path.as_os_str().len() <= MAX_SOCKET_PATH);
    fallback.ok_or_else(|| SocketError::Setup(format!("socket path too long: {}", candidate.display())))
}

/// Resolves the socket path from the environment.
pub fn resolve_path() -> Result<PathBuf, SocketError> {
    let primary = match std::env::var_os(crate::SOCKET_DIR_ENV) {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => {
            let home = std::env::var_os("HOME").filter(|home| !home.is_empty());
            let home = home.ok_or_else(|| SocketError::Setup("HOME is not set".to_owned()))?;
            default_dir(Path::new(&home))
        }
    };
    let tmpdir = std::env::var_os("TMPDIR").filter(|dir| !dir.is_empty()).map(PathBuf::from);
    choose_path(&primary, tmpdir.as_deref(), euid())
}

/// Checks owner, mode, and type of an existing socket directory.
pub fn check_dir(metadata: &fs::Metadata, euid: u32) -> Result<(), SocketError> {
    if !metadata.file_type().is_dir() {
        return Err(SocketError::UnsafeDir("not a directory".to_owned()));
    }
    if metadata.uid() != euid {
        return Err(SocketError::UnsafeDir(format!("owned by uid {}, not {euid}", metadata.uid())));
    }
    if metadata.mode() & 0o077 != 0 {
        return Err(SocketError::UnsafeDir(format!("mode {:o} allows group/other access", metadata.mode() & 0o777)));
    }
    Ok(())
}

/// Creates the socket directory 0700 (parents with default modes) and checks it.
pub fn prepare_dir(dir: &Path) -> Result<(), SocketError> {
    let _guard = UMASK_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent).map_err(|error| setup("create parent dir", error))?;
    }
    match fs::symlink_metadata(dir) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let path = CString::new(dir.as_os_str().as_bytes()).map_err(|_| SocketError::Setup("NUL in path".into()))?;
            // SAFETY: `path` is a valid NUL-terminated C string.
            if unsafe { libc::mkdir(path.as_ptr(), 0o700) } != 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::AlreadyExists {
                    return Err(setup("create socket dir", error));
                }
            }
        }
        Err(error) => return Err(setup("stat socket dir", error)),
    }
    let metadata = fs::symlink_metadata(dir).map_err(|error| setup("stat socket dir", error))?;
    check_dir(&metadata, euid())
}

/// True if something accepts connections on `path`.
pub fn probe(path: &Path) -> bool {
    UnixStream::connect(path).is_ok()
}

/// A bound listener plus what we need to clean up only our own socket file.
pub struct BoundSocket {
    pub listener: UnixListener,
    pub path: PathBuf,
    inode: u64,
}

impl BoundSocket {
    /// Removes the socket file if it is still the one we bound.
    pub fn remove_file(&self) {
        remove_if_inode(&self.path, self.inode);
    }

    pub fn inode(&self) -> u64 {
        self.inode
    }
}

pub fn remove_if_inode(path: &Path, inode: u64) {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.ino() == inode) {
        let _ = fs::remove_file(path);
    }
}

/// Prepares the directory, handles an existing socket, and binds `path` with mode 0600.
pub fn bind(path: &Path) -> Result<BoundSocket, SocketError> {
    let dir = path.parent().ok_or_else(|| SocketError::Setup("socket path has no parent".to_owned()))?;
    prepare_dir(dir)?;

    if fs::symlink_metadata(path).is_ok() {
        if probe(path) {
            return Err(SocketError::AlreadyRunning);
        }
        // Inside our own 0700 directory, so whatever is here is a stale leftover of ours.
        fs::remove_file(path).map_err(|error| setup("remove stale socket", error))?;
    }

    let bound = {
        let _guard = UMASK_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // SAFETY: umask only swaps the process file-mode mask; restored right after bind.
        let previous = unsafe { libc::umask(0o177) };
        let bound = UnixListener::bind(path);
        // SAFETY: as above.
        unsafe { libc::umask(previous) };
        bound
    };
    let listener = match bound {
        Ok(listener) => listener,
        // Lost a race with another instance starting at the same time.
        Err(error) if error.kind() == io::ErrorKind::AddrInUse && probe(path) => {
            return Err(SocketError::AlreadyRunning);
        }
        Err(error) => return Err(setup("bind socket", error)),
    };

    let metadata = fs::symlink_metadata(path).map_err(|error| setup("stat socket", error))?;
    let socket = BoundSocket { listener, path: path.to_owned(), inode: metadata.ino() };
    if let Err(error) = fs::set_permissions(path, fs::Permissions::from_mode(0o600)) {
        socket.remove_file();
        return Err(setup("chmod socket", error));
    }
    if !metadata.file_type().is_socket() {
        return Err(SocketError::Setup("bound path is not a socket".to_owned()));
    }
    Ok(socket)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    pub(crate) fn temp_dir() -> PathBuf {
        let _guard = UMASK_LOCK.lock().unwrap();
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let base = std::env::temp_dir().join(format!("bbcu-sock-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn creates_dir_0700_and_socket_0600() {
        let base = temp_dir();
        let path = base.join("run").join(SOCKET_NAME);
        let socket = bind(&path).unwrap();
        assert_eq!(fs::metadata(base.join("run")).unwrap().mode() & 0o777, 0o700);
        assert_eq!(fs::symlink_metadata(&path).unwrap().mode() & 0o777, 0o600);
        socket.remove_file();
        assert!(!path.exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn rejects_dir_with_group_or_other_bits() {
        let base = temp_dir();
        let dir = base.join("run");
        {
            let _guard = UMASK_LOCK.lock().unwrap();
            fs::create_dir(&dir).unwrap();
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o750)).unwrap();
        }
        let error = bind(&dir.join(SOCKET_NAME)).err().unwrap();
        assert!(matches!(error, SocketError::UnsafeDir(_)), "{error}");
        assert_eq!(error.exit_code(), exit::UNSAFE_SOCKET_DIR);
        assert!(error.to_string().starts_with("unsafe_socket_dir"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn rejects_dir_owned_by_someone_else_or_a_symlink() {
        let base = temp_dir();
        let metadata = fs::metadata(&base).unwrap();
        assert!(matches!(check_dir(&metadata, metadata.uid() + 1), Err(SocketError::UnsafeDir(_))));

        let link = base.join("link");
        {
            let _guard = UMASK_LOCK.lock().unwrap();
            std::os::unix::fs::symlink(&base, &link).unwrap();
        }
        let error = prepare_dir(&link).err().unwrap();
        assert!(matches!(error, SocketError::UnsafeDir(_)), "{error}");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn falls_back_to_tmpdir_when_the_path_is_too_long() {
        let short = Path::new("/Users/me/run");
        assert_eq!(choose_path(short, None, 501).unwrap(), short.join(SOCKET_NAME));

        let long = PathBuf::from(format!("/Users/{}/run", "x".repeat(100)));
        let tmp = Path::new("/var/folders/ab/T");
        assert_eq!(choose_path(&long, Some(tmp), 501).unwrap(), tmp.join("busyboy-cu-501").join(SOCKET_NAME));
        assert!(matches!(choose_path(&long, None, 501), Err(SocketError::Setup(_))));
        let long_tmp = PathBuf::from(format!("/{}", "t".repeat(100)));
        assert!(matches!(choose_path(&long, Some(&long_tmp), 501), Err(SocketError::Setup(_))));
    }

    #[test]
    fn replaces_a_stale_socket_but_not_a_live_one() {
        let base = temp_dir();
        let path = base.join("run").join(SOCKET_NAME);

        let live = bind(&path).unwrap();
        assert!(matches!(bind(&path), Err(SocketError::AlreadyRunning)));

        // Dropping the listener leaves the file behind with nobody accepting.
        drop(live);
        assert!(path.exists());
        assert!(!probe(&path));
        let fresh = bind(&path).unwrap();
        assert!(probe(&path));
        fresh.remove_file();
        fs::remove_dir_all(base).unwrap();
    }
}
