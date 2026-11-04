//! Two-stage launch with responsibility disclaim (SPEC §2.4), plus the signal and
//! parent-exit plumbing both stages need.
//!
//! Portions adapted from cua (https://github.com/trycua/cua, MIT) at d685580.
//! Copyright (c) 2025 Cua AI, Inc.
//!
//! Stage 1 (no [`STAGE_ENV`]) re-spawns its own executable with the disclaim spawn
//! attribute so macOS treats the helper as its own responsible process, then waits:
//! it forwards SIGTERM/SIGINT and exits with the child's code. If the private symbol is
//! missing it launches the bundle through LaunchServices (`open -n -g -W`) instead,
//! which also makes the helper its own responsible process. Stage 1 never touches
//! Accessibility or any other privacy-gated API.

use std::ffi::{CString, OsString, c_int};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::ptr;
use std::thread;

use cu_macos::caller::LauncherIdentity;

use crate::{LAUNCHER_ENV, STAGE_ENV, STAGE1_ENV, exit, log};

type SetDisclaim = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, c_int) -> c_int;

const TERMINATION_SIGNALS: [c_int; 2] = [libc::SIGTERM, libc::SIGINT];

pub fn is_second_stage() -> bool {
    std::env::var_os(STAGE_ENV).is_some_and(|value| value == "2")
}

/// What `main` should do after stage 1 logic.
pub enum FirstStage {
    /// Stage 2 ran and exited with this code.
    Exit(i32),
    /// Neither disclaim nor LaunchServices is possible (a bare dev binary): serve in-process.
    RunInProcess,
}

/// The environment for stage 2: ours without stale internal keys, plus the markers.
pub fn child_env(
    vars: impl Iterator<Item = (OsString, OsString)>,
    launcher: Option<LauncherIdentity>,
    stage1_pid: u32,
) -> Vec<(OsString, OsString)> {
    let internal = [STAGE_ENV, LAUNCHER_ENV, STAGE1_ENV];
    let mut env: Vec<(OsString, OsString)> =
        vars.filter(|(key, _)| !internal.iter().any(|name| key == name)).collect();
    env.push((STAGE_ENV.into(), "2".into()));
    env.push((STAGE1_ENV.into(), stage1_pid.to_string().into()));
    if let Some(launcher) = launcher {
        env.push((LAUNCHER_ENV.into(), launcher.encode().into()));
    }
    env
}

/// The `.app` that contains `exe`, if any.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    exe.ancestors().find(|path| path.extension().is_some_and(|ext| ext == "app")).map(Path::to_owned)
}

/// Blocks SIGTERM/SIGINT on the calling thread (and threads it starts) so a dedicated
/// thread can `sigwait` for them. Call before starting any other thread.
pub fn block_termination_signals() -> libc::sigset_t {
    // SAFETY: sigset operations on a local set; pthread_sigmask only changes this thread's mask.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for signal in TERMINATION_SIGNALS {
            libc::sigaddset(&mut set, signal);
        }
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, ptr::null_mut());
        set
    }
}

/// Calls `on_signal` from a background thread for every blocked termination signal.
pub fn spawn_signal_thread(set: libc::sigset_t, on_signal: impl Fn(c_int) + Send + 'static) {
    thread::Builder::new()
        .name("cu-signals".to_owned())
        .spawn(move || {
            loop {
                let mut signal: c_int = 0;
                // SAFETY: `set` is a valid signal set and `signal` is writable.
                if unsafe { libc::sigwait(&set, &mut signal) } == 0 {
                    on_signal(signal);
                }
            }
        })
        .expect("spawn signal thread");
}

/// Calls `on_exit` once when process `pid` exits (or right away if it is already gone).
pub fn watch_process_exit(pid: i32, on_exit: impl FnOnce() + Send + 'static) {
    thread::Builder::new()
        .name("cu-stage1-watch".to_owned())
        .spawn(move || {
            // SAFETY: kqueue has no preconditions.
            let queue = unsafe { libc::kqueue() };
            if queue < 0 {
                log("cannot watch the first stage: kqueue failed");
                return;
            }
            let change = libc::kevent {
                ident: pid as usize,
                filter: libc::EVFILT_PROC,
                flags: libc::EV_ADD | libc::EV_ONESHOT,
                fflags: libc::NOTE_EXIT,
                data: 0,
                udata: ptr::null_mut(),
            };
            // SAFETY: zeroed is a valid kevent value to be overwritten by the kernel.
            let mut event: libc::kevent = unsafe { std::mem::zeroed() };
            loop {
                // SAFETY: one change in, room for one event out.
                let count = unsafe { libc::kevent(queue, &change, 1, &mut event, 1, ptr::null()) };
                if count < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                // `count < 0` with ESRCH means the process is already gone.
                break;
            }
            // SAFETY: `queue` is our open descriptor.
            unsafe { libc::close(queue) };
            on_exit();
        })
        .expect("spawn stage-1 watcher");
}

fn disclaim_symbol() -> Option<SetDisclaim> {
    // SAFETY: dlsym with RTLD_DEFAULT and a NUL-terminated name only looks the symbol up.
    let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_spawnattrs_setdisclaim".as_ptr()) };
    // SAFETY: the symbol, when present, has this C signature.
    (!symbol.is_null()).then(|| unsafe { std::mem::transmute::<*mut libc::c_void, SetDisclaim>(symbol) })
}

fn cstring(bytes: Vec<u8>) -> Option<CString> {
    CString::new(bytes).ok()
}

/// posix_spawn of our own executable with the disclaim attribute. Returns the child pid.
fn spawn_disclaimed(exe: &Path, env: &[(OsString, OsString)], set_disclaim: SetDisclaim) -> Result<i32, String> {
    let path = cstring(exe.as_os_str().as_bytes().to_vec()).ok_or("NUL in executable path")?;
    let argv: Vec<CString> =
        std::env::args_os().map(|arg| cstring(arg.into_vec())).collect::<Option<_>>().ok_or("NUL in argv")?;
    let envp: Vec<CString> = env
        .iter()
        .map(|(key, value)| {
            let mut entry = key.clone().into_vec();
            entry.push(b'=');
            entry.extend_from_slice(value.as_bytes());
            cstring(entry)
        })
        .collect::<Option<_>>()
        .ok_or("NUL in environment")?;
    let mut argv_ptrs: Vec<*mut libc::c_char> = argv.iter().map(|arg| arg.as_ptr().cast_mut()).collect();
    argv_ptrs.push(ptr::null_mut());
    let mut envp_ptrs: Vec<*mut libc::c_char> = envp.iter().map(|entry| entry.as_ptr().cast_mut()).collect();
    envp_ptrs.push(ptr::null_mut());

    // SAFETY: the attribute object is initialized before use and destroyed on every path;
    // argv/envp are NUL-terminated arrays of C strings that outlive the call.
    unsafe {
        let mut attr: libc::posix_spawnattr_t = std::mem::zeroed();
        let status = libc::posix_spawnattr_init(&mut attr);
        if status != 0 {
            return Err(format!("posix_spawnattr_init failed: {status}"));
        }
        // The child starts with an empty mask and default dispositions for the signals we block.
        let mut empty: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut empty);
        let mut defaults: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut defaults);
        for signal in TERMINATION_SIGNALS {
            libc::sigaddset(&mut defaults, signal);
        }
        libc::posix_spawnattr_setsigmask(&mut attr, &empty);
        libc::posix_spawnattr_setsigdefault(&mut attr, &defaults);
        libc::posix_spawnattr_setflags(&mut attr, (libc::POSIX_SPAWN_SETSIGMASK | libc::POSIX_SPAWN_SETSIGDEF) as _);

        let status = set_disclaim(&mut attr, 1);
        if status != 0 {
            libc::posix_spawnattr_destroy(&mut attr);
            return Err(format!("responsibility_spawnattrs_setdisclaim failed: {status}"));
        }
        let mut pid: libc::pid_t = 0;
        let status =
            libc::posix_spawn(&mut pid, path.as_ptr(), ptr::null(), &attr, argv_ptrs.as_ptr(), envp_ptrs.as_ptr());
        libc::posix_spawnattr_destroy(&mut attr);
        if status != 0 {
            return Err(format!("posix_spawn failed: {}", std::io::Error::from_raw_os_error(status)));
        }
        Ok(pid)
    }
}

/// LaunchServices fallback: `open -n -g -W -a <bundle> --env K=V ...`. We wait on `open`,
/// which returns when the helper quits; stage 2 also exits when stage 1 goes away.
fn spawn_through_launch_services(bundle: &Path, env: &[(OsString, OsString)]) -> Result<i32, String> {
    let mut command = Command::new("/usr/bin/open");
    command.args(["-n", "-g", "-W", "-a"]).arg(bundle);
    // Only pass what stage 2 needs; LaunchServices gives it a fresh environment otherwise.
    let wanted = [STAGE_ENV, LAUNCHER_ENV, STAGE1_ENV, crate::SOCKET_DIR_ENV];
    for (key, value) in env.iter().filter(|(key, _)| wanted.iter().any(|name| key == name)) {
        let mut pair = key.clone();
        pair.push("=");
        pair.push(value);
        command.arg("--env").arg(pair);
    }
    let child = command.spawn().map_err(|error| format!("open failed: {error}"))?;
    Ok(child.id() as i32)
}

fn wait_for(pid: i32) -> i32 {
    let mut status: c_int = 0;
    loop {
        // SAFETY: `pid` is our child and `status` is writable.
        let waited = unsafe { libc::waitpid(pid, &mut status, 0) };
        if waited == -1 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return exit::OK;
        }
        break;
    }
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        exit::OK
    }
}

/// Runs stage 1: starts stage 2 and waits for it.
pub fn run_first_stage() -> FirstStage {
    let launcher = LauncherIdentity::of_parent();
    let env = child_env(std::env::vars_os(), launcher, std::process::id());
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(error) => {
            log(format!("cannot find our executable: {error}"));
            return FirstStage::Exit(exit::SPAWN_FAILED);
        }
    };

    // Block before spawning so no signal slips between spawn and the forwarding thread.
    let signals = block_termination_signals();
    let spawned = match (disclaim_symbol(), bundle_of(&exe)) {
        (Some(set_disclaim), _) => spawn_disclaimed(&exe, &env, set_disclaim),
        (None, Some(bundle)) => {
            log("responsibility disclaim unavailable; launching through LaunchServices");
            spawn_through_launch_services(&bundle, &env)
        }
        (None, None) => {
            log("responsibility disclaim unavailable and not in a bundle; serving in-process");
            return FirstStage::RunInProcess;
        }
    };
    let child = match spawned {
        Ok(child) => child,
        Err(error) => {
            log(format!("cannot start the helper: {error}"));
            return FirstStage::Exit(exit::SPAWN_FAILED);
        }
    };

    spawn_signal_thread(signals, move |signal| {
        // SAFETY: sending a signal to our own child.
        unsafe { libc::kill(child, signal) };
    });
    FirstStage::Exit(wait_for(child))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_env_replaces_internal_keys() {
        let vars = vec![
            (OsString::from("HOME"), OsString::from("/Users/me")),
            (OsString::from(STAGE_ENV), OsString::from("1")),
            (OsString::from(LAUNCHER_ENV), OsString::from("1:2")),
        ];
        let launcher = LauncherIdentity { pid: 10, start_time: 20 };
        let env = child_env(vars.into_iter(), Some(launcher), 99);
        let get = |name: &str| env.iter().filter(|(key, _)| key == name).map(|(_, v)| v.clone()).collect::<Vec<_>>();
        assert_eq!(get("HOME"), vec![OsString::from("/Users/me")]);
        assert_eq!(get(STAGE_ENV), vec![OsString::from("2")]);
        assert_eq!(get(LAUNCHER_ENV), vec![OsString::from("10:20")]);
        assert_eq!(get(STAGE1_ENV), vec![OsString::from("99")]);
    }

    #[test]
    fn finds_the_enclosing_bundle() {
        let exe = Path::new(
            "/Users/me/Library/Application Support/BusyBoy/ComputerUse/BusyBoy Computer Use.app/Contents/MacOS/busyboy-computer-use",
        );
        assert_eq!(
            bundle_of(exe).unwrap(),
            Path::new("/Users/me/Library/Application Support/BusyBoy/ComputerUse/BusyBoy Computer Use.app")
        );
        assert!(bundle_of(Path::new("/tmp/target/debug/busyboy-computer-use")).is_none());
    }

    #[test]
    fn disclaim_symbol_resolves_on_this_system() {
        assert!(disclaim_symbol().is_some(), "expected the disclaim symbol on supported macOS versions");
    }
}
