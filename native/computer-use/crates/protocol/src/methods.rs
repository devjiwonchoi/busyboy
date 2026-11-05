//! Typed params and results for every protocol method.

use serde::{Deserialize, Serialize};

/// Method names. Notifications are marked.
pub mod method {
    pub const HELLO: &str = "hello";
    pub const PERMISSIONS_STATUS: &str = "permissions.status";
    pub const PERMISSIONS_REQUEST: &str = "permissions.request";
    pub const APPS_LIST: &str = "apps.list";
    pub const APPS_RESOLVE: &str = "apps.resolve";
    pub const APP_STATE: &str = "app.state";
    pub const APP_ACT: &str = "app.act";
    pub const SESSION_BEGIN: &str = "session.begin";
    pub const SESSION_END: &str = "session.end";
    pub const CANCEL: &str = "cancel";
    /// Notification.
    pub const STOPPED: &str = "stopped";
    /// Notification.
    pub const LOCK_CHANGED: &str = "lock_changed";
}

/// Default and maximum per-request deadline.
pub const DEFAULT_DEADLINE_MS: u64 = 10_000;
pub const MAX_DEADLINE_MS: u64 = 60_000;

// ---------------------------------------------------------------------------
// hello

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloParams {
    pub protocol_version: u32,
    pub client: String,
    #[serde(default)]
    pub client_version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResult {
    pub protocol_version: u32,
    /// The serving process, so a client that did not start it can still stop it.
    #[serde(default)]
    pub pid: u32,
    pub helper_version: String,
    pub platform: String,
    pub capabilities: Vec<String>,
}

// ---------------------------------------------------------------------------
// permissions

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantStatus {
    Granted,
    NotGranted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopMonitorStatus {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionsStatus {
    pub accessibility: GrantStatus,
    pub screen_recording: GrantStatus,
    pub stop_monitor: StopMonitorStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionKind {
    Accessibility,
    ScreenRecording,
    InputMonitoring,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionsRequestParams {
    pub kind: PermissionKind,
}

// ---------------------------------------------------------------------------
// apps

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForbiddenReason {
    PasswordManager,
    Terminal,
    Busyboy,
    SystemSecurity,
    PrivateWindow,
    UnidentifiedApp,
    ElevatedWindow,
    Automation,
    FileManager,
}

impl ForbiddenReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ForbiddenReason::PasswordManager => "password_manager",
            ForbiddenReason::Terminal => "terminal",
            ForbiddenReason::Busyboy => "busyboy",
            ForbiddenReason::SystemSecurity => "system_security",
            ForbiddenReason::PrivateWindow => "private_window",
            ForbiddenReason::UnidentifiedApp => "unidentified_app",
            ForbiddenReason::ElevatedWindow => "elevated_window",
            ForbiddenReason::Automation => "automation",
            ForbiddenReason::FileManager => "file_manager",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppsListParams {
    #[serde(default)]
    pub include_installed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<i32>,
    /// A regular (Dock-visible) app.
    #[serde(default)]
    pub regular: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forbidden: Option<ForbiddenReason>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppsListResult {
    pub apps: Vec<AppEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppsResolveParams {
    pub app: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedApp {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<i32>,
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forbidden: Option<ForbiddenReason>,
}

/// `{name, bundleId, pid}` carried by every state and action result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppIdentity {
    pub name: String,
    pub bundle_id: String,
    pub pid: i32,
}

// ---------------------------------------------------------------------------
// request context and sessions

/// Carried by every `app.state` / `app.act`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestContext {
    pub thread_id: String,
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<u64>,
    /// The experimental background pointer is on (setting `computerUseExperimentalPointer`).
    /// Off by default: no pointer event is ever posted and bounds stay out of the outline.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub experimental_pointer: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionParams {
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelParams {
    /// Id of the request to cancel. Absent cancels every in-flight request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<crate::RequestId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    UserEscape,
    UserInput,
    ScreenLocked,
    /// Server-side only: a client interrupted the turn.
    ClientStop,
}

impl StopReason {
    pub fn as_str(self) -> &'static str {
        match self {
            StopReason::UserEscape => "user_escape",
            StopReason::UserInput => "user_input",
            StopReason::ScreenLocked => "screen_locked",
            StopReason::ClientStop => "client_stop",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoppedNotification {
    pub thread_id: String,
    pub turn_id: String,
    pub reason: StopReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockChangedNotification {
    pub locked: bool,
}

// ---------------------------------------------------------------------------
// app.state

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateParams {
    #[serde(flatten)]
    pub context: RequestContext,
    pub app: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    #[serde(default)]
    pub include_screenshot: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_nodes: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSummary {
    pub id: String,
    /// Empty for private windows, whose titles are hidden.
    pub title: String,
    pub focused: bool,
    pub minimized: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub private: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Truncation {
    Nodes,
    Depth,
    Deadline,
    Size,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreenshotOmitted {
    ScreenRecordingNotGranted,
    DisabledInSettings,
    WindowMinimized,
    CaptureFailed,
    NotRequested,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    /// `image/jpeg` or `image/png`.
    pub mime_type: String,
    /// Base64 image bytes.
    pub data: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub app: AppIdentity,
    pub windows: Vec<WindowSummary>,
    pub window: String,
    pub snapshot: String,
    pub tree: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<Truncation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_ref: Option<String>,
    pub screenshot: Option<Screenshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot_omitted: Option<ScreenshotOmitted>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub launched: bool,
    /// The app took focus on its own during launch.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub focus_changed: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

// ---------------------------------------------------------------------------
// app.act

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseButton {
    #[default]
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrollAmount {
    Line,
    #[default]
    Page,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FillValue {
    Bool(bool),
    Number(f64),
    Text(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRange {
    pub start: usize,
    pub length: usize,
}

fn one() -> u32 {
    1
}

/// One action. `kind` selects the variant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Action {
    Click {
        #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
        element: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window: Option<String>,
        #[serde(default)]
        button: MouseButton,
        #[serde(default = "one")]
        count: u32,
    },
    Type {
        text: String,
        #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
        element: Option<String>,
        #[serde(default)]
        replace: bool,
    },
    Key {
        keys: String,
        #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
        element: Option<String>,
    },
    Scroll {
        #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
        element: Option<String>,
        direction: ScrollDirection,
        #[serde(default)]
        amount: ScrollAmount,
        #[serde(default = "one")]
        times: u32,
    },
    Fill {
        #[serde(rename = "ref")]
        element: String,
        value: FillValue,
    },
    Select {
        #[serde(rename = "ref")]
        element: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        option: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        range: Option<TextRange>,
    },
    Menu {
        path: Vec<String>,
    },
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppActParams {
    #[serde(flatten)]
    pub context: RequestContext,
    pub app: String,
    pub action: Action,
    #[serde(default = "yes")]
    pub return_state: bool,
}

/// What changed after an action. Absent fields mean "not observed".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub value_changed: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub selection_changed: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub focus_changed: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub new_window: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub menu_opened: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub window_closed: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub tree_changed: bool,
}

impl Effect {
    pub fn any(&self) -> bool {
        self.value_changed
            || self.selection_changed
            || self.focus_changed
            || self.new_window
            || self.menu_opened
            || self.window_closed
            || self.tree_changed
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActResult {
    pub app: AppIdentity,
    pub verified: bool,
    pub effect: Effect,
    /// How the action was delivered, e.g. `ax_press`, `ax_value`, `ax_selected_text`, `keys`.
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<AppState>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn act_params_round_trip_with_flattened_context() {
        let params: AppActParams = serde_json::from_value(json!({
            "threadId": "t", "turnId": "u", "deadlineMs": 5000,
            "app": "TextEdit",
            "action": {"kind": "click", "ref": "e4"},
        }))
        .unwrap();
        assert_eq!(params.context.turn_id, "u");
        assert!(!params.context.experimental_pointer, "old clients leave the pointer off");
        assert!(params.return_state);
        assert_eq!(
            params.action,
            Action::Click { element: Some("e4".into()), x: None, y: None, window: None, button: MouseButton::Left, count: 1 }
        );

        let fill: Action = serde_json::from_value(json!({"kind": "fill", "ref": "e2", "value": 3})).unwrap();
        assert_eq!(fill, Action::Fill { element: "e2".into(), value: FillValue::Number(3.0) });

        let scroll = serde_json::to_value(Action::Scroll {
            element: None,
            direction: ScrollDirection::Down,
            amount: ScrollAmount::Page,
            times: 2,
        })
        .unwrap();
        assert_eq!(scroll, json!({"kind": "scroll", "direction": "down", "amount": "page", "times": 2}));
    }

    #[test]
    fn experimental_pointer_is_optional_and_omitted_when_off() {
        let on: RequestContext =
            serde_json::from_value(json!({"threadId": "t", "turnId": "u", "experimentalPointer": true})).unwrap();
        assert!(on.experimental_pointer);
        assert_eq!(serde_json::to_value(&on).unwrap()["experimentalPointer"], true);

        let off = RequestContext { experimental_pointer: false, ..on };
        assert_eq!(serde_json::to_value(off).unwrap(), json!({"threadId": "t", "turnId": "u"}));
    }

    #[test]
    fn state_serializes_null_screenshot_with_reason() {
        let state = AppState {
            app: AppIdentity { name: "TextEdit".into(), bundle_id: "com.apple.TextEdit".into(), pid: 1 },
            windows: vec![],
            window: "w1".into(),
            snapshot: "s1".into(),
            tree: String::new(),
            truncated: None,
            focused_ref: None,
            screenshot: None,
            screenshot_omitted: Some(ScreenshotOmitted::ScreenRecordingNotGranted),
            launched: false,
            focus_changed: false,
            notes: vec![],
        };
        let json = serde_json::to_value(state).unwrap();
        assert_eq!(json["screenshot"], serde_json::Value::Null);
        assert_eq!(json["screenshotOmitted"], "screen_recording_not_granted");
    }
}
