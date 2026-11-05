//! Chromium/Electron web-content accessibility enablement, recorded and restored.
//!
//! Chromium and Electron build their web-content AX tree only after an assistive
//! client asks. We set `AXManualAccessibility` (Electron's documented opt-in) on the
//! application element, and fall back to `AXEnhancedUserInterface` only when the app
//! does not support the first. The previous value is recorded per process lifetime
//! (pid + start time) before anything changes, so `restore` can put it back.
//! The settle/backoff loop and the idle restore live in the core engine.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use cu_core::platform::{ProcessRef, RunningApp, unsupported};
use cu_core::{CuResult, Deadline};

use crate::ax::{self, AxElement, AxFailure, AxResult};

pub const MANUAL_ACCESSIBILITY: &str = "AXManualAccessibility";
pub const ENHANCED_USER_INTERFACE: &str = "AXEnhancedUserInterface";

/// Budget for one enable or restore (a few AX calls on the app element).
const CALL_BUDGET: Duration = Duration::from_millis(1_000);

/// How long after enabling an empty web area still counts as "not ready yet", so
/// the engine's settle loop keeps retrying. Matches the engine's 2 s settle cap.
pub const SETTLE_WINDOW: Duration = Duration::from_secs(2);

/// What we changed for one process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Record {
    attribute: &'static str,
    /// Value before we changed it. `None` when the attribute had no value.
    previous: Option<bool>,
    enabled_at: Instant,
}

#[derive(Default)]
struct State {
    records: HashMap<ProcessRef, Record>,
    /// Whether the app accepts `AXManualAccessibility`, probed once per process.
    opt_in: HashMap<ProcessRef, bool>,
}

#[derive(Default)]
pub struct WebAccess {
    state: Mutex<State>,
}

impl WebAccess {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Turns web-content accessibility on. Returns `Ok(true)` when a value changed,
    /// `Ok(false)` when it was already on (or already enabled by us).
    pub fn enable(&self, app: &RunningApp) -> CuResult<bool> {
        if self.is_enabled(app) {
            return Ok(false);
        }
        let deadline = Deadline::after(CALL_BUDGET);
        let element = AxElement::application(app.process.pid);

        match self.try_enable(app.process, &element, MANUAL_ACCESSIBILITY, deadline) {
            Ok(changed) => return Ok(changed),
            // Only a missing attribute justifies the fallback; a busy app does not.
            Err(AxFailure::Unsupported | AxFailure::NoValue) => {}
            Err(failure) => return Err(failure.to_error("web accessibility")),
        }
        self.try_enable(app.process, &element, ENHANCED_USER_INTERFACE, deadline).map_err(|failure| match failure {
            AxFailure::Unsupported | AxFailure::NoValue => {
                unsupported("web_accessibility_unavailable", "the app does not expose web content accessibility")
            }
            failure => failure.to_error("web accessibility"),
        })
    }

    /// Records the previous value, writes `true`, and confirms by reading back.
    fn try_enable(
        &self,
        process: ProcessRef,
        element: &AxElement,
        attribute: &'static str,
        deadline: Deadline,
    ) -> AxResult<bool> {
        let previous = match element.bool(attribute, deadline) {
            Ok(value) => value,
            // Some builds accept the write but do not answer reads.
            Err(AxFailure::Unsupported | AxFailure::NoValue) => None,
            Err(failure) => return Err(failure),
        };
        // Record before writing, so a write that lands but reports an error can
        // still be undone.
        self.lock().records.insert(process, Record { attribute, previous, enabled_at: Instant::now() });
        if previous == Some(true) {
            return Ok(false);
        }

        let written = element.set_attr(attribute, ax::as_cf(&ax::cf_bool(true)), deadline);
        let readback = element.bool(attribute, deadline).ok().flatten();
        if enable_confirmed(&written, readback) {
            return Ok(true);
        }
        self.lock().records.remove(&process);
        Err(written.err().unwrap_or(AxFailure::Unsupported))
    }

    /// Writes back the recorded value (or `false` when the attribute was absent) and
    /// forgets it. No-op when nothing was recorded for this process.
    pub fn restore(&self, app: &RunningApp) {
        let record = {
            let mut state = self.lock();
            // Drop records of earlier processes that reused this pid.
            state.records.retain(|process, _| process.pid != app.process.pid || *process == app.process);
            state.records.remove(&app.process)
        };
        let Some(record) = record else {
            return;
        };
        if record.previous == Some(true) {
            return; // We changed nothing.
        }
        let element = AxElement::application(app.process.pid);
        let value = ax::cf_bool(record.previous.unwrap_or(false));
        // Best effort: if the app quit, the flag is gone with it.
        let _ = element.set_attr(record.attribute, ax::as_cf(&value), Deadline::after(CALL_BUDGET));
    }

    /// We enabled (or found enabled) web accessibility for this process.
    pub fn is_enabled(&self, app: &RunningApp) -> bool {
        self.lock().records.contains_key(&app.process)
    }

    /// We enabled it less than [`SETTLE_WINDOW`] ago, so an empty web area may
    /// still be filling in.
    pub fn is_settling(&self, app: &RunningApp) -> bool {
        self.lock().records.get(&app.process).is_some_and(|record| record.enabled_at.elapsed() < SETTLE_WINDOW)
    }

    /// Whether the app accepts Electron's `AXManualAccessibility` opt-in. One
    /// `AXUIElementIsAttributeSettable` call per process, then cached. Timeouts are
    /// not cached.
    pub fn exposes_opt_in(&self, app: &RunningApp, deadline: Deadline) -> bool {
        if let Some(known) = self.lock().opt_in.get(&app.process) {
            return *known;
        }
        let element = AxElement::application(app.process.pid);
        let exposed = match element.is_settable(MANUAL_ACCESSIBILITY, deadline) {
            Ok(settable) => settable,
            Err(AxFailure::Timeout) => return false,
            Err(_) => false,
        };
        let mut state = self.lock();
        state.opt_in.retain(|process, _| process.pid != app.process.pid);
        state.opt_in.insert(app.process, exposed);
        exposed
    }
}

/// A write counts when the read-back says `true`, or when the write succeeded and
/// the attribute cannot be read back. Some apps report an error yet apply the
/// value, so an explicit `true` read-back always wins.
fn enable_confirmed(written: &AxResult<()>, readback: Option<bool>) -> bool {
    match readback {
        Some(value) => value,
        None => written.is_ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(pid: i32, start_time: u64) -> RunningApp {
        RunningApp { name: "Electron".into(), bundle_id: "com.example.app".into(), process: ProcessRef { pid, start_time } }
    }

    fn record(previous: Option<bool>, enabled_at: Instant) -> Record {
        Record { attribute: MANUAL_ACCESSIBILITY, previous, enabled_at }
    }

    #[test]
    fn readback_decides_whether_enable_landed() {
        assert!(enable_confirmed(&Ok(()), Some(true)));
        assert!(enable_confirmed(&Ok(()), None));
        assert!(enable_confirmed(&Err(AxFailure::Unsupported), Some(true)));
        assert!(!enable_confirmed(&Ok(()), Some(false)));
        assert!(!enable_confirmed(&Err(AxFailure::Unsupported), None));
    }

    #[test]
    fn records_are_keyed_by_process_lifetime() {
        let web = WebAccess::default();
        let first = app(42, 1);
        web.lock().records.insert(first.process, record(Some(true), Instant::now()));
        assert!(web.is_enabled(&first));
        assert!(web.is_settling(&first));
        assert!(!web.is_enabled(&app(42, 2)), "a reused pid is a different process");

        // The value was already on: restore writes nothing and forgets the record.
        web.restore(&first);
        assert!(!web.is_enabled(&first));
        web.restore(&first); // nothing recorded: no-op
    }

    #[test]
    fn settling_ends_after_the_window() {
        let web = WebAccess::default();
        let target = app(7, 1);
        let long_ago = Instant::now() - SETTLE_WINDOW - Duration::from_millis(1);
        web.lock().records.insert(target.process, record(None, long_ago));
        assert!(web.is_enabled(&target));
        assert!(!web.is_settling(&target));
    }
}
