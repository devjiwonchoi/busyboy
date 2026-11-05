//! Listen-only event tap that reports Esc and user input into operated apps.
//!
//! One long-lived thread runs the tap on its own run loop. The tap callback only
//! copies a few fields and sends them to a dispatcher thread, which classifies the
//! input and calls the engine. The callback never calls the engine itself, because
//! the engine may call `set` in response.
//!
//! It logs to stderr (the desktop forwards that to its log) so a live session shows
//! whether the tap exists, gets input, and fires. It never logs which keys were
//! pressed: only counts, and whether a key was Esc.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use cu_core::Deadline;
use cu_core::platform::{MonitorTarget, PlatformEvent};
use cu_core::stop::{InputKind, PhysicalInput, classify_input};
use objc2::rc::autoreleasepool;
use objc2_app_kit::NSWorkspace;
use objc2_core_foundation::{CFMachPort, CFRetained, CFRunLoop, kCFRunLoopCommonModes};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventTapProxy, CGEventType,
    CGPreflightListenEventAccess,
};

use crate::ax::AxElement;
use crate::{EVENT_TAG, SharedSink, emit};

/// Virtual key code of Esc.
const ESCAPE_KEYCODE: i64 = 53;
/// How long `set` waits for the tap thread to report whether the tap was created.
const CREATE_WAIT: Duration = Duration::from_millis(500);
/// Minimum time between tap creation attempts after a failure.
const RETRY_AFTER: Duration = Duration::from_secs(5);
/// Budget for finding the key-focused app when a key event has no target pid.
const FOCUS_LOOKUP: Duration = Duration::from_millis(100);

/// At most one key-count line per this long.
const COUNT_LOG_EVERY: Duration = Duration::from_secs(5);

/// Set when the last tap creation attempt failed; cleared when one succeeds.
static TAP_FAILED: AtomicBool = AtomicBool::new(false);

fn log(message: impl std::fmt::Display) {
    eprintln!("busyboy-computer-use[{}]: stop monitor: {message}", std::process::id());
}

fn thread_name() -> String {
    std::thread::current().name().unwrap_or("unnamed").to_owned()
}

/// Whether the stop monitor can run: input monitoring is allowed (checked without a
/// prompt) and the last tap creation did not fail.
pub fn available() -> bool {
    CGPreflightListenEventAccess() && !TAP_FAILED.load(Ordering::SeqCst)
}

/// The fields the tap callback copies out of one event.
#[derive(Debug, Clone, Copy, PartialEq)]
struct RawInput {
    kind: InputKind,
    keycode: i64,
    /// `kCGEventTargetUnixProcessID`, 0 when unknown.
    target_pid: i32,
    x: f64,
    y: f64,
    user_data: i64,
}

/// Retained tap port, shared with the thread that runs it.
struct TapPort(CFRetained<CFMachPort>);

// SAFETY: a CFMachPort is a thread-safe CF object; we only enable/disable the tap through it.
unsafe impl Send for TapPort {}
// SAFETY: as above.
unsafe impl Sync for TapPort {}

enum TapState {
    NotStarted,
    Running(Arc<TapPort>),
    Failed(Instant),
}

struct Shared {
    sink: SharedSink,
    armed: AtomicBool,
    targets: Mutex<Vec<MonitorTarget>>,
    tap: Mutex<TapState>,
    /// Sender to the dispatcher thread, started with the first tap.
    events: OnceLock<Sender<RawInput>>,
    /// Key-downs the tap has seen, and how many of them we posted ourselves.
    keys_seen: AtomicU64,
    own_keys_seen: AtomicU64,
    /// When the key count was last logged.
    count_logged: Mutex<Option<Instant>>,
}

/// State the tap callback reads. Owned by the tap thread for its lifetime.
struct TapContext {
    shared: Arc<Shared>,
    events: Sender<RawInput>,
    port: OnceLock<Arc<TapPort>>,
}

pub struct StopMonitor {
    shared: Arc<Shared>,
}

impl StopMonitor {
    pub fn new(sink: SharedSink) -> Self {
        StopMonitor {
            shared: Arc::new(Shared {
                sink,
                armed: AtomicBool::new(false),
                targets: Mutex::new(Vec::new()),
                tap: Mutex::new(TapState::NotStarted),
                events: OnceLock::new(),
                keys_seen: AtomicU64::new(0),
                own_keys_seen: AtomicU64::new(0),
                count_logged: Mutex::new(None),
            }),
        }
    }

    /// Whether the monitor can run (see [`available`]).
    pub fn available(&self) -> bool {
        available()
    }

    pub fn set(&self, armed: bool, targets: Vec<MonitorTarget>) {
        let target_count = targets.len();
        *self.shared.targets.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = targets;
        let was_armed = self.shared.armed.swap(armed, Ordering::SeqCst);
        if armed != was_armed {
            log(format!("{} ({target_count} target apps)", if armed { "armed" } else { "disarmed" }));
        }
        let mut tap = self.shared.tap.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if armed {
            let retry = match &*tap {
                TapState::NotStarted => true,
                TapState::Failed(at) => at.elapsed() >= RETRY_AFTER,
                TapState::Running(_) => false,
            };
            // Never create the tap without input-monitoring access: that would prompt.
            if retry {
                if CGPreflightListenEventAccess() {
                    *tap = start_tap(&self.shared);
                } else if !was_armed {
                    log("not started: Input Monitoring is not granted to this process");
                }
            }
        }
        if let TapState::Running(port) = &*tap {
            CGEvent::tap_enable(&port.0, armed);
            if armed != was_armed {
                log(format!("tap {} (enabled now: {})", if armed { "enabled" } else { "disabled" }, CGEvent::tap_is_enabled(&port.0)));
            }
        }
    }
}

fn dispatcher(shared: &Arc<Shared>) -> Sender<RawInput> {
    shared
        .events
        .get_or_init(|| {
            let (sender, receiver) = mpsc::channel::<RawInput>();
            let shared = Arc::clone(shared);
            let spawned = std::thread::Builder::new().name("cu-stop-dispatch".into()).spawn(move || {
                log("dispatcher running");
                for input in receiver {
                    dispatch(&shared, input);
                }
                log("dispatcher ended");
            });
            if let Err(error) = spawned {
                eprintln!("computer-use: stop dispatcher did not start: {error}");
            }
            sender
        })
        .clone()
}

fn dispatch(shared: &Shared, input: RawInput) {
    if !shared.armed.load(Ordering::SeqCst) {
        return;
    }
    let targets = shared.targets.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    let escape = input.kind == InputKind::KeyDown && input.keycode == ESCAPE_KEYCODE;
    let key_target = if input.kind == InputKind::KeyDown && !escape && !targets.is_empty() {
        if input.target_pid > 0 { Some(input.target_pid) } else { key_focused_pid() }
    } else {
        None
    };
    let physical = PhysicalInput {
        kind: input.kind,
        escape,
        key_target,
        location: (input.x, input.y),
        user_data: input.user_data,
    };
    if escape {
        log("Esc key-down seen");
    }
    match classify_input(&physical, &targets) {
        Some(event) => {
            match event {
                PlatformEvent::Escape => log("stop: user_escape"),
                PlatformEvent::UserInput { pid } => log(format!("stop: user_input in pid {pid}")),
                PlatformEvent::LockChanged { .. } => {}
            }
            let has_sink = shared.sink.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).is_some();
            if !has_sink {
                log("stop dropped: no engine is listening yet");
            }
            emit(&shared.sink, event);
        }
        None if escape => log("Esc ignored"),
        None => {}
    }
}

/// Counts key-downs and logs the totals at most every few seconds, so a live log
/// shows whether the tap gets any keyboard input. Never logs which keys.
fn count_key(shared: &Shared, ours: bool) {
    let seen = shared.keys_seen.fetch_add(1, Ordering::Relaxed) + 1;
    let own = if ours { shared.own_keys_seen.fetch_add(1, Ordering::Relaxed) + 1 } else { shared.own_keys_seen.load(Ordering::Relaxed) };
    // try_lock: never wait inside the tap callback.
    let Ok(mut logged) = shared.count_logged.try_lock() else {
        return;
    };
    if logged.is_some_and(|at| at.elapsed() < COUNT_LOG_EVERY) {
        return;
    }
    *logged = Some(Instant::now());
    log(format!("{seen} key-downs seen so far ({own} posted by us)"));
}

/// The app that receives key events: the system-wide focused app, else the frontmost app.
fn key_focused_pid() -> Option<i32> {
    let deadline = Deadline::after(FOCUS_LOOKUP);
    if let Ok(Some(app)) = AxElement::system_wide().element("AXFocusedApplication", deadline)
        && let Ok(pid) = app.pid()
    {
        return Some(pid);
    }
    autoreleasepool(|_| NSWorkspace::sharedWorkspace().frontmostApplication().map(|app| app.processIdentifier()))
}

/// Starts the tap thread and waits briefly for it to report whether the tap exists.
fn start_tap(shared: &Arc<Shared>) -> TapState {
    let events = dispatcher(shared);
    let (reply, created) = mpsc::channel::<Option<Arc<TapPort>>>();
    let context = TapContext { shared: Arc::clone(shared), events, port: OnceLock::new() };
    let spawned = std::thread::Builder::new().name("cu-stop-monitor".into()).spawn(move || run_tap(context, reply));
    let port = match spawned {
        Ok(_) => match created.recv_timeout(CREATE_WAIT) {
            Ok(port) => port,
            Err(_) => {
                log(format!("tap thread did not report within {} ms", CREATE_WAIT.as_millis()));
                None
            }
        },
        Err(error) => {
            log(format!("tap thread did not start: {error}"));
            None
        }
    };
    TAP_FAILED.store(port.is_none(), Ordering::SeqCst);
    match port {
        Some(port) => TapState::Running(port),
        None => TapState::Failed(Instant::now()),
    }
}

fn mask(kind: CGEventType) -> u64 {
    1 << kind.0
}

/// Body of the tap thread: creates the tap, reports it, and runs the run loop forever.
fn run_tap(context: TapContext, reply: Sender<Option<Arc<TapPort>>>) {
    let interest = mask(CGEventType::KeyDown)
        | mask(CGEventType::LeftMouseDown)
        | mask(CGEventType::RightMouseDown)
        | mask(CGEventType::OtherMouseDown);
    let context = Box::new(context);
    let user_info = (&raw const *context).cast_mut().cast::<c_void>();
    // SAFETY: the callback matches the CGEventTapCallBack signature, and `context` outlives
    // the tap because this thread never returns while the tap exists.
    let port = unsafe {
        CGEvent::tap_create(
            CGEventTapLocation::SessionEventTap,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            interest,
            Some(on_event),
            user_info,
        )
    };
    let Some(port) = port else {
        log("could not create the event tap (is Input Monitoring granted to this helper?)");
        let _ = reply.send(None);
        return;
    };
    let Some(source) = CFMachPort::new_run_loop_source(None, Some(&port), 0) else {
        log("could not make a run loop source for the event tap");
        let _ = reply.send(None);
        return;
    };
    let Some(run_loop) = CFRunLoop::current() else {
        log("no run loop on the tap thread");
        let _ = reply.send(None);
        return;
    };
    // SAFETY: reading an immutable CF constant.
    run_loop.add_source(Some(&source), unsafe { kCFRunLoopCommonModes });
    let port = Arc::new(TapPort(port));
    let _ = context.port.set(Arc::clone(&port));
    // Enabled only while armed; `set` turns it on and off.
    let armed = context.shared.armed.load(Ordering::SeqCst);
    CGEvent::tap_enable(&port.0, armed);
    log(format!(
        "session tap created (listen-only, key-down and mouse-down), added to the run loop of thread {}, enabled: {}",
        thread_name(),
        CGEvent::tap_is_enabled(&port.0)
    ));
    if reply.send(Some(port)).is_err() {
        log("the tap was created too late; it keeps running but cannot be turned off");
    }
    loop {
        CFRunLoop::run();
        // `run` returns only when the run loop has nothing to wait on.
        log(format!("run loop on thread {} returned; running it again", thread_name()));
        std::thread::sleep(Duration::from_millis(100));
    }
}

unsafe extern "C-unwind" fn on_event(
    _proxy: CGEventTapProxy,
    kind: CGEventType,
    event: NonNull<CGEvent>,
    user_info: *mut c_void,
) -> *mut CGEvent {
    let passthrough = event.as_ptr();
    if user_info.is_null() {
        return passthrough;
    }
    // SAFETY: `user_info` is the TapContext owned by the tap thread, alive while the tap runs.
    let context = unsafe { &*(user_info as *const TapContext) };
    if kind == CGEventType::TapDisabledByTimeout || kind == CGEventType::TapDisabledByUserInput {
        let why = if kind == CGEventType::TapDisabledByTimeout { "timeout" } else { "user input" };
        if context.shared.armed.load(Ordering::SeqCst)
            && let Some(port) = context.port.get()
        {
            CGEvent::tap_enable(&port.0, true);
            log(format!("tap was disabled by {why}; enabled again"));
        } else {
            log(format!("tap was disabled by {why} while not armed"));
        }
        return passthrough;
    }
    if !context.shared.armed.load(Ordering::SeqCst) {
        return passthrough;
    }
    let input_kind = match kind {
        CGEventType::KeyDown => InputKind::KeyDown,
        CGEventType::LeftMouseDown | CGEventType::RightMouseDown | CGEventType::OtherMouseDown => InputKind::MouseDown,
        _ => return passthrough,
    };
    // SAFETY: the event is valid for the duration of the callback.
    let event = Some(unsafe { event.as_ref() });
    let user_data = CGEvent::integer_value_field(event, CGEventField::EventSourceUserData);
    if input_kind == InputKind::KeyDown {
        count_key(&context.shared, user_data == EVENT_TAG);
    }
    if user_data == EVENT_TAG {
        return passthrough;
    }
    let keycode = CGEvent::integer_value_field(event, CGEventField::KeyboardEventKeycode);
    if input_kind == InputKind::KeyDown && CGEvent::integer_value_field(event, CGEventField::KeyboardEventAutorepeat) != 0 {
        return passthrough;
    }
    let location = CGEvent::location(event);
    let input = RawInput {
        kind: input_kind,
        keycode,
        target_pid: CGEvent::integer_value_field(event, CGEventField::EventTargetUnixProcessID) as i32,
        x: location.x,
        y: location.y,
        user_data,
    };
    let _ = context.events.send(input);
    passthrough
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_is_virtual_key_53() {
        // kVK_Escape in Carbon's Events.h.
        assert_eq!(ESCAPE_KEYCODE, 0x35);
    }

    #[test]
    fn event_mask_covers_the_requested_types() {
        assert_eq!(mask(CGEventType::KeyDown), 1 << 10);
        assert_eq!(mask(CGEventType::OtherMouseDown), 1 << 25);
    }
}
