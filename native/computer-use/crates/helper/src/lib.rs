//! The BusyBoy Computer Use helper: two-stage launch, the caller-verified socket
//! server, and the glue between the socket and the [`cu_core::Engine`].
//!
//! # Contract for the desktop supervisor
//!
//! Launch `BusyBoy Computer Use.app/Contents/MacOS/busyboy-computer-use` with no
//! arguments and keep the child handle. The process you spawn is the first stage; it
//! re-spawns itself responsibility-disclaimed, forwards SIGTERM/SIGINT to the second
//! stage, and exits with its exit code. Send SIGTERM to stop it.
//!
//! Environment (all optional, never set the internal ones):
//! - [`SOCKET_DIR_ENV`]: socket directory override (tests and dev).
//! - [`STAGE_ENV`], [`LAUNCHER_ENV`], [`STAGE1_ENV`]: internal, set by the first stage.
//!
//! Socket: `~/Library/Application Support/BusyBoy/ComputerUse/run/helper.sock`, or
//! `$TMPDIR/busyboy-cu-<euid>/helper.sock` if that path is longer than `sun_path`
//! allows. The directory is 0700 and owned by the user; the socket is 0600.
//!
//! Exit codes are in [`exit`].
#![cfg(target_os = "macos")]

pub mod server;
pub mod socket;
pub mod stage;

/// Socket directory override.
pub const SOCKET_DIR_ENV: &str = "BUSYBOY_CU_SOCKET_DIR";
/// Set to `2` in the second (disclaimed) stage.
pub const STAGE_ENV: &str = "BUSYBOY_CU_STAGE";
/// `<pid>:<start_time_us>` of the process that launched the first stage.
pub const LAUNCHER_ENV: &str = "BUSYBOY_CU_LAUNCHER";
/// Pid of the first stage, so the second stage exits if the first one dies.
pub const STAGE1_ENV: &str = "BUSYBOY_CU_STAGE1";

/// Process exit codes the desktop supervisor can act on.
///
/// | Code | Name | Meaning |
/// |---|---|---|
/// | 0 | `OK` | Normal exit, including after SIGTERM/SIGINT |
/// | 64 | `UNSAFE_SOCKET_DIR` | Socket dir has another owner or group/other bits: report `computer_use_unavailable` (`unsafe_socket_dir`) |
/// | 65 | `SOCKET_SETUP` | Socket dir or socket could not be created/bound |
/// | 66 | `ALREADY_RUNNING` | Another helper is live on the socket: connect to it, do not restart |
/// | 67 | `SPAWN_FAILED` | The first stage could not start the second stage |
/// | 128+n | — | The second stage died from signal n |
pub mod exit {
    pub const OK: i32 = 0;
    pub const UNSAFE_SOCKET_DIR: i32 = 64;
    pub const SOCKET_SETUP: i32 = 65;
    pub const ALREADY_RUNNING: i32 = 66;
    pub const SPAWN_FAILED: i32 = 67;
}

/// Version reported in `hello`.
pub const HELPER_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn log(message: impl std::fmt::Display) {
    eprintln!("busyboy-computer-use[{}]: {message}", std::process::id());
}

/// Present in the binary only when `dev-callers` is compiled in. The release build script
/// refuses any helper binary that contains these bytes.
#[cfg(feature = "dev-callers")]
#[used]
pub static DEV_CALLERS_MARKER: [u8; 30] = *b"BUSYBOY_CU_DEV_CALLERS_ENABLED";
