//! macOS backend for BusyBoy Computer Use.
//!
//! All work is background-only: accessibility reads and actions, key events posted to
//! one process, and per-window capture. Nothing here moves the pointer or activates an app.
#![cfg(target_os = "macos")]

pub mod actions;
pub mod apps;
pub mod ax;
pub mod caller;
pub mod capture;
pub mod keys;
pub mod monitor;
pub mod permissions;
pub mod session;
pub mod tree;
pub mod web;

use std::sync::{Arc, Mutex};

use ax::AxElement;
use cu_core::keys::KeyChord;
use cu_core::platform::*;
use cu_core::tree::{ElementAction, RawTree, TreeBudget, WindowInfo};
use cu_core::{CancelToken, CuResult, Deadline};
use cu_protocol::{
    AppEntry, FillValue, PermissionKind, PermissionsStatus, Screenshot, ScreenshotOmitted, ScrollAmount,
    ScrollDirection, TextRange,
};

/// Value stamped into `kCGEventSourceUserData` on every event we post, so the stop
/// monitor can ignore our own input.
pub const EVENT_TAG: i64 = 0x4255_5359_424F_5901; // "BUSYBOY\x01"

/// Event sink shared with background watchers. Empty until the engine installs it.
pub type SharedSink = Arc<Mutex<Option<EventSink>>>;

pub fn emit(sink: &SharedSink, event: PlatformEvent) {
    let sink = sink.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    if let Some(sink) = sink {
        sink(event);
    }
}

/// Connects the process to the window server (ScreenCaptureKit needs it) without a Dock
/// icon and without ever activating. Call once on the main thread before serving.
pub fn prepare_main_thread() {
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
    if let Some(main_thread) = objc2::MainThreadMarker::new() {
        let application = NSApplication::sharedApplication(main_thread);
        application.setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
    }
}

pub struct MacPlatform {
    sink: SharedSink,
    web: web::WebAccess,
    monitor: monitor::StopMonitor,
}

impl MacPlatform {
    /// Starts the lock watcher and prepares the stop monitor (armed later).
    pub fn new() -> Self {
        let sink: SharedSink = Arc::new(Mutex::new(None));
        session::start_lock_watcher(sink.clone());
        MacPlatform { monitor: monitor::StopMonitor::new(sink.clone()), web: web::WebAccess::default(), sink }
    }
}

impl Default for MacPlatform {
    fn default() -> Self {
        MacPlatform::new()
    }
}

impl Platform for MacPlatform {
    type Element = AxElement;

    fn name(&self) -> &'static str {
        "macos"
    }

    fn capabilities(&self) -> Vec<String> {
        Vec::new()
    }

    fn set_event_sink(&self, sink: EventSink) {
        *self.sink.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(sink);
    }

    fn permissions(&self) -> PermissionsStatus {
        permissions::status()
    }

    fn request_permission(&self, kind: PermissionKind) -> CuResult<()> {
        permissions::request(kind)
    }

    fn list_apps(&self, include_installed: bool) -> CuResult<Vec<AppEntry>> {
        apps::list_apps(include_installed)
    }

    fn resolve_app(&self, query: &str) -> CuResult<AppTarget> {
        apps::resolve_app(query)
    }

    fn process_start_time(&self, pid: i32) -> Option<u64> {
        apps::process_start_time(pid)
    }

    fn launch_app(&self, bundle_id: &str, deadline: Deadline) -> CuResult<LaunchOutcome> {
        apps::launch_app(bundle_id, deadline)
    }

    fn windows(&self, app: &RunningApp, deadline: Deadline) -> CuResult<Vec<WindowInfo>> {
        tree::windows(app, deadline)
    }

    fn snapshot(
        &self,
        app: &RunningApp,
        window: &WindowInfo,
        budget: &TreeBudget,
        deadline: Deadline,
        cancel: &CancelToken,
    ) -> CuResult<RawTree<AxElement>> {
        tree::snapshot(&self.web, app, window, budget, deadline, cancel)
    }

    fn element_key(&self, element: &AxElement) -> u64 {
        ax::element_hash(element)
    }

    fn same_element(&self, a: &AxElement, b: &AxElement) -> bool {
        a == b
    }

    fn element_status(&self, element: &AxElement, deadline: Deadline) -> ElementStatus {
        tree::element_status(element, deadline)
    }

    fn probe(&self, element: &AxElement, deadline: Deadline) -> CuResult<ElementProbe> {
        tree::probe(element, deadline)
    }

    fn element_window_id(&self, element: &AxElement, deadline: Deadline) -> Option<String> {
        tree::element_window_id(element, deadline)
    }

    fn parent(&self, element: &AxElement, deadline: Deadline) -> Option<AxElement> {
        tree::parent(element, deadline)
    }

    fn children(&self, element: &AxElement, deadline: Deadline) -> Vec<AxElement> {
        tree::children(element, deadline)
    }

    fn focused_element(&self, app: &RunningApp, deadline: Deadline) -> Option<AxElement> {
        tree::focused_element(app, deadline)
    }

    fn element_at(&self, app: &RunningApp, x: f64, y: f64, deadline: Deadline) -> Option<AxElement> {
        tree::element_at(app, x, y, deadline)
    }

    fn fingerprint(
        &self,
        app: &RunningApp,
        window: Option<&WindowInfo>,
        target: Option<&AxElement>,
        deadline: Deadline,
    ) -> Fingerprint {
        tree::fingerprint(app, window, target, deadline)
    }

    fn perform(&self, element: &AxElement, action: ElementAction, deadline: Deadline) -> CuResult<()> {
        actions::perform(element, action, deadline)
    }

    fn set_value(&self, element: &AxElement, value: &FillValue, deadline: Deadline) -> CuResult<()> {
        actions::set_value(element, value, deadline)
    }

    fn set_selected_text(&self, element: &AxElement, text: &str, deadline: Deadline) -> CuResult<()> {
        actions::set_selected_text(element, text, deadline)
    }

    fn set_selected_range(&self, element: &AxElement, range: TextRange, deadline: Deadline) -> CuResult<()> {
        actions::set_selected_range(element, range, deadline)
    }

    fn set_selected(&self, element: &AxElement, selected: bool, deadline: Deadline) -> CuResult<()> {
        actions::set_selected(element, selected, deadline)
    }

    fn set_focused(&self, element: &AxElement, deadline: Deadline) -> CuResult<()> {
        actions::set_focused(element, deadline)
    }

    fn scroll_area(
        &self,
        element: &AxElement,
        direction: ScrollDirection,
        amount: ScrollAmount,
        deadline: Deadline,
    ) -> CuResult<()> {
        actions::scroll_area(element, direction, amount, deadline)
    }

    fn main_scroll_area(&self, app: &RunningApp, window: &WindowInfo, deadline: Deadline) -> Option<AxElement> {
        actions::main_scroll_area(app, window, deadline)
    }

    fn press_menu_path(&self, app: &RunningApp, path: &[String], deadline: Deadline) -> CuResult<()> {
        actions::press_menu_path(app, path, deadline)
    }

    fn post_key(&self, app: &RunningApp, chord: &KeyChord) -> CuResult<()> {
        keys::post_key(app, chord)
    }

    fn post_text(&self, app: &RunningApp, text: &str) -> CuResult<()> {
        keys::post_text(app, text)
    }

    fn capture_window(
        &self,
        app: &RunningApp,
        window: &WindowInfo,
        deadline: Deadline,
    ) -> Result<Screenshot, ScreenshotOmitted> {
        capture::capture_window(app, window, deadline)
    }

    fn is_locked(&self) -> bool {
        session::is_locked()
    }

    fn set_monitor(&self, armed: bool, targets: Vec<MonitorTarget>) {
        self.monitor.set(armed, targets);
    }

    fn enable_web_accessibility(&self, app: &RunningApp) -> CuResult<bool> {
        self.web.enable(app)
    }

    fn restore_web_accessibility(&self, app: &RunningApp) {
        self.web.restore(app);
    }
}
