//! `app.state`: window choice, tree walk with web-content enablement, refs, outline,
//! and the optional screenshot.

use std::time::{Duration, Instant};

use cu_protocol::{
    AppIdentity, AppState, AppStateParams, ErrorCode, ErrorObject, ForbiddenReason, ScreenshotOmitted, WindowSummary,
};

use super::{AppSlot, Engine, forbidden_error};
use crate::deadline::{CancelToken, Deadline};
use crate::outline::{layout, render_lines, truncation};
use crate::platform::{Platform, RunningApp};
use crate::refs::{NewRef, format_ref};
use crate::tree::{RawTree, TreeBudget, WindowInfo};
use crate::CuResult;

/// Settle delays while waiting for web content to appear (total ≤ 2 s).
const WEB_SETTLE_DELAYS_MS: [u64; 5] = [50, 100, 200, 400, 800];
pub const WEB_UNAVAILABLE_NOTE: &str = "web content accessibility not available";
pub const PRIVATE_WINDOW_TITLE: &str = "[private window hidden]";

/// Options for one state capture.
pub(crate) struct CaptureOptions<'a> {
    pub budget: TreeBudget,
    pub include_screenshot: bool,
    pub turn_id: &'a str,
}

/// Chooses the window to read: the requested one, else the focused, main, or first
/// visible window. Private windows are never chosen implicitly.
pub(crate) fn pick_window<'a>(windows: &'a [WindowInfo], requested: Option<&str>) -> CuResult<&'a WindowInfo> {
    if let Some(id) = requested {
        let window = windows.iter().find(|window| window.id == id).ok_or_else(|| {
            ErrorObject::new(ErrorCode::WindowNotFound, format!("no window {id:?} in this app"))
        })?;
        if window.private {
            return Err(forbidden_error(ForbiddenReason::PrivateWindow));
        }
        return Ok(window);
    }

    if windows.is_empty() {
        return Err(ErrorObject::new(ErrorCode::WindowNotFound, "the app has no windows"));
    }
    let candidates: Vec<&WindowInfo> = windows.iter().filter(|window| !window.private).collect();
    candidates
        .iter()
        .find(|window| window.focused && !window.minimized)
        .or_else(|| candidates.iter().find(|window| window.main && !window.minimized))
        .or_else(|| candidates.iter().find(|window| !window.minimized))
        .or_else(|| candidates.first())
        .copied()
        .ok_or_else(|| forbidden_error(ForbiddenReason::PrivateWindow))
}

pub(crate) fn window_summaries(windows: &[WindowInfo]) -> Vec<WindowSummary> {
    windows
        .iter()
        .map(|window| WindowSummary {
            id: window.id.clone(),
            title: if window.private { PRIVATE_WINDOW_TITLE.to_owned() } else { window.title.clone() },
            focused: window.focused,
            minimized: window.minimized,
            private: window.private,
        })
        .collect()
}

pub(crate) fn identity(app: &RunningApp) -> AppIdentity {
    AppIdentity { name: app.name.clone(), bundle_id: app.bundle_id.clone(), pid: app.process.pid }
}

fn quote_title(title: &str) -> String {
    format!("{title:?}")
}

impl<P: Platform> Engine<P> {
    pub(crate) fn app_state(&self, params: AppStateParams, cancel: &CancelToken) -> CuResult<AppState> {
        let deadline = Deadline::from_ms(params.context.deadline_ms);
        self.check_turn(&params.context)?;
        self.guard(cancel)?;
        self.require_accessibility()?;

        let (app, launched, focus_changed) = self.target_app(&params.app, deadline)?;
        let slot = self.slot(&app.bundle_id);
        let mut slot = super::lock(&slot);
        self.guard(cancel)?;

        let windows = self.platform.windows(&app, deadline)?;
        let window = pick_window(&windows, params.window.as_deref())?.clone();
        let options = CaptureOptions {
            budget: TreeBudget::with_overrides(params.max_nodes, params.max_depth),
            include_screenshot: params.include_screenshot,
            turn_id: &params.context.turn_id,
        };
        let mut state = self.capture_state(&app, &mut slot, &windows, &window, &options, deadline, cancel)?;
        state.launched = launched;
        state.focus_changed = focus_changed;
        Ok(state)
    }

    /// Walks the window, assigns refs, renders the outline, and captures the screenshot.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn capture_state(
        &self,
        app: &RunningApp,
        slot: &mut AppSlot<P::Element>,
        windows: &[WindowInfo],
        window: &WindowInfo,
        options: &CaptureOptions<'_>,
        deadline: Deadline,
        cancel: &CancelToken,
    ) -> CuResult<AppState> {
        let mut notes = Vec::new();
        let tree = self.walk_with_web_settle(app, window, &options.budget, options.turn_id, deadline, cancel, &mut notes)?;
        self.guard(cancel)?;

        // Refs for every emitted line.
        let lines = layout(&tree);
        let new_refs = lines
            .iter()
            .map(|line| {
                let node = &tree.nodes[line.node];
                NewRef { handle: node.handle.clone(), key: self.platform.element_key(&node.handle), role: node.role.clone() }
            })
            .collect();
        let numbers = slot.refs.commit(app.process, &window.id, new_refs, |a, b| self.platform.same_element(a, b));
        slot.snapshots += 1;

        let rendered = render_lines(&tree, &lines, &numbers, None, options.budget.max_output);
        let focused_ref = lines
            .iter()
            .zip(&numbers)
            .take(rendered.emitted)
            .find(|(line, _)| tree.nodes[line.node].states.focused)
            .map(|(_, number)| format_ref(*number));
        let truncated = truncation(tree.truncated, rendered.size_truncated);

        let mut header = format!(
            "app: {} ({}) pid {} · window {} [{}]",
            app.name,
            app.bundle_id,
            app.process.pid,
            quote_title(&window.title),
            window.id
        );
        if let Some(focused) = &focused_ref {
            header.push_str(&format!(" · focused: {focused}"));
        }
        header.push('\n');
        if !tree.menus.is_empty() {
            header.push_str(&format!("menus: {}\n", tree.menus.join(", ")));
        }
        let mut text = header + &rendered.text;
        if let Some(reason) = truncated {
            text.push_str(&format!("… truncated ({})\n", serde_json::to_value(reason).unwrap_or_default().as_str().unwrap_or("")));
        }

        let (screenshot, screenshot_omitted) = if !options.include_screenshot {
            (None, Some(ScreenshotOmitted::NotRequested))
        } else if window.minimized {
            (None, Some(ScreenshotOmitted::WindowMinimized))
        } else if self.platform.permissions().screen_recording != cu_protocol::GrantStatus::Granted {
            (None, Some(ScreenshotOmitted::ScreenRecordingNotGranted))
        } else {
            match self.platform.capture_window(app, window, deadline) {
                Ok(image) => (Some(image), None),
                Err(reason) => (None, Some(reason)),
            }
        };

        Ok(AppState {
            app: identity(app),
            windows: window_summaries(windows),
            window: window.id.clone(),
            snapshot: format!("s{}", slot.snapshots),
            tree: text,
            truncated,
            focused_ref,
            screenshot,
            screenshot_omitted,
            launched: false,
            focus_changed: false,
            notes,
        })
    }

    /// Walks once; when web content is still hidden, enables web-content accessibility
    /// and walks again with backoff for up to 2 s.
    #[allow(clippy::too_many_arguments)]
    fn walk_with_web_settle(
        &self,
        app: &RunningApp,
        window: &WindowInfo,
        budget: &TreeBudget,
        turn_id: &str,
        deadline: Deadline,
        cancel: &CancelToken,
        notes: &mut Vec<String>,
    ) -> CuResult<RawTree<P::Element>> {
        let mut tree = self.platform.snapshot(app, window, budget, deadline, cancel)?;
        self.touch_web_accessibility(app, turn_id);
        if !tree.needs_web_accessibility {
            return Ok(tree);
        }

        match self.platform.enable_web_accessibility(app) {
            Ok(_) => self.note_web_accessibility(app, turn_id),
            Err(_) => {
                notes.push(WEB_UNAVAILABLE_NOTE.to_owned());
                return Ok(tree);
            }
        }

        let started = Instant::now();
        for delay in WEB_SETTLE_DELAYS_MS {
            if started.elapsed() + Duration::from_millis(delay) > Duration::from_secs(2)
                || deadline.remaining() <= Duration::from_millis(delay)
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(delay));
            self.guard(cancel)?;
            tree = self.platform.snapshot(app, window, budget, deadline, cancel)?;
            if !tree.needs_web_accessibility {
                return Ok(tree);
            }
        }
        notes.push(WEB_UNAVAILABLE_NOTE.to_owned());
        Ok(tree)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::Rect;

    fn window(id: &str, focused: bool, main: bool, minimized: bool, private: bool) -> WindowInfo {
        WindowInfo { id: id.into(), title: id.into(), bounds: Rect::default(), minimized, main, focused, private }
    }

    #[test]
    fn picks_focused_then_main_then_visible_windows() {
        let windows = vec![window("w1", false, false, true, false), window("w2", false, true, false, false), window("w3", true, false, false, false)];
        assert_eq!(pick_window(&windows, None).unwrap().id, "w3");
        assert_eq!(pick_window(&windows[..2], None).unwrap().id, "w2");
        assert_eq!(pick_window(&windows[..1], None).unwrap().id, "w1");
        assert_eq!(pick_window(&windows, Some("w1")).unwrap().id, "w1");
        assert_eq!(pick_window(&windows, Some("w9")).unwrap_err().code, ErrorCode::WindowNotFound);
        assert_eq!(pick_window(&[], None).unwrap_err().code, ErrorCode::WindowNotFound);
    }

    #[test]
    fn never_picks_private_windows() {
        let windows = vec![window("w1", true, true, false, true), window("w2", false, false, false, false)];
        assert_eq!(pick_window(&windows, None).unwrap().id, "w2");

        let error = pick_window(&windows, Some("w1")).unwrap_err();
        assert_eq!(error.code, ErrorCode::AppForbidden);
        assert_eq!(error.details.unwrap()["reason"], "private_window");
        assert_eq!(pick_window(&windows[..1], None).unwrap_err().code, ErrorCode::AppForbidden);

        let summaries = window_summaries(&windows);
        assert_eq!(summaries[0].title, PRIVATE_WINDOW_TITLE);
    }
}
