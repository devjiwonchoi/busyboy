//! The operations every OS backend provides. The engine drives everything through
//! this trait so the policy, ordering, and refs stay platform-neutral.

use std::sync::Arc;

use cu_protocol::{
    AppEntry, ErrorCode, ErrorObject, FillValue, MouseButton, PermissionKind, PermissionsStatus, Screenshot,
    ScreenshotOmitted, ScrollAmount, ScrollDirection, TextRange,
};

use crate::keys::KeyChord;
use crate::tree::{ElementAction, NodeStates, RawTree, Rect, TreeBudget, WindowInfo};
use crate::{CancelToken, CuResult, Deadline};

/// An app as resolved from a user or model query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppTarget {
    pub name: String,
    pub bundle_id: Option<String>,
    /// Present when running.
    pub process: Option<ProcessRef>,
}

/// A running process, identified by pid plus start time so pid reuse is detectable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProcessRef {
    pub pid: i32,
    /// Opaque, monotonic per boot (e.g. microseconds since epoch).
    pub start_time: u64,
}

/// A running, identified app the engine operates on.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RunningApp {
    pub name: String,
    pub bundle_id: String,
    pub process: ProcessRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchOutcome {
    pub app: RunningApp,
    /// The app made itself frontmost during launch despite a background launch.
    pub focus_changed: bool,
}

/// Liveness of a retained element handle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ElementStatus {
    /// Still valid. `role` is the current role words, `pid` the owning process.
    Alive { role: String, pid: i32 },
    /// The handle reports an invalid element.
    Invalid,
}

/// Cheap read of one element, used for verification and policy.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ElementProbe {
    pub role: String,
    pub name: Option<String>,
    /// Full value text, `None` for secure fields or elements without a value.
    pub value: Option<String>,
    pub selected_range: Option<TextRange>,
    pub states: NodeStates,
    pub child_count: usize,
    pub actions: Vec<ElementAction>,
    /// The value attribute is writable.
    pub value_settable: bool,
    /// Id of the window that contains the element.
    pub window_id: Option<String>,
}

/// Observable state of a window before and after an action. Any difference counts
/// as an observed effect.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Fingerprint {
    pub window_ids: Vec<String>,
    /// Identity hash of the app's focused element.
    pub focused_element: Option<u64>,
    pub target: Option<ElementProbe>,
    pub parent_child_count: Option<usize>,
    /// A menu is open in the app.
    pub menu_open: bool,
    /// Cheap structural hash of the target window (e.g. direct child roles and counts).
    pub window_hash: u64,
}

/// What the stop monitor watches for one operated app.
#[derive(Debug, Clone, PartialEq)]
pub struct MonitorTarget {
    pub pid: i32,
    /// Screen frames of the windows being operated.
    pub frames: Vec<Rect>,
}

/// Physical input and session events reported by the backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformEvent {
    /// Esc key-down from the user, anywhere.
    Escape,
    /// The user clicked or typed into an operated app.
    UserInput { pid: i32 },
    LockChanged { locked: bool },
}

pub type EventSink = Arc<dyn Fn(PlatformEvent) + Send + Sync>;

/// Lock and cancellation check the engine hands to multi-event deliveries. Backends
/// call it before each event; an error stops the sequence (after any paired mouse-up).
pub type StepGuard<'a> = &'a dyn Fn() -> CuResult<()>;

/// How the experimental background pointer delivered its events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerRoute {
    /// The private window-server post path (reported as `pointer`).
    WindowServer,
    /// Public pid-targeted events, used when the private path is missing
    /// (reported as `pointer_public`).
    Public,
}

impl PointerRoute {
    /// The `method` reported in `app.act` results.
    pub fn method(self) -> &'static str {
        match self {
            PointerRoute::WindowServer => "pointer",
            PointerRoute::Public => "pointer_public",
        }
    }
}

pub fn unsupported(reason: &str, message: impl Into<String>) -> ErrorObject {
    ErrorObject::with_reason(ErrorCode::ActionUnsupported, reason, message)
}

/// One OS backend. Every method that talks to another process takes a deadline and
/// must bound each call by [`Deadline::call_timeout`].
pub trait Platform: Send + Sync + 'static {
    /// Retained native element handle.
    type Element: Clone + Send + Sync + 'static;

    /// Platform name reported in `hello` (`"macos"`).
    fn name(&self) -> &'static str;

    /// Extra capability names reported in `hello`.
    fn capabilities(&self) -> Vec<String>;

    /// Called once by the engine with the sink for stop-monitor and lock events.
    fn set_event_sink(&self, sink: EventSink);

    // -- permissions --------------------------------------------------------

    fn permissions(&self) -> PermissionsStatus;

    /// Shows the system prompt for one grant. Only the settings UI calls this.
    fn request_permission(&self, kind: PermissionKind) -> CuResult<()>;

    // -- apps ---------------------------------------------------------------

    /// Running GUI apps (regular apps first), plus installed apps when asked (max 300).
    fn list_apps(&self, include_installed: bool) -> CuResult<Vec<AppEntry>>;

    /// Resolves a display name or bundle ID. Ambiguous names return `app_not_found`
    /// with `details.candidates`.
    fn resolve_app(&self, query: &str) -> CuResult<AppTarget>;

    /// Current start time for `pid`, or `None` when the process is gone.
    fn process_start_time(&self, pid: i32) -> Option<u64>;

    /// Launches an installed app without activating it and waits for a window.
    fn launch_app(&self, bundle_id: &str, deadline: Deadline) -> CuResult<LaunchOutcome>;

    // -- windows and tree ---------------------------------------------------

    fn windows(&self, app: &RunningApp, deadline: Deadline) -> CuResult<Vec<WindowInfo>>;

    /// Localized names, in every language, of the System Settings panes where
    /// actions are refused. The English names always apply on top of these.
    fn security_pane_names(&self) -> &[String] {
        &[]
    }

    /// Walks one window within the budget. Stops at the deadline or cancellation and
    /// marks the tree truncated. Never activates the app or moves the pointer.
    fn snapshot(
        &self,
        app: &RunningApp,
        window: &WindowInfo,
        budget: &TreeBudget,
        deadline: Deadline,
        cancel: &CancelToken,
    ) -> CuResult<RawTree<Self::Element>>;

    /// Stable hash of an element's identity, for matching handles across snapshots.
    fn element_key(&self, element: &Self::Element) -> u64;

    /// Identity comparison of two handles.
    fn same_element(&self, a: &Self::Element, b: &Self::Element) -> bool;

    fn element_status(&self, element: &Self::Element, deadline: Deadline) -> ElementStatus;

    /// Cheap read of one element. `window_id` may be left `None`; use
    /// [`Platform::element_window_id`] when the window matters.
    fn probe(&self, element: &Self::Element, deadline: Deadline) -> CuResult<ElementProbe>;

    /// Id of the window containing the element (same scheme as [`Platform::windows`]).
    fn element_window_id(&self, element: &Self::Element, deadline: Deadline) -> Option<String>;

    fn parent(&self, element: &Self::Element, deadline: Deadline) -> Option<Self::Element>;

    fn children(&self, element: &Self::Element, deadline: Deadline) -> Vec<Self::Element>;

    /// The app's focused element, read without activating the app.
    fn focused_element(&self, app: &RunningApp, deadline: Deadline) -> Option<Self::Element>;

    /// Element at a screen point (points), restricted to the app.
    fn element_at(&self, app: &RunningApp, x: f64, y: f64, deadline: Deadline) -> Option<Self::Element>;

    /// `None` when the app did not answer (for example a timeout). A failed read
    /// must not look like a change: it is not a closed window or a lost focus.
    fn fingerprint(
        &self,
        app: &RunningApp,
        window: Option<&WindowInfo>,
        target: Option<&Self::Element>,
        deadline: Deadline,
    ) -> Option<Fingerprint>;

    // -- element actions ----------------------------------------------------

    fn perform(&self, element: &Self::Element, action: ElementAction, deadline: Deadline) -> CuResult<()>;

    fn set_value(&self, element: &Self::Element, value: &FillValue, deadline: Deadline) -> CuResult<()>;

    /// Replaces the selection (or inserts at the caret) with `text`.
    fn set_selected_text(&self, element: &Self::Element, text: &str, deadline: Deadline) -> CuResult<()>;

    /// Selects a text range in UTF-16 units.
    fn set_selected_range(&self, element: &Self::Element, range: TextRange, deadline: Deadline) -> CuResult<()>;

    fn set_selected(&self, element: &Self::Element, selected: bool, deadline: Deadline) -> CuResult<()>;

    /// Focuses the element within its app. Must not activate the app or raise windows.
    fn set_focused(&self, element: &Self::Element, deadline: Deadline) -> CuResult<()>;

    /// Scrolls a scroll area by moving its scroll bar or using page actions.
    fn scroll_area(
        &self,
        element: &Self::Element,
        direction: ScrollDirection,
        amount: ScrollAmount,
        deadline: Deadline,
    ) -> CuResult<()>;

    /// The main scroll area of a window, for scrolls without a ref.
    fn main_scroll_area(&self, app: &RunningApp, window: &WindowInfo, deadline: Deadline) -> Option<Self::Element>;

    /// Walks the menu bar by titles (matched with [`crate::text::menu_title_matches`])
    /// and presses the leaf. A disabled leaf is `action_unsupported` with reason
    /// `menu_item_disabled`; a missing title is `action_unsupported` with reason
    /// `menu_item_not_found` and `details.available`.
    fn press_menu_path(&self, app: &RunningApp, path: &[String], deadline: Deadline) -> CuResult<()>;

    // -- keys ---------------------------------------------------------------

    /// Posts one chord to the process only (never globally), tagged as ours.
    fn post_key(&self, app: &RunningApp, chord: &KeyChord) -> CuResult<()>;

    /// Posts Unicode text (≤ 20 UTF-16 units) to the process only, tagged as ours.
    fn post_text(&self, app: &RunningApp, text: &str) -> CuResult<()>;

    // -- capture ------------------------------------------------------------

    /// One window as an image at point resolution, long edge ≤ 1,600 px. Never prompts.
    fn capture_window(&self, app: &RunningApp, window: &WindowInfo, deadline: Deadline)
    -> Result<Screenshot, ScreenshotOmitted>;

    // -- session guards -----------------------------------------------------

    fn is_locked(&self) -> bool;

    /// Arms the stop monitor for these targets, or disarms it with an empty list
    /// and `armed == false`. While armed, Esc anywhere is reported even with no targets.
    fn set_monitor(&self, armed: bool, targets: Vec<MonitorTarget>);

    // -- web content accessibility -----------------------------------------

    /// Turns on web-content accessibility for the app and records the previous value.
    /// Returns `true` when something was changed.
    fn enable_web_accessibility(&self, app: &RunningApp) -> CuResult<bool>;

    /// Restores the recorded value. No-op when nothing was recorded.
    fn restore_web_accessibility(&self, app: &RunningApp);

    // -- experimental pointer (off unless the backend supports it) ----------
    //
    // Risk note for the settings description: this uses an undocumented (private)
    // macOS API, may stop working after a macOS update, and some apps (games, 3D
    // views, canvas engines) ignore background clicks entirely.
    //
    // The engine calls these only when the request has `experimentalPointer` on. They
    // never move the cursor, activate the app, raise windows, or post global events.

    /// Screen frame of an element in points, used to aim the pointer at its centre.
    fn element_frame(&self, _element: &Self::Element, _deadline: Deadline) -> Option<Rect> {
        None
    }

    /// Background click at a window-local point (points, top-left origin).
    /// `count` is 1 or 2. Stops with `action_unsupported` (reason `window_changed`)
    /// when the window moves or changes owner between events.
    #[allow(clippy::too_many_arguments)]
    fn pointer_click(
        &self,
        _app: &RunningApp,
        _window: &WindowInfo,
        _x: f64,
        _y: f64,
        _button: MouseButton,
        _count: u32,
        _guard: StepGuard<'_>,
    ) -> CuResult<PointerRoute> {
        Err(unsupported("pointer_unavailable", "background pointer clicks are not available"))
    }

    /// Background scroll-wheel events at a window-local point, `times` notches (or
    /// pages) in `direction`. Same rules as [`Platform::pointer_click`].
    #[allow(clippy::too_many_arguments)]
    fn pointer_scroll(
        &self,
        _app: &RunningApp,
        _window: &WindowInfo,
        _x: f64,
        _y: f64,
        _direction: ScrollDirection,
        _amount: ScrollAmount,
        _times: u32,
        _guard: StepGuard<'_>,
    ) -> CuResult<PointerRoute> {
        Err(unsupported("pointer_unavailable", "background pointer scrolling is not available"))
    }
}
