//! Request handling on top of a [`Platform`]: policy checks, sessions, refs, the
//! action ordering, verification, and stop handling.

mod act;
mod state;
mod verify;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use cu_protocol::{
    AppEntry, AppsListParams, AppsListResult, AppsResolveParams, CancelParams, ErrorCode, ErrorObject, ForbiddenReason,
    HelloParams, HelloResult, LockChangedNotification, Notification, PROTOCOL_VERSION, PermissionsRequestParams,
    RequestContext, RequestId, ResolvedApp, SessionParams, StopReason, StoppedNotification, method,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::deadline::{CancelReason, CancelToken, Deadline, screen_locked_error};
use crate::forbidden::forbidden_reason;
use crate::platform::{MonitorTarget, Platform, PlatformEvent, RunningApp};
use crate::refs::RefTable;
use crate::CuResult;

/// Web-content accessibility left on for this long without use is restored.
pub const WEB_ACCESSIBILITY_IDLE: Duration = Duration::from_secs(60);

/// Per-call limits for each try at reading an app's windows. A background app
/// that macOS has slowed down (App Nap, a hidden app) can need more than the
/// usual 250 ms to answer the first call, so later tries wait longer. Every try
/// stays within the request deadline.
const WINDOW_READ_CAPS: [Duration; 3] =
    [crate::deadline::MAX_CALL_TIMEOUT, Duration::from_millis(1_000), Duration::from_millis(2_500)];

pub type Notifier = Arc<dyn Fn(Notification) + Send + Sync>;

/// Per-app state, locked for the whole of a request so actions on one app run serially.
pub(crate) struct AppSlot<E> {
    pub refs: RefTable<E>,
    pub snapshots: u64,
}

pub(crate) type SharedSlot<E> = Arc<Mutex<AppSlot<E>>>;

struct TurnState {
    thread_id: String,
    stopped: Option<StopReason>,
    /// Operated apps by pid, for the user-input stop rule.
    targets: HashMap<i32, MonitorTarget>,
}

struct Inflight {
    /// The connection that sent the request, so ids from different clients never collide.
    client: u64,
    id: RequestId,
    turn_id: Option<String>,
    cancel: CancelToken,
}

struct WebAccessibilityUse {
    app: RunningApp,
    last_used: Instant,
    turns: HashSet<String>,
}

#[derive(Default)]
struct EngineState {
    turns: HashMap<String, TurnState>,
    /// Keyed by an internal sequence number; request ids are only unique per client.
    inflight: HashMap<u64, Inflight>,
    next_inflight: u64,
    web_accessibility: HashMap<String, WebAccessibilityUse>,
}

pub struct Engine<P: Platform> {
    pub(crate) platform: Arc<P>,
    helper_version: String,
    notifier: Notifier,
    state: Mutex<EngineState>,
    /// Serializes computing and applying the monitor state so updates never land out of order.
    monitor: Mutex<()>,
    apps: Mutex<HashMap<String, SharedSlot<P::Element>>>,
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn parse<T: DeserializeOwned>(params: Value) -> CuResult<T> {
    let params = if params.is_null() { json!({}) } else { params };
    serde_json::from_value(params)
        .map_err(|error| ErrorObject::new(ErrorCode::InvalidArgument, format!("invalid params: {error}")))
}

fn to_value<T: Serialize>(value: T) -> CuResult<Value> {
    serde_json::to_value(value).map_err(|error| ErrorObject::new(ErrorCode::InternalError, error.to_string()))
}

pub(crate) fn forbidden_error(reason: ForbiddenReason) -> ErrorObject {
    let message = match reason {
        ForbiddenReason::PasswordManager => "password managers are off limits for computer use",
        ForbiddenReason::Terminal => "terminal apps are off limits for computer use",
        ForbiddenReason::Busyboy => "BusyBoy itself is off limits for computer use",
        ForbiddenReason::SystemSecurity => "system security surfaces are off limits for computer use",
        ForbiddenReason::PrivateWindow => "private browsing windows are off limits for computer use",
        ForbiddenReason::UnidentifiedApp => "this app has no bundle identifier, so it cannot be approved",
        ForbiddenReason::ElevatedWindow => "elevated windows are off limits for computer use",
    };
    ErrorObject::with_reason(ErrorCode::AppForbidden, reason.as_str(), message)
}

impl<P: Platform> Engine<P> {
    pub fn new(platform: Arc<P>, helper_version: impl Into<String>, notifier: Notifier) -> Arc<Self> {
        let engine = Arc::new(Engine {
            platform,
            helper_version: helper_version.into(),
            notifier,
            state: Mutex::new(EngineState::default()),
            monitor: Mutex::new(()),
            apps: Mutex::new(HashMap::new()),
        });
        let weak: Weak<Self> = Arc::downgrade(&engine);
        engine.platform.set_event_sink(Arc::new(move |event| {
            if let Some(engine) = weak.upgrade() {
                engine.handle_event(event);
            }
        }));
        engine
    }

    pub fn platform(&self) -> &P {
        &self.platform
    }

    /// Handles `hello`. A version mismatch returns `version_mismatch`; the caller closes.
    pub fn hello(&self, params: Value) -> CuResult<Value> {
        let params: HelloParams = parse(params)?;
        if params.protocol_version != PROTOCOL_VERSION {
            return Err(ErrorObject::new(
                ErrorCode::VersionMismatch,
                format!("helper speaks protocol {PROTOCOL_VERSION}, client sent {}", params.protocol_version),
            )
            .with_details(json!({ "helperProtocolVersion": PROTOCOL_VERSION })));
        }

        let mut capabilities = vec![
            "accessibility_tree".to_owned(),
            "element_actions".to_owned(),
            "process_keys".to_owned(),
            "menus".to_owned(),
            "window_capture".to_owned(),
            "stop_monitor".to_owned(),
            "lock_detection".to_owned(),
            "web_accessibility".to_owned(),
        ];
        capabilities.extend(self.platform.capabilities());
        to_value(HelloResult {
            pid: std::process::id(),
            protocol_version: PROTOCOL_VERSION,
            helper_version: self.helper_version.clone(),
            platform: self.platform.name().to_owned(),
            capabilities,
        })
    }

    /// Handles every method except `hello`. `client` identifies the connection; request ids
    /// and `cancel` are scoped to it.
    pub fn handle(&self, client: u64, id: &RequestId, method_name: &str, params: Value) -> CuResult<Value> {
        match method_name {
            method::PERMISSIONS_STATUS => to_value(self.platform.permissions()),
            method::PERMISSIONS_REQUEST => {
                let params: PermissionsRequestParams = parse(params)?;
                self.platform.request_permission(params.kind)?;
                to_value(self.platform.permissions())
            }
            method::APPS_LIST => {
                let params: AppsListParams = parse(params)?;
                let apps = self.platform.list_apps(params.include_installed)?;
                let apps = apps
                    .into_iter()
                    .map(|app| AppEntry { forbidden: forbidden_reason(app.bundle_id.as_deref()), ..app })
                    .collect();
                to_value(AppsListResult { apps })
            }
            method::APPS_RESOLVE => {
                let params: AppsResolveParams = parse(params)?;
                let target = self.platform.resolve_app(&params.app)?;
                to_value(ResolvedApp {
                    forbidden: forbidden_reason(target.bundle_id.as_deref()),
                    bundle_id: target.bundle_id,
                    name: target.name,
                    pid: target.process.map(|process| process.pid),
                    running: target.process.is_some(),
                })
            }
            method::SESSION_BEGIN => {
                let params: SessionParams = parse(params)?;
                self.begin_session(params);
                Ok(json!({}))
            }
            method::SESSION_END => {
                let params: SessionParams = parse(params)?;
                self.end_session(&params.turn_id);
                Ok(json!({}))
            }
            method::CANCEL => {
                let params: CancelParams = parse(params)?;
                let cancelled = self.cancel_client(client, params.request_id.as_ref(), CancelReason::ClientStop);
                Ok(json!({ "cancelled": cancelled }))
            }
            method::APP_STATE => {
                let params: cu_protocol::AppStateParams = parse(params)?;
                let (token, cancel) = self.register(client, id, Some(&params.context.turn_id));
                let result = self.app_state(params, &cancel);
                self.unregister(token);
                to_value(result?)
            }
            method::APP_ACT => {
                let params: cu_protocol::AppActParams = parse(params)?;
                let (token, cancel) = self.register(client, id, Some(&params.context.turn_id));
                let result = self.app_act(params, &cancel);
                self.unregister(token);
                to_value(result?)
            }
            other => Err(ErrorObject::with_reason(
                ErrorCode::InvalidArgument,
                "unknown_method",
                format!("unknown method {other:?}"),
            )),
        }
    }

    // -- in-flight requests --------------------------------------------------

    fn register(&self, client: u64, id: &RequestId, turn_id: Option<&str>) -> (u64, CancelToken) {
        let cancel = CancelToken::new();
        let mut state = lock(&self.state);
        let token = state.next_inflight;
        state.next_inflight += 1;
        state.inflight.insert(
            token,
            Inflight { client, id: id.clone(), turn_id: turn_id.map(str::to_owned), cancel: cancel.clone() },
        );
        (token, cancel)
    }

    fn unregister(&self, token: u64) {
        lock(&self.state).inflight.remove(&token);
    }

    /// Cancels one of a client's requests, or all of them. Returns how many were cancelled.
    pub fn cancel_client(&self, client: u64, id: Option<&RequestId>, reason: CancelReason) -> usize {
        let state = lock(&self.state);
        let mut count = 0;
        for inflight in state.inflight.values() {
            if inflight.client == client && id.is_none_or(|id| *id == inflight.id) {
                inflight.cancel.cancel(reason);
                count += 1;
            }
        }
        count
    }

    // -- sessions ------------------------------------------------------------

    fn begin_session(&self, params: SessionParams) {
        {
            let mut state = lock(&self.state);
            state.turns.entry(params.turn_id).or_insert(TurnState {
                thread_id: params.thread_id,
                stopped: None,
                targets: HashMap::new(),
            });
        }
        self.sync_monitor();
    }

    fn end_session(&self, turn_id: &str) {
        let restore = {
            let mut state = lock(&self.state);
            state.turns.remove(turn_id);
            for inflight in state.inflight.values() {
                if inflight.turn_id.as_deref() == Some(turn_id) {
                    inflight.cancel.cancel(CancelReason::ClientStop);
                }
            }
            release_web_accessibility(&mut state, turn_id)
        };
        for app in restore {
            self.platform.restore_web_accessibility(&app);
        }
        self.sync_monitor();
    }

    /// Fails unless the turn has an active, unstopped session.
    pub(crate) fn check_turn(&self, context: &RequestContext) -> CuResult<()> {
        let state = lock(&self.state);
        let Some(turn) = state.turns.get(&context.turn_id) else {
            return Err(ErrorObject::new(ErrorCode::TurnInactive, "no computer-use session is active for this turn"));
        };
        if turn.thread_id != context.thread_id {
            return Err(ErrorObject::new(ErrorCode::TurnInactive, "the turn belongs to another thread"));
        }
        if let Some(reason) = turn.stopped {
            return Err(ErrorObject::with_reason(ErrorCode::Stopped, reason.as_str(), "computer use was stopped for this turn"));
        }
        Ok(())
    }

    /// Lock and cancellation guard, run before and between steps.
    pub(crate) fn guard(&self, cancel: &CancelToken) -> CuResult<()> {
        cancel.check()?;
        if self.platform.is_locked() {
            return Err(screen_locked_error());
        }
        Ok(())
    }

    /// The app's windows. Reads that time out are tried again with a longer
    /// per-call limit, so a slow first answer is not reported as a failure.
    pub(crate) fn read_windows(&self, app: &RunningApp, deadline: Deadline) -> CuResult<Vec<crate::tree::WindowInfo>> {
        let mut last_timeout = None;
        for cap in WINDOW_READ_CAPS {
            if deadline.expired() {
                break;
            }
            match self.platform.windows(app, deadline.with_call_cap(cap)) {
                Err(error) if error.code == ErrorCode::Timeout => last_timeout = Some(error),
                other => return other,
            }
        }
        Err(last_timeout.unwrap_or_else(|| crate::deadline::timeout_error("reading windows")))
    }

    pub(crate) fn require_accessibility(&self) -> CuResult<()> {
        if self.platform.permissions().accessibility != cu_protocol::GrantStatus::Granted {
            return Err(ErrorObject::new(ErrorCode::PermissionRequired, "Accessibility is not granted to BusyBoy Computer Use")
                .with_details(json!({ "missing": ["accessibility"] })));
        }
        Ok(())
    }

    /// Records the app as operated by the turn so user input in it stops the turn.
    pub(crate) fn mark_target(&self, turn_id: &str, target: MonitorTarget) {
        {
            let mut state = lock(&self.state);
            let Some(turn) = state.turns.get_mut(turn_id) else {
                return;
            };
            turn.targets.insert(target.pid, target);
        }
        self.sync_monitor();
    }

    fn sync_monitor(&self) {
        let _ordered = lock(&self.monitor);
        let (armed, targets) = {
            let state = lock(&self.state);
            let live: Vec<&TurnState> = state.turns.values().filter(|turn| turn.stopped.is_none()).collect();
            let targets = live.iter().flat_map(|turn| turn.targets.values().cloned()).collect();
            (!live.is_empty(), targets)
        };
        self.platform.set_monitor(armed, targets);
    }

    // -- web content accessibility -------------------------------------------

    pub(crate) fn note_web_accessibility(&self, app: &RunningApp, turn_id: &str) {
        let mut state = lock(&self.state);
        let entry = state
            .web_accessibility
            .entry(app.bundle_id.clone())
            .or_insert_with(|| WebAccessibilityUse { app: app.clone(), last_used: Instant::now(), turns: HashSet::new() });
        entry.app = app.clone();
        entry.last_used = Instant::now();
        entry.turns.insert(turn_id.to_owned());
    }

    pub(crate) fn touch_web_accessibility(&self, app: &RunningApp, turn_id: &str) {
        let mut state = lock(&self.state);
        if let Some(entry) = state.web_accessibility.get_mut(&app.bundle_id) {
            entry.last_used = Instant::now();
            entry.turns.insert(turn_id.to_owned());
        }
    }

    /// Periodic housekeeping: restores web-content accessibility idle for 60 s.
    pub fn tick(&self) {
        let restore: Vec<RunningApp> = {
            let mut state = lock(&self.state);
            let idle: Vec<String> = state
                .web_accessibility
                .iter()
                .filter(|(_, entry)| entry.last_used.elapsed() >= WEB_ACCESSIBILITY_IDLE)
                .map(|(bundle_id, _)| bundle_id.clone())
                .collect();
            idle.iter().filter_map(|bundle_id| state.web_accessibility.remove(bundle_id)).map(|entry| entry.app).collect()
        };
        for app in restore {
            self.platform.restore_web_accessibility(&app);
        }
    }

    /// Best-effort cleanup on helper shutdown.
    pub fn shutdown(&self) {
        let restore: Vec<RunningApp> = {
            let mut state = lock(&self.state);
            for inflight in state.inflight.values() {
                inflight.cancel.cancel(CancelReason::ClientStop);
            }
            state.turns.clear();
            state.web_accessibility.drain().map(|(_, entry)| entry.app).collect()
        };
        for app in restore {
            self.platform.restore_web_accessibility(&app);
        }
        self.platform.set_monitor(false, Vec::new());
    }

    // -- platform events -----------------------------------------------------

    pub fn handle_event(&self, event: PlatformEvent) {
        match event {
            PlatformEvent::Escape => self.stop_turns(StopReason::UserEscape, |_| true),
            PlatformEvent::UserInput { pid } => {
                self.stop_turns(StopReason::UserInput, |turn| turn.targets.contains_key(&pid));
            }
            PlatformEvent::LockChanged { locked } => {
                self.notify(method::LOCK_CHANGED, LockChangedNotification { locked });
                if locked {
                    self.lock_turns();
                }
            }
        }
    }

    /// Stops matching live turns: marks them stopped, cancels their requests, restores
    /// web-content accessibility, and notifies the desktop.
    fn stop_turns(&self, reason: StopReason, matches: impl Fn(&TurnState) -> bool) {
        let cancel_reason = match reason {
            StopReason::UserEscape => CancelReason::UserEscape,
            StopReason::UserInput => CancelReason::UserInput,
            StopReason::ScreenLocked => CancelReason::ScreenLocked,
            StopReason::ClientStop => CancelReason::ClientStop,
        };
        let (stopped, restore) = {
            let mut state = lock(&self.state);
            let mut stopped = Vec::new();
            for (turn_id, turn) in state.turns.iter_mut() {
                if turn.stopped.is_none() && matches(turn) {
                    turn.stopped = Some(reason);
                    stopped.push(StoppedNotification { thread_id: turn.thread_id.clone(), turn_id: turn_id.clone(), reason });
                }
            }
            for inflight in state.inflight.values() {
                if stopped.iter().any(|turn| inflight.turn_id.as_deref() == Some(turn.turn_id.as_str())) {
                    inflight.cancel.cancel(cancel_reason);
                }
            }
            let mut restore = Vec::new();
            for turn in &stopped {
                restore.extend(release_web_accessibility(&mut state, &turn.turn_id));
            }
            (stopped, restore)
        };
        if stopped.is_empty() {
            return;
        }
        // Tell the desktop first: restoring web accessibility can be slow for hung apps.
        for notification in stopped {
            self.notify(method::STOPPED, notification);
        }
        self.sync_monitor();
        for app in restore {
            self.platform.restore_web_accessibility(&app);
        }
    }

    /// On lock: cancel in-flight work with `screen_locked` and tell the desktop for each
    /// live turn. Turns are not marked stopped, so calls work again after unlock.
    fn lock_turns(&self) {
        let notifications: Vec<StoppedNotification> = {
            let state = lock(&self.state);
            for inflight in state.inflight.values() {
                inflight.cancel.cancel(CancelReason::ScreenLocked);
            }
            state
                .turns
                .iter()
                .filter(|(_, turn)| turn.stopped.is_none())
                .map(|(turn_id, turn)| StoppedNotification {
                    thread_id: turn.thread_id.clone(),
                    turn_id: turn_id.clone(),
                    reason: StopReason::ScreenLocked,
                })
                .collect()
        };
        for notification in notifications {
            self.notify(method::STOPPED, notification);
        }
    }

    fn notify<T: Serialize>(&self, name: &str, params: T) {
        if let Ok(params) = serde_json::to_value(params) {
            (self.notifier)(Notification::new(name, params));
        }
    }

    // -- apps ----------------------------------------------------------------

    /// Resolves the app, applies the forbidden list, and launches it in the background
    /// when it is not running. Returns `(app, launched, focus_changed)`.
    pub(crate) fn target_app(&self, query: &str, deadline: Deadline) -> CuResult<(RunningApp, bool, bool)> {
        let target = self.platform.resolve_app(query)?;
        if let Some(reason) = forbidden_reason(target.bundle_id.as_deref()) {
            return Err(forbidden_error(reason));
        }
        let bundle_id = target.bundle_id.clone().unwrap_or_default();

        if let Some(process) = target.process
            && self.platform.process_start_time(process.pid) == Some(process.start_time)
        {
            return Ok((RunningApp { name: target.name, bundle_id, process }, false, false));
        }

        let outcome = self.platform.launch_app(&bundle_id, deadline.capped(Duration::from_secs(5)))?;
        Ok((outcome.app, true, outcome.focus_changed))
    }

    pub(crate) fn slot(&self, bundle_id: &str) -> SharedSlot<P::Element> {
        lock(&self.apps)
            .entry(bundle_id.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(AppSlot { refs: RefTable::default(), snapshots: 0 })))
            .clone()
    }
}

/// Removes the turn from web-accessibility users and returns apps nobody uses anymore.
fn release_web_accessibility(state: &mut EngineState, turn_id: &str) -> Vec<RunningApp> {
    let mut released = Vec::new();
    state.web_accessibility.retain(|_, entry| {
        entry.turns.remove(turn_id);
        if entry.turns.is_empty() {
            released.push(entry.app.clone());
            return false;
        }
        true
    });
    released
}



#[cfg(test)]
mod tests;
