//! `busyboy-computer-use`: the BusyBoy Computer Use helper. See the `cu_helper` crate
//! docs for the launch, environment, socket, and exit-code contract.

#[cfg(target_os = "macos")]
fn main() {
    use cu_helper::stage::{self, FirstStage};

    if !stage::is_second_stage() {
        match stage::run_first_stage() {
            FirstStage::Exit(code) => std::process::exit(code),
            FirstStage::RunInProcess => {}
        }
    }
    std::process::exit(mac::run_second_stage());
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("busyboy-computer-use only runs on macOS");
    std::process::exit(1);
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    use std::sync::{Arc, Once};
    use std::thread;
    use std::time::Duration;

    use cu_core::Engine;
    use cu_helper::server::{self, Hub};
    use cu_helper::socket::{self, SocketError};
    use cu_helper::stage;
    use cu_helper::{HELPER_VERSION, LAUNCHER_ENV, STAGE1_ENV, exit, log};
    use cu_macos::MacPlatform;
    use cu_macos::caller::LauncherIdentity;
    use objc2_core_foundation::{CFAbsoluteTimeGetCurrent, CFRunLoop, CFRunLoopTimer, kCFRunLoopDefaultMode};

    const TICK_INTERVAL: Duration = Duration::from_secs(5);

    pub fn run_second_stage() -> i32 {
        // Before any thread exists, so every thread inherits the blocked mask.
        let signals = stage::block_termination_signals();

        let launcher = match std::env::var(LAUNCHER_ENV) {
            Ok(value) => LauncherIdentity::decode(&value),
            // Serving in-process from stage 1: our parent is the launcher.
            Err(_) if !stage::is_second_stage() => LauncherIdentity::of_parent(),
            Err(_) => None,
        };

        let socket = match socket::resolve_path().and_then(|path| socket::bind(&path)) {
            Ok(socket) => socket,
            Err(SocketError::AlreadyRunning) => {
                log("another helper is already serving; exiting");
                return exit::ALREADY_RUNNING;
            }
            Err(error) => {
                log(&error);
                return error.exit_code();
            }
        };
        log(format!("listening on {}", socket.path.display()));
        let (socket_path, socket_inode) = (socket.path.clone(), socket.inode());

        cu_macos::prepare_main_thread();
        let hub = Hub::new();
        let engine = Engine::new(Arc::new(MacPlatform::new()), HELPER_VERSION, hub.notifier());
        server::spawn(socket.listener, engine.clone(), hub, server::production_verifier(launcher));

        let ticker = engine.clone();
        thread::Builder::new()
            .name("cu-tick".to_owned())
            .spawn(move || {
                loop {
                    thread::sleep(TICK_INTERVAL);
                    ticker.tick();
                }
            })
            .expect("spawn tick thread");

        let once = Arc::new(Once::new());
        let shutdown = move |why: &str| {
            once.call_once(|| {
                log(format!("shutting down: {why}"));
                // A panic in platform cleanup must not keep the socket around or the process alive.
                let engine = engine.clone();
                let shutdown = std::panic::AssertUnwindSafe(move || engine.shutdown());
                if std::panic::catch_unwind(shutdown).is_err() {
                    log("engine shutdown panicked");
                }
                socket::remove_if_inode(&socket_path, socket_inode);
                std::process::exit(exit::OK);
            });
        };
        let shutdown = Arc::new(shutdown);
        let on_signal = shutdown.clone();
        stage::spawn_signal_thread(signals, move |signal| on_signal(&format!("signal {signal}")));
        if let Some(stage1) = std::env::var(STAGE1_ENV).ok().and_then(|pid| pid.parse::<i32>().ok()) {
            stage::watch_process_exit(stage1, move || shutdown("first stage exited"));
        }

        run_main_loop();
        exit::OK
    }

    unsafe extern "C-unwind" fn keep_alive(_timer: *mut CFRunLoopTimer, _info: *mut c_void) {}

    /// Runs the main run loop forever; some macOS services deliver on it.
    fn run_main_loop() {
        // A run loop with no sources returns at once, so park a far-future repeating timer on it.
        // SAFETY: default allocator, a valid no-op callout, and no context.
        let timer = unsafe {
            CFRunLoopTimer::new(
                None,
                CFAbsoluteTimeGetCurrent() + 1.0e9,
                1.0e9,
                0,
                0,
                Some(keep_alive),
                std::ptr::null_mut(),
            )
        };
        let run_loop = CFRunLoop::current().expect("main run loop");
        // SAFETY: reading an immutable CF constant.
        let mode = unsafe { kCFRunLoopDefaultMode };
        run_loop.add_timer(timer.as_deref(), mode);
        loop {
            CFRunLoop::run();
        }
    }
}
