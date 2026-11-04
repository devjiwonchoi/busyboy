//! Listen-only event tap that reports Esc and user input into operated apps.
//!
//! One long-lived thread runs the tap on its own run loop. The tap callback only
//! copies a few fields and sends them to a dispatcher thread, which classifies the
//! input and calls the engine. The callback never calls the engine itself, because
//! the engine may call `set` in response.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use cu_core::Deadline;
use cu_core::platform::{MonitorTarget, PlatformEvent};
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

/// Set when the last tap creation attempt failed; cleared when one succeeds.
static TAP_FAILED: AtomicBool = AtomicBool::new(false);

/// Whether the stop monitor can run: input monitoring is allowed (checked without a
/// prompt) and the last tap creation did not fail.
pub fn available() -> bool {
    CGPreflightListenEventAccess() && !TAP_FAILED.load(Ordering::SeqCst)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InputKind {
    KeyDown,
    MouseDown,
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

/// Decides what one physical input means. `key_target` is the process a key-down goes
/// to (its target pid, or the key-focused app). `location` is in screen points with a
/// top-left origin, the same space as the target frames.
pub(crate) fn classify(
    kind: InputKind,
    keycode: i64,
    key_target: Option<i32>,
    location: (f64, f64),
    user_data: i64,
    targets: &[MonitorTarget],
) -> Option<PlatformEvent> {
    if user_data == EVENT_TAG {
        return None;
    }
    match kind {
        InputKind::KeyDown if keycode == ESCAPE_KEYCODE => Some(PlatformEvent::Escape),
        InputKind::KeyDown => {
            let pid = key_target?;
            targets.iter().any(|target| target.pid == pid).then_some(PlatformEvent::UserInput { pid })
        }
        InputKind::MouseDown => targets
            .iter()
            .find(|target| target.frames.iter().any(|frame| frame.contains(location.0, location.1)))
            .map(|target| PlatformEvent::UserInput { pid: target.pid }),
    }
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
            }),
        }
    }

    /// Whether the monitor can run (see [`available`]).
    pub fn available(&self) -> bool {
        available()
    }

    pub fn set(&self, armed: bool, targets: Vec<MonitorTarget>) {
        *self.shared.targets.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = targets;
        self.shared.armed.store(armed, Ordering::SeqCst);
        let mut tap = self.shared.tap.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if armed {
            let retry = match &*tap {
                TapState::NotStarted => true,
                TapState::Failed(at) => at.elapsed() >= RETRY_AFTER,
                TapState::Running(_) => false,
            };
            // Never create the tap without input-monitoring access: that would prompt.
            if retry && CGPreflightListenEventAccess() {
                *tap = start_tap(&self.shared);
            }
        }
        if let TapState::Running(port) = &*tap {
            CGEvent::tap_enable(&port.0, armed);
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
                for input in receiver {
                    dispatch(&shared, input);
                }
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
    let key_target = if input.kind == InputKind::KeyDown && input.keycode != ESCAPE_KEYCODE && !targets.is_empty() {
        if input.target_pid > 0 { Some(input.target_pid) } else { key_focused_pid() }
    } else {
        None
    };
    if let Some(event) =
        classify(input.kind, input.keycode, key_target, (input.x, input.y), input.user_data, &targets)
    {
        emit(&shared.sink, event);
    }
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
        Ok(_) => created.recv_timeout(CREATE_WAIT).ok().flatten(),
        Err(_) => None,
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
        let _ = reply.send(None);
        return;
    };
    let Some(source) = CFMachPort::new_run_loop_source(None, Some(&port), 0) else {
        let _ = reply.send(None);
        return;
    };
    let Some(run_loop) = CFRunLoop::current() else {
        let _ = reply.send(None);
        return;
    };
    // SAFETY: reading an immutable CF constant.
    run_loop.add_source(Some(&source), unsafe { kCFRunLoopCommonModes });
    let port = Arc::new(TapPort(port));
    let _ = context.port.set(Arc::clone(&port));
    // Start disabled; `set` enables it while armed.
    CGEvent::tap_enable(&port.0, context.shared.armed.load(Ordering::SeqCst));
    let _ = reply.send(Some(port));
    loop {
        CFRunLoop::run();
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
        if context.shared.armed.load(Ordering::SeqCst)
            && let Some(port) = context.port.get()
        {
            CGEvent::tap_enable(&port.0, true);
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
    use cu_core::tree::Rect;

    use super::*;

    fn targets() -> Vec<MonitorTarget> {
        vec![MonitorTarget { pid: 42, frames: vec![Rect { x: 100.0, y: 100.0, width: 400.0, height: 300.0 }] }]
    }

    #[test]
    fn escape_stops_anywhere_even_without_targets() {
        assert_eq!(classify(InputKind::KeyDown, 53, Some(7), (0.0, 0.0), 0, &[]), Some(PlatformEvent::Escape));
        assert_eq!(classify(InputKind::KeyDown, 53, None, (0.0, 0.0), 0, &targets()), Some(PlatformEvent::Escape));
    }

    #[test]
    fn our_own_events_are_ignored() {
        assert_eq!(classify(InputKind::KeyDown, 53, None, (0.0, 0.0), EVENT_TAG, &targets()), None);
        assert_eq!(classify(InputKind::MouseDown, 0, None, (200.0, 200.0), EVENT_TAG, &targets()), None);
    }

    #[test]
    fn key_down_into_a_target_app_is_user_input() {
        assert_eq!(
            classify(InputKind::KeyDown, 0, Some(42), (0.0, 0.0), 0, &targets()),
            Some(PlatformEvent::UserInput { pid: 42 })
        );
        assert_eq!(classify(InputKind::KeyDown, 0, Some(7), (0.0, 0.0), 0, &targets()), None);
        assert_eq!(classify(InputKind::KeyDown, 0, None, (0.0, 0.0), 0, &targets()), None);
    }

    #[test]
    fn mouse_down_inside_a_target_frame_is_user_input() {
        assert_eq!(
            classify(InputKind::MouseDown, 0, None, (150.0, 120.0), 0, &targets()),
            Some(PlatformEvent::UserInput { pid: 42 })
        );
        assert_eq!(classify(InputKind::MouseDown, 0, None, (50.0, 50.0), 0, &targets()), None);
        assert_eq!(classify(InputKind::MouseDown, 0, None, (500.0, 400.0), 0, &targets()), None);
    }

    #[test]
    fn event_mask_covers_the_requested_types() {
        assert_eq!(mask(CGEventType::KeyDown), 1 << 10);
        assert_eq!(mask(CGEventType::OtherMouseDown), 1 << 25);
    }
}
