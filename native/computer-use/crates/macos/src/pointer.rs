//! Experimental background pointer: clicks and wheel scrolls posted to one window of
//! one process, without moving the cursor or activating the app.
//!
//! Portions adapted from cua (https://github.com/trycua/cua, MIT) at d685580.
//! Copyright (c) 2025 Cua AI, Inc.
//! Portions adapted from Peekaboo (https://github.com/openclaw/Peekaboo, MIT) at 14a4418.
//! Copyright (c) 2025 Peter Steinberger.
//!
//! Settings risk note: this uses an undocumented (private) macOS API, it may stop
//! working after a macOS update, and some apps (games, 3D views, canvas engines)
//! ignore background clicks entirely.
//!
//! How it works:
//! - The private window-server post function is looked up by name at runtime
//!   (`dlopen` + `dlsym`, resolved once and cached, never linked). Public pid-targeted
//!   events are often ignored by Chromium web content; the private path is not. When
//!   the symbol is missing, the same events go through the public `CGEvent` post-to-pid.
//! - Every event is tagged with [`crate::EVENT_TAG`] (so the stop monitor ignores it),
//!   carries the target pid and window id in its routing fields, and is stamped with
//!   the window-local point when the stamping function resolves.
//! - Chromium-family apps get an off-screen primer press/release first, so the page's
//!   user-activation gate accepts the real click.
//! - Before every event the window must still belong to the pid, with the same bounds,
//!   and the engine guard (cancel, lock) must pass. A mouse-down is always followed by
//!   its mouse-up, even when the sequence stops.
//!
//! Never here: cursor warping, HID- or session-level posting, app activation, focus or
//! key-window changes, Space changes. Keyboard input stays on the public pid path.

use std::collections::HashMap;
use std::ffi::{CStr, c_void};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use cu_core::platform::{PointerRoute, RunningApp, StepGuard, unsupported};
use cu_core::tree::{Rect, WindowInfo};
use cu_core::{CuResult, ProcessRef};
use cu_protocol::{MouseButton, ScrollAmount, ScrollDirection};
use objc2::rc::autoreleasepool;
use objc2_app_kit::NSRunningApplication;
use objc2_core_foundation::{CFRetained, CGPoint};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventFlags, CGEventSource, CGEventSourceStateID, CGEventType, CGMouseButton,
    CGScrollEventUnit,
};

use crate::capture::parse_window_id;

// -- private symbols ----------------------------------------------------------

/// `void SLEventPostToPid(pid_t, CGEventRef)`.
type PostToPidFn = unsafe extern "C" fn(libc::pid_t, *mut c_void);
/// `void CGEventSetWindowLocation(CGEventRef, CGPoint)`; a `CGPoint` passed by value
/// has the same ABI as two doubles on arm64 and x86-64.
type SetWindowLocationFn = unsafe extern "C" fn(*mut c_void, f64, f64);

const WINDOW_SERVER_FRAMEWORK: &CStr = c"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight";

struct PrivateApi {
    post_to_pid: Option<PostToPidFn>,
    set_window_location: Option<SetWindowLocationFn>,
}

/// Resolves the private functions once. Missing symbols stay `None`.
fn private_api() -> &'static PrivateApi {
    static API: OnceLock<PrivateApi> = OnceLock::new();
    API.get_or_init(|| {
        // SAFETY: dlopen/dlsym with valid NUL-terminated names. The handle is kept for
        // the life of the process. Each symbol is cast to its documented-by-use signature.
        unsafe {
            let handle = libc::dlopen(WINDOW_SERVER_FRAMEWORK.as_ptr(), libc::RTLD_LAZY | libc::RTLD_GLOBAL);
            let lookup = |name: &CStr| {
                let from_handle = if handle.is_null() { std::ptr::null_mut() } else { libc::dlsym(handle, name.as_ptr()) };
                let symbol = if from_handle.is_null() { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) } else { from_handle };
                (!symbol.is_null()).then_some(symbol)
            };
            PrivateApi {
                post_to_pid: lookup(c"SLEventPostToPid")
                    .map(|symbol| std::mem::transmute::<*mut c_void, PostToPidFn>(symbol)),
                set_window_location: lookup(c"CGEventSetWindowLocation")
                    .map(|symbol| std::mem::transmute::<*mut c_void, SetWindowLocationFn>(symbol)),
            }
        }
    })
}

/// The private post path resolved on this macOS build.
pub fn private_post_available() -> bool {
    private_api().post_to_pid.is_some()
}

fn route() -> PointerRoute {
    if private_post_available() { PointerRoute::WindowServer } else { PointerRoute::Public }
}

// -- event plan (pure) ----------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StepKind {
    Move,
    Down,
    Up,
}

/// One mouse event of a click sequence. Points are window-local.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Step {
    pub kind: StepKind,
    /// The off-screen Chromium primer, not the real click.
    pub primer: bool,
    pub button: MouseButton,
    pub click_state: i64,
    pub local: (f64, f64),
    pub delay_after_ms: u64,
}

/// Off-screen point for the primer: it hits no window content.
const PRIMER_POINT: (f64, f64) = (-1.0, -1.0);
/// Gap inside a press: an AppKit button's tracking loop needs time to see the down.
const DOWN_UP_MS: u64 = 28;
const BETWEEN_CLICKS_MS: u64 = 80;
const WHEEL_GAP_MS: u64 = 30;

/// Events for one click: a tracking move at the target, the Chromium primer when
/// asked, then `count` down/up pairs with rising click state.
pub(crate) fn click_plan(local: (f64, f64), button: MouseButton, count: u32, primer: bool) -> Vec<Step> {
    let step = |kind, primer, button, click_state, local, delay_after_ms| Step {
        kind,
        primer,
        button,
        click_state,
        local,
        delay_after_ms,
    };
    let mut steps = vec![step(StepKind::Move, false, MouseButton::Left, 0, local, 12)];
    if primer {
        steps.push(step(StepKind::Down, true, MouseButton::Left, 1, PRIMER_POINT, 1));
        steps.push(step(StepKind::Up, true, MouseButton::Left, 1, PRIMER_POINT, 100));
    }
    let count = count.clamp(1, 2);
    for pair in 1..=count {
        let last = pair == count;
        steps.push(step(StepKind::Down, false, button, pair as i64, local, DOWN_UP_MS));
        steps.push(step(StepKind::Up, false, button, pair as i64, local, if last { 0 } else { BETWEEN_CLICKS_MS }));
    }
    steps
}

/// Posts `steps` in order. Before each event `check` must pass (guard and window
/// route); when it fails while a button is down, the paired mouse-up is still posted
/// (if the process is the same one) and then the sequence stops with the error.
pub(crate) fn run_plan(
    steps: &[Step],
    check: &mut dyn FnMut() -> CuResult<()>,
    same_process: &dyn Fn() -> bool,
    post: &mut dyn FnMut(&Step) -> CuResult<()>,
    sleep: &dyn Fn(u64),
) -> CuResult<()> {
    let mut held: Option<Step> = None;
    for step in steps {
        if let Err(error) = check() {
            if let Some(down) = held
                && same_process()
            {
                let _ = post(&Step { kind: StepKind::Up, delay_after_ms: 0, ..down });
            }
            return Err(error);
        }
        post(step)?;
        held = match step.kind {
            StepKind::Down => Some(*step),
            StepKind::Up => None,
            StepKind::Move => held,
        };
        if step.delay_after_ms > 0 {
            sleep(step.delay_after_ms);
        }
    }
    Ok(())
}

/// Wheel deltas `(vertical, horizontal)` in lines for one notch. Positive vertical
/// reveals content above, positive horizontal reveals content to the left.
pub(crate) fn wheel_delta(direction: ScrollDirection, amount: ScrollAmount) -> (i32, i32) {
    let lines = match amount {
        ScrollAmount::Line => 1,
        ScrollAmount::Page => 10,
    };
    match direction {
        ScrollDirection::Up => (lines, 0),
        ScrollDirection::Down => (-lines, 0),
        ScrollDirection::Left => (0, lines),
        ScrollDirection::Right => (0, -lines),
    }
}

// -- Chromium detection ---------------------------------------------------------

const CHROMIUM_BUNDLE_PREFIXES: &[&str] = &[
    "com.google.Chrome",
    "org.chromium.Chromium",
    "com.microsoft.edgemac",
    "com.brave.Browser",
    "company.thebrowser.Browser",
    "com.vivaldi.Vivaldi",
    "com.operasoftware.Opera",
];

/// Framework bundle names that mark a Chromium or Electron app.
const CHROMIUM_FRAMEWORK_MARKERS: &[&str] =
    &["Electron Framework", "Chromium Embedded Framework", "Chromium Framework", "Chrome Framework", "Edge Framework"];

pub(crate) fn is_chromium_family(bundle_id: &str, frameworks: &[String]) -> bool {
    CHROMIUM_BUNDLE_PREFIXES.iter().any(|prefix| bundle_id == *prefix || bundle_id.starts_with(&format!("{prefix}.")))
        || frameworks.iter().any(|name| CHROMIUM_FRAMEWORK_MARKERS.iter().any(|marker| name.contains(marker)))
}

fn bundle_frameworks(pid: i32) -> Vec<String> {
    let path = autoreleasepool(|_| {
        NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
            .and_then(|app| app.bundleURL())
            .and_then(|url| url.path())
            .map(|path| path.to_string())
    });
    let Some(path) = path else {
        return Vec::new();
    };
    std::fs::read_dir(Path::new(&path).join("Contents/Frameworks"))
        .map(|entries| entries.filter_map(|entry| entry.ok()?.file_name().into_string().ok()).collect())
        .unwrap_or_default()
}

fn needs_primer(app: &RunningApp) -> bool {
    static CACHE: OnceLock<Mutex<HashMap<ProcessRef, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(known) = cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&app.process) {
        return *known;
    }
    let chromium = is_chromium_family(&app.bundle_id, &bundle_frameworks(app.process.pid));
    cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(app.process, chromium);
    chromium
}

// -- route checks -----------------------------------------------------------------

/// The window and process the events are routed to, checked before every event.
struct Route<'a> {
    app: &'a RunningApp,
    window_id: u32,
    /// Window-server bounds when the sequence started.
    bounds: Rect,
}

fn window_changed() -> cu_protocol::ErrorObject {
    unsupported("window_changed", "the window moved, closed, or changed owner during the pointer action")
}

fn current_bounds(pid: i32, window_id: u32) -> Option<Rect> {
    crate::tree::cg_windows(pid).into_iter().find(|window| window.id == window_id).map(|window| window.bounds)
}

fn same_rect(a: &Rect, b: &Rect) -> bool {
    (a.x - b.x).abs() < 0.5 && (a.y - b.y).abs() < 0.5 && (a.width - b.width).abs() < 0.5 && (a.height - b.height).abs() < 0.5
}

impl<'a> Route<'a> {
    fn open(app: &'a RunningApp, window: &WindowInfo, local: (f64, f64)) -> CuResult<Self> {
        let window_id = parse_window_id(&window.id)
            .ok_or_else(|| unsupported("window_id_unknown", "the window has no window-server id"))?;
        let bounds = current_bounds(app.process.pid, window_id).ok_or_else(window_changed)?;
        if local.0 < 0.0 || local.1 < 0.0 || local.0 >= bounds.width || local.1 >= bounds.height {
            return Err(unsupported("point_outside_window", "the point is outside the window"));
        }
        Ok(Route { app, window_id, bounds })
    }

    fn same_process(&self) -> bool {
        self.app.process.start_time == 0
            || crate::apps::process_start_time(self.app.process.pid) == Some(self.app.process.start_time)
    }

    fn is_current(&self) -> bool {
        self.same_process()
            && current_bounds(self.app.process.pid, self.window_id).is_some_and(|bounds| same_rect(&bounds, &self.bounds))
    }

    fn screen(&self, local: (f64, f64)) -> CGPoint {
        CGPoint::new(self.bounds.x + local.0, self.bounds.y + local.1)
    }
}

// -- posting ----------------------------------------------------------------------

/// `kCGEventTargetUnixProcessID`.
const FIELD_TARGET_PID: u32 = 40;
const FIELD_CLICK_STATE: u32 = 1;
const FIELD_BUTTON_NUMBER: u32 = 3;
const FIELD_SUBTYPE: u32 = 7;
/// Window number as the AppKit event bridge reads it.
const FIELD_WINDOW_NUMBER: u32 = 51;
/// Shared id for the events of one gesture.
const FIELD_CLICK_GROUP: u32 = 58;
const FIELD_WINDOW_UNDER_POINTER: u32 = 91;
const FIELD_WINDOW_UNDER_POINTER_ACCEPTING: u32 = 92;
/// `NSEventSubtypeTouch`, used by the references for routed clicks.
const SUBTYPE_TOUCH: i64 = 3;

fn set_field(event: &CGEvent, field: u32, value: i64) {
    CGEvent::set_integer_value_field(Some(event), CGEventField(field), value);
}

fn private_source() -> CuResult<CFRetained<CGEventSource>> {
    let source = CGEventSource::new(CGEventSourceStateID::Private)
        .ok_or_else(|| unsupported("event_source_failed", "could not create a private event source"))?;
    CGEventSource::set_user_data(Some(&source), crate::EVENT_TAG);
    Ok(source)
}

fn click_group() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_nanos() as i64
}

/// Tags, stamps, and posts one event to the pid only.
fn stamp_and_post(route: &Route<'_>, event: &CGEvent, local: (f64, f64), group: i64) {
    CGEvent::set_flags(Some(event), CGEventFlags::empty());
    CGEvent::set_integer_value_field(Some(event), CGEventField::EventSourceUserData, crate::EVENT_TAG);
    set_field(event, FIELD_TARGET_PID, route.app.process.pid as i64);
    let window_id = route.window_id as i64;
    set_field(event, FIELD_WINDOW_NUMBER, window_id);
    set_field(event, FIELD_CLICK_GROUP, group);
    set_field(event, FIELD_WINDOW_UNDER_POINTER, window_id);
    set_field(event, FIELD_WINDOW_UNDER_POINTER_ACCEPTING, window_id);

    let api = private_api();
    let raw = event as *const CGEvent as *mut c_void;
    if let Some(set_window_location) = api.set_window_location {
        // SAFETY: `raw` is a live CGEvent for the duration of the call.
        unsafe { set_window_location(raw, local.0, local.1) };
    }
    match api.post_to_pid {
        // SAFETY: as above; the function only reads the event.
        Some(post) => unsafe { post(route.app.process.pid, raw) },
        None => CGEvent::post_to_pid(route.app.process.pid, Some(event)),
    }
}

fn mouse_event(source: &CGEventSource, route: &Route<'_>, step: &Step) -> CuResult<CFRetained<CGEvent>> {
    let (kind, button) = match (step.kind, step.button) {
        (StepKind::Move, _) => (CGEventType::MouseMoved, CGMouseButton::Left),
        (StepKind::Down, MouseButton::Left) => (CGEventType::LeftMouseDown, CGMouseButton::Left),
        (StepKind::Up, MouseButton::Left) => (CGEventType::LeftMouseUp, CGMouseButton::Left),
        (StepKind::Down, MouseButton::Right) => (CGEventType::RightMouseDown, CGMouseButton::Right),
        (StepKind::Up, MouseButton::Right) => (CGEventType::RightMouseUp, CGMouseButton::Right),
    };
    let screen = if step.primer { CGPoint::new(PRIMER_POINT.0, PRIMER_POINT.1) } else { route.screen(step.local) };
    let event = CGEvent::new_mouse_event(Some(source), kind, screen, button)
        .ok_or_else(|| unsupported("event_create_failed", "could not create a mouse event"))?;
    set_field(&event, FIELD_CLICK_STATE, step.click_state);
    set_field(&event, FIELD_BUTTON_NUMBER, if step.button == MouseButton::Right { 1 } else { 0 });
    set_field(&event, FIELD_SUBTYPE, SUBTYPE_TOUCH);
    Ok(event)
}

fn sleep_ms(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

pub fn click(
    app: &RunningApp,
    window: &WindowInfo,
    x: f64,
    y: f64,
    button: MouseButton,
    count: u32,
    guard: StepGuard<'_>,
) -> CuResult<PointerRoute> {
    let route_info = Route::open(app, window, (x, y))?;
    let source = private_source()?;
    let group = click_group();
    let plan = click_plan((x, y), button, count, needs_primer(app));
    let mut check = || {
        guard()?;
        if route_info.is_current() { Ok(()) } else { Err(window_changed()) }
    };
    let mut post = |step: &Step| {
        let event = mouse_event(&source, &route_info, step)?;
        stamp_and_post(&route_info, &event, step.local, group);
        Ok(())
    };
    run_plan(&plan, &mut check, &|| route_info.same_process(), &mut post, &sleep_ms)?;
    Ok(route())
}

#[allow(clippy::too_many_arguments)]
pub fn scroll(
    app: &RunningApp,
    window: &WindowInfo,
    x: f64,
    y: f64,
    direction: ScrollDirection,
    amount: ScrollAmount,
    times: u32,
    guard: StepGuard<'_>,
) -> CuResult<PointerRoute> {
    let route_info = Route::open(app, window, (x, y))?;
    let source = private_source()?;
    let group = click_group();
    let check = || -> CuResult<()> {
        guard()?;
        if route_info.is_current() { Ok(()) } else { Err(window_changed()) }
    };

    // A tracking move first, so a background web view hit-tests the wheel at the point.
    check()?;
    let primer = Step { kind: StepKind::Move, primer: false, button: MouseButton::Left, click_state: 0, local: (x, y), delay_after_ms: 0 };
    let event = mouse_event(&source, &route_info, &primer)?;
    stamp_and_post(&route_info, &event, (x, y), group);
    sleep_ms(12);

    let (vertical, horizontal) = wheel_delta(direction, amount);
    for tick in 0..times.max(1) {
        check()?;
        let event = CGEvent::new_scroll_wheel_event2(Some(&source), CGScrollEventUnit::Line, 2, vertical, horizontal, 0)
            .ok_or_else(|| unsupported("event_create_failed", "could not create a scroll event"))?;
        CGEvent::set_location(Some(&event), route_info.screen((x, y)));
        stamp_and_post(&route_info, &event, (x, y), group);
        if tick + 1 < times {
            sleep_ms(WHEEL_GAP_MS);
        }
    }
    Ok(route())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cu_protocol::{ErrorCode, ErrorObject};
    use std::cell::{Cell, RefCell};

    #[test]
    fn click_plan_moves_then_primes_then_clicks() {
        let plan = click_plan((10.0, 20.0), MouseButton::Left, 2, true);
        let kinds: Vec<(StepKind, bool, i64)> = plan.iter().map(|step| (step.kind, step.primer, step.click_state)).collect();
        assert_eq!(
            kinds,
            vec![
                (StepKind::Move, false, 0),
                (StepKind::Down, true, 1),
                (StepKind::Up, true, 1),
                (StepKind::Down, false, 1),
                (StepKind::Up, false, 1),
                (StepKind::Down, false, 2),
                (StepKind::Up, false, 2),
            ]
        );
        assert_eq!(plan[1].local, PRIMER_POINT);
        assert_eq!(plan[3].local, (10.0, 20.0));
        assert_eq!(plan.last().unwrap().delay_after_ms, 0);

        let right = click_plan((1.0, 1.0), MouseButton::Right, 1, false);
        assert_eq!(right.len(), 3, "no primer for non-Chromium apps");
        assert!(right[1..].iter().all(|step| step.button == MouseButton::Right));
    }

    fn run(steps: &[Step], fail_before: usize, same_process: bool) -> (CuResult<()>, Vec<(StepKind, bool)>) {
        let posted = RefCell::new(Vec::new());
        let checks = Cell::new(0);
        let mut check = || {
            checks.set(checks.get() + 1);
            if checks.get() > fail_before { Err(ErrorObject::new(ErrorCode::Stopped, "stopped")) } else { Ok(()) }
        };
        let mut post = |step: &Step| {
            posted.borrow_mut().push((step.kind, step.primer));
            Ok(())
        };
        let result = run_plan(steps, &mut check, &|| same_process, &mut post, &|_| {});
        (result, posted.into_inner())
    }

    #[test]
    fn a_stop_after_mouse_down_still_sends_the_mouse_up() {
        let plan = click_plan((5.0, 5.0), MouseButton::Left, 1, false);
        // move, down, then the check before up fails.
        let (result, posted) = run(&plan, 2, true);
        assert_eq!(result.unwrap_err().code, ErrorCode::Stopped);
        assert_eq!(posted, vec![(StepKind::Move, false), (StepKind::Down, false), (StepKind::Up, false)]);

        // A replaced process never gets the release.
        let (_, posted) = run(&plan, 2, false);
        assert_eq!(posted, vec![(StepKind::Move, false), (StepKind::Down, false)]);

        // A stop between complete pairs sends nothing extra.
        let plan = click_plan((5.0, 5.0), MouseButton::Left, 2, false);
        let (_, posted) = run(&plan, 3, true);
        assert_eq!(posted.len(), 3);
        let (result, posted) = run(&plan, usize::MAX, true);
        assert!(result.is_ok());
        assert_eq!(posted.len(), plan.len());
    }

    #[test]
    fn wheel_deltas_follow_the_direction() {
        assert_eq!(wheel_delta(ScrollDirection::Down, ScrollAmount::Line), (-1, 0));
        assert_eq!(wheel_delta(ScrollDirection::Up, ScrollAmount::Page), (10, 0));
        assert_eq!(wheel_delta(ScrollDirection::Right, ScrollAmount::Line), (0, -1));
        assert_eq!(wheel_delta(ScrollDirection::Left, ScrollAmount::Line), (0, 1));
    }

    #[test]
    fn detects_chromium_family_apps() {
        assert!(is_chromium_family("com.google.Chrome.canary", &[]));
        assert!(is_chromium_family("com.tinyspeck.slackmacgap", &["Electron Framework.framework".into()]));
        assert!(!is_chromium_family("com.apple.TextEdit", &["Sparkle.framework".into()]));
        assert!(!is_chromium_family("com.google.Chromecast", &[]));
    }

    #[test]
    fn symbol_lookup_is_cached_and_never_posts() {
        // Resolving only looks symbols up; it posts nothing.
        let first = private_post_available();
        assert_eq!(first, private_post_available());
    }

    // Live: posts a real background click to TextEdit's first window. Not run in CI;
    // needs Accessibility and a running TextEdit.
    #[test]
    #[ignore]
    fn live_background_click_in_textedit() {
        let output = std::process::Command::new("pgrep").arg("-x").arg("TextEdit").output().unwrap();
        let pid: i32 = String::from_utf8_lossy(&output.stdout).trim().parse().unwrap();
        let app = RunningApp {
            name: "TextEdit".into(),
            bundle_id: "com.apple.TextEdit".into(),
            process: ProcessRef { pid, start_time: crate::apps::process_start_time(pid).unwrap() },
        };
        let deadline = cu_core::Deadline::from_ms(Some(2_000));
        let window = crate::tree::windows(&app, deadline).unwrap().remove(0);
        click(&app, &window, 40.0, 80.0, MouseButton::Left, 1, &|| Ok(())).unwrap();
    }
}
