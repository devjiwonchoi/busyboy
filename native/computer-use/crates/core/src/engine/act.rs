//! `app.act`: the default delivery order per action, verification, and the returned state.
//!
//! Every path stays in the background: element actions and value writes first, then
//! keys posted to the target process only. Nothing moves the pointer or activates an app.
//! Pointer events are posted only when the request turns the experimental pointer on,
//! and only after the accessibility steps found no way to act.

use std::time::Duration;

use cu_protocol::{
    ActResult, Action, AppActParams, Effect, ErrorCode, ErrorObject, FillValue, ForbiddenReason, MouseButton, ScrollAmount,
    ScrollDirection, TextRange,
};
use serde_json::json;

use super::state::{CaptureOptions, identity, pick_window};
use super::verify::{effect_between, text_keys_landed};
use super::{AppSlot, Engine, forbidden_error};
use crate::deadline::{CancelToken, Deadline};
use crate::forbidden::is_security_pane;
use crate::keys::{Key, KeyChord, Modifiers, NamedKey, check_refused, parse_key_sequence};
use crate::platform::{ElementProbe, ElementStatus, MonitorTarget, Platform, RunningApp, unsupported};
use crate::refs::Lookup;
use crate::text::{menu_title_matches, utf16_chunks, utf16_find, utf16_len};
use crate::tree::{ElementAction, Rect, TreeBudget, WindowInfo, roles};
use crate::CuResult;

const MAX_TYPE_CHARS: usize = 10_000;
const KEY_CHUNK_UNITS: usize = 20;
const MAX_SCROLL_TIMES: u32 = 20;
const MAX_STEPS: usize = 100;
const ANCESTOR_LEVELS: usize = 3;

/// How an action was delivered, plus extra evidence beyond the fingerprint.
struct Delivery<E> {
    method: &'static str,
    /// The element to watch for changes.
    target: Option<E>,
    /// A read-back already confirmed the change.
    confirmed: bool,
    /// Text-editing keys went to a text element: only a text, selection, window,
    /// or menu change shows they landed.
    text_keys: bool,
    notes: Vec<String>,
}

impl<E> Delivery<E> {
    fn new(method: &'static str, target: Option<E>) -> Self {
        Delivery { method, target, confirmed: false, text_keys: false, notes: Vec::new() }
    }

    fn confirmed(mut self, confirmed: bool) -> Self {
        self.confirmed = confirmed;
        self
    }

    /// Whether the observed effect shows the action landed.
    fn landed(&self, effect: &Effect) -> bool {
        self.confirmed || if self.text_keys { text_keys_landed(effect) } else { effect.any() }
    }
}

fn invalid(message: &str) -> ErrorObject {
    ErrorObject::new(ErrorCode::InvalidArgument, message)
}

fn stale(message: &str) -> ErrorObject {
    ErrorObject::new(ErrorCode::StaleElement, message)
}

fn tried_unsupported(reason: &str, tried: &[&str], message: &str) -> ErrorObject {
    ErrorObject::new(ErrorCode::ActionUnsupported, message).with_details(json!({ "reason": reason, "tried": tried }))
}

/// Keys that move around without entering text.
fn is_navigation(chord: &KeyChord) -> bool {
    matches!(
        chord.key,
        Key::Named(
            NamedKey::Tab
                | NamedKey::Return
                | NamedKey::Enter
                | NamedKey::Escape
                | NamedKey::Up
                | NamedKey::Down
                | NamedKey::Left
                | NamedKey::Right
                | NamedKey::Home
                | NamedKey::End
                | NamedKey::PageUp
                | NamedKey::PageDown
        )
    ) && !chord.modifiers.cmd
        && !chord.modifiers.ctrl
}

/// Keys whose only job in a text element is to change its text, caret, or
/// selection: characters, delete, arrows, and cmd+a/x/v/z. Others (tab,
/// return, escape, other shortcuts) may rightly move focus or change the window.
fn edits_text(chord: &KeyChord) -> bool {
    let modifiers = chord.modifiers;
    if modifiers.ctrl || modifiers.function {
        return false;
    }
    match chord.key {
        Key::Char(character) if modifiers.cmd => !modifiers.alt && matches!(character, 'a' | 'x' | 'v' | 'z'),
        Key::Char(_) => true,
        Key::Named(key) => matches!(
            key,
            NamedKey::Space
                | NamedKey::Delete
                | NamedKey::ForwardDelete
                | NamedKey::Up
                | NamedKey::Down
                | NamedKey::Left
                | NamedKey::Right
                | NamedKey::Home
                | NamedKey::End
        ),
    }
}

fn is_text_role(role: &str) -> bool {
    matches!(role, roles::TEXT_FIELD | roles::TEXT_AREA | roles::COMBO_BOX)
}

fn is_row(role: &str) -> bool {
    matches!(role, roles::ROW | roles::OUTLINE_ROW | roles::CELL)
}

fn fill_matches(value: &FillValue, current: Option<&str>) -> bool {
    let Some(current) = current else {
        return false;
    };
    match value {
        FillValue::Text(text) => current == text,
        FillValue::Number(number) => current.trim().parse::<f64>().is_ok_and(|current| (current - number).abs() < 1e-6),
        FillValue::Bool(flag) => matches!((flag, current.trim()), (true, "1" | "true") | (false, "0" | "false")),
    }
}

/// Window-local centre of the part of `frame` (screen points) inside the window.
fn window_point(window: &WindowInfo, frame: Rect) -> CuResult<(f64, f64)> {
    let bounds = window.bounds;
    let left = frame.x.max(bounds.x);
    let top = frame.y.max(bounds.y);
    let right = (frame.x + frame.width).min(bounds.x + bounds.width);
    let bottom = (frame.y + frame.height).min(bounds.y + bounds.height);
    if right <= left || bottom <= top {
        return Err(unsupported("point_outside_window", "the element is outside its window"));
    }
    Ok(((left + right) / 2.0 - bounds.x, (top + bottom) / 2.0 - bounds.y))
}

impl<P: Platform> Engine<P> {
    pub(crate) fn app_act(&self, params: AppActParams, cancel: &CancelToken) -> CuResult<ActResult> {
        let deadline = Deadline::from_ms(params.context.deadline_ms);
        self.check_turn(&params.context)?;
        self.guard(cancel)?;
        self.require_accessibility()?;

        let (app, launched, _focus_changed) = self.target_app(&params.app, deadline)?;
        let slot = self.slot(&app.bundle_id);
        let mut slot = super::lock(&slot);
        self.guard(cancel)?;

        let windows = self.read_windows(&app, deadline)?;
        let target_window = self.action_window(&params.action, &slot, &windows)?;
        if let Some(window) = &target_window {
            if window.private {
                return Err(forbidden_error(ForbiddenReason::PrivateWindow));
            }
            if is_security_pane(&app.bundle_id, &window.title, self.platform.security_pane_names()) {
                return Err(forbidden_error(ForbiddenReason::SystemSecurity));
            }
            self.mark_target(&params.context.turn_id, MonitorTarget { pid: app.process.pid, frames: vec![window.bounds] });
        } else {
            self.mark_target(&params.context.turn_id, MonitorTarget { pid: app.process.pid, frames: Vec::new() });
        }

        let initial_target = self.initial_target(&params.action, &slot, &app, deadline)?;
        // Keys aimed at an element go to it, so focus it first. Doing that before
        // the first reading means the comparison shows what the keys did, not
        // our own focus move.
        if let (Action::Key { keys, element: Some(_) }, Some(target)) = (&params.action, &initial_target) {
            check_refused(&parse_key_sequence(keys)?)?;
            self.platform.set_focused(target, deadline)?;
        }
        let before = self.platform.fingerprint(&app, target_window.as_ref(), initial_target.as_ref(), deadline);

        let pointer = params.context.experimental_pointer;
        let mut delivery =
            self.deliver(&app, &slot, &windows, target_window.as_ref(), &params.action, pointer, deadline, cancel)?;
        self.guard(cancel)?;

        let watched = delivery.target.as_ref().or(initial_target.as_ref());
        let after = self.settle(&app, target_window.as_ref(), watched, deadline, cancel);
        self.guard(cancel)?;
        let effect = effect_between(before.as_ref(), after.as_ref());
        let verified = delivery.landed(&effect);
        if before.is_none() || after.is_none() {
            delivery.notes.push("the app did not answer while the result was checked, so changes are unknown".to_owned());
        }
        self.touch_web_accessibility(&app, &params.context.turn_id);

        let state = if params.return_state {
            let windows = self.read_windows(&app, deadline)?;
            let window = target_window
                .as_ref()
                .and_then(|window| windows.iter().find(|candidate| candidate.id == window.id && !candidate.private))
                .map(Ok)
                .unwrap_or_else(|| pick_window(&windows, None))?
                .clone();
            let options = CaptureOptions {
                budget: TreeBudget::default(),
                include_screenshot: false,
                turn_id: &params.context.turn_id,
                pointer,
            };
            let mut state = self.capture_state(&app, &mut slot, &windows, &window, &options, deadline, cancel)?;
            state.launched = launched;
            Some(state)
        } else {
            None
        };

        Ok(ActResult {
            app: identity(&app),
            verified,
            effect,
            method: delivery.method.to_owned(),
            state,
            notes: delivery.notes,
        })
    }

    /// The window an action applies to: a ref's window, the requested window, or the
    /// default window. `None` only when the app has no windows (e.g. menu-only actions).
    fn action_window(
        &self,
        action: &Action,
        slot: &AppSlot<P::Element>,
        windows: &[WindowInfo],
    ) -> CuResult<Option<WindowInfo>> {
        let reference = match action {
            Action::Click { element, .. }
            | Action::Type { element, .. }
            | Action::Key { element, .. }
            | Action::Scroll { element, .. } => element.as_deref(),
            Action::Fill { element, .. } | Action::Select { element, .. } => Some(element.as_str()),
            Action::Menu { .. } => None,
        };

        if let Some(reference) = reference {
            return match slot.refs.lookup(reference) {
                Lookup::Found(entry) => windows
                    .iter()
                    .find(|window| window.id == entry.window_id)
                    .cloned()
                    .map(Some)
                    .ok_or_else(|| stale("the element's window closed; call computer_snapshot again")),
                Lookup::Stale => Err(stale("the element ref is out of date; call computer_snapshot again")),
                Lookup::NotFound => Err(ErrorObject::new(
                    ErrorCode::ElementNotFound,
                    format!("{reference:?} is not a ref from this app's latest snapshots"),
                )),
            };
        }

        // Ref-less typing, keys, and menus go to whatever window has focus, so check that
        // window itself rather than falling back to another one.
        if matches!(action, Action::Menu { .. } | Action::Key { .. } | Action::Type { .. })
            && let Some(focused) = windows.iter().find(|window| window.focused)
        {
            return Ok(Some(focused.clone()));
        }

        let requested = match action {
            Action::Click { window, .. } => window.as_deref(),
            _ => None,
        };
        if requested.is_none()
            && windows.is_empty()
            && matches!(action, Action::Menu { .. } | Action::Key { .. } | Action::Type { .. })
        {
            return Ok(None);
        }
        pick_window(windows, requested).cloned().map(Some)
    }

    /// Resolves a ref to a live element, applying the staleness rules.
    fn resolve_ref(
        &self,
        slot: &AppSlot<P::Element>,
        app: &RunningApp,
        reference: &str,
        deadline: Deadline,
    ) -> CuResult<P::Element> {
        let entry = match slot.refs.lookup(reference) {
            Lookup::Found(entry) => entry,
            Lookup::Stale => return Err(stale("the element ref is out of date; call computer_snapshot again")),
            Lookup::NotFound => {
                return Err(ErrorObject::new(
                    ErrorCode::ElementNotFound,
                    format!("{reference:?} is not a ref from this app's latest snapshots"),
                ));
            }
        };
        if entry.process != app.process {
            return Err(stale("the app restarted; call computer_snapshot again"));
        }
        match self.platform.element_status(&entry.handle, deadline) {
            ElementStatus::Alive { role, pid } if role == entry.role && pid == app.process.pid => Ok(entry.handle.clone()),
            _ => Err(stale("the element is gone or changed; call computer_snapshot again")),
        }
    }

    fn initial_target(
        &self,
        action: &Action,
        slot: &AppSlot<P::Element>,
        app: &RunningApp,
        deadline: Deadline,
    ) -> CuResult<Option<P::Element>> {
        let reference = match action {
            Action::Click { element, .. }
            | Action::Type { element, .. }
            | Action::Key { element, .. }
            | Action::Scroll { element, .. } => element.as_deref(),
            Action::Fill { element, .. } | Action::Select { element, .. } => Some(element.as_str()),
            Action::Menu { .. } => None,
        };
        match reference {
            Some(reference) => self.resolve_ref(slot, app, reference, deadline).map(Some),
            None if matches!(action, Action::Type { .. } | Action::Key { .. }) => {
                Ok(self.platform.focused_element(app, deadline))
            }
            None => Ok(None),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn deliver(
        &self,
        app: &RunningApp,
        slot: &AppSlot<P::Element>,
        windows: &[WindowInfo],
        window: Option<&WindowInfo>,
        action: &Action,
        pointer: bool,
        deadline: Deadline,
        cancel: &CancelToken,
    ) -> CuResult<Delivery<P::Element>> {
        match action {
            Action::Click { element, x, y, button, count, .. } => {
                if !(1..=2).contains(count) {
                    return Err(invalid("count must be 1 or 2"));
                }
                match (element, x, y) {
                    (Some(reference), None, None) => {
                        let element = self.resolve_ref(slot, app, reference, deadline)?;
                        match self.click(&element, *button, *count, deadline, cancel) {
                            Err(error) if pointer && error.code == ErrorCode::ActionUnsupported => {
                                // 4. Background pointer click at the element centre.
                                let window = window.ok_or(error.clone())?;
                                let Some(frame) = self.platform.element_frame(&element, deadline) else {
                                    return Err(error);
                                };
                                let (x, y) = window_point(window, frame)?;
                                self.pointer_click(app, window, x, y, *button, *count, Some(element), cancel)
                            }
                            other => other,
                        }
                    }
                    (None, Some(x), Some(y)) => {
                        let window = window.ok_or_else(|| ErrorObject::new(ErrorCode::WindowNotFound, "the app has no windows"))?;
                        let (result, hit) = match self.hit_test(app, window, *x, *y, deadline) {
                            Ok(element) => (self.click(&element, *button, *count, deadline, cancel), Some(element)),
                            Err(error) => (Err(error), None),
                        };
                        match result {
                            // Nothing pressable at the point: background pointer click there.
                            Err(error) if pointer && error.code == ErrorCode::ActionUnsupported => {
                                self.pointer_click(app, window, *x, *y, *button, *count, hit, cancel)
                            }
                            other => other,
                        }
                    }
                    _ => Err(invalid("pass exactly one of ref or both x and y")),
                }
            }
            Action::Type { text, element, replace } => {
                let target = match element {
                    Some(reference) => Some(self.resolve_ref(slot, app, reference, deadline)?),
                    None => self.platform.focused_element(app, deadline),
                };
                self.type_text(app, target, text, *replace, deadline, cancel)
            }
            Action::Key { keys, element } => {
                let target = match element {
                    Some(reference) => Some(self.resolve_ref(slot, app, reference, deadline)?),
                    None => None,
                };
                self.press_keys(app, target, keys, deadline, cancel)
            }
            Action::Scroll { element, direction, amount, times } => {
                if !(1..=MAX_SCROLL_TIMES).contains(times) {
                    return Err(invalid("times must be between 1 and 20"));
                }
                let target = match element {
                    Some(reference) => Some(self.resolve_ref(slot, app, reference, deadline)?),
                    None => None,
                };
                self.scroll(app, window, target, *direction, *amount, *times, pointer, deadline, cancel)
            }
            Action::Fill { element, value } => {
                let target = self.resolve_ref(slot, app, element, deadline)?;
                self.fill(&target, value, deadline, cancel)
            }
            Action::Select { element, option, text, range } => {
                let target = self.resolve_ref(slot, app, element, deadline)?;
                self.select(app, &target, option.as_deref(), text.as_deref(), *range, deadline, cancel)
            }
            Action::Menu { path } => {
                if path.is_empty() || path.len() > 8 {
                    return Err(invalid("path must have between 1 and 8 titles"));
                }
                if let Some(reason) = crate::text::refused_menu_reason(path) {
                    return Err(unsupported(reason, "this menu command is not allowed for computer use"));
                }
                let _ = windows;
                self.platform.press_menu_path(app, path, deadline)?;
                Ok(Delivery::new("ax_menu", None))
            }
        }
    }

    /// Finds the element at a window-local point and checks it belongs to that window.
    fn hit_test(&self, app: &RunningApp, window: &WindowInfo, x: f64, y: f64, deadline: Deadline) -> CuResult<P::Element> {
        if x < 0.0 || y < 0.0 || x >= window.bounds.width || y >= window.bounds.height {
            return Err(invalid("x and y must be inside the window (window-local points)"));
        }
        let screen_x = window.bounds.x + x;
        let screen_y = window.bounds.y + y;
        let element = self
            .platform
            .element_at(app, screen_x, screen_y, deadline)
            .ok_or_else(|| unsupported("no_element_at_point", "no accessible element at that point"))?;
        if self.platform.element_window_id(&element, deadline).is_some_and(|id| id != window.id) {
            return Err(unsupported("point_outside_window", "the element at that point belongs to another window"));
        }
        Ok(element)
    }

    /// Experimental pointer click at a window-local point. Verification comes only from
    /// the fingerprint; the engine never assumes a pointer click landed.
    #[allow(clippy::too_many_arguments)]
    fn pointer_click(
        &self,
        app: &RunningApp,
        window: &WindowInfo,
        x: f64,
        y: f64,
        button: MouseButton,
        count: u32,
        watched: Option<P::Element>,
        cancel: &CancelToken,
    ) -> CuResult<Delivery<P::Element>> {
        self.guard(cancel)?;
        let guard = || self.guard(cancel);
        let route = self.platform.pointer_click(app, window, x, y, button, count, &guard)?;
        Ok(Delivery::new(route.method(), watched))
    }

    fn click(
        &self,
        element: &P::Element,
        button: MouseButton,
        count: u32,
        deadline: Deadline,
        cancel: &CancelToken,
    ) -> CuResult<Delivery<P::Element>> {
        let probe = self.platform.probe(element, deadline)?;

        if button == MouseButton::Right {
            if probe.actions.contains(&ElementAction::ShowMenu) {
                self.platform.perform(element, ElementAction::ShowMenu, deadline)?;
                return Ok(Delivery::new("ax_show_menu", Some(element.clone())));
            }
            return Err(tried_unsupported("no_menu_action", &["show_menu"], "the element has no context menu action"));
        }

        if count == 2 {
            if probe.actions.contains(&ElementAction::Open) {
                self.platform.perform(element, ElementAction::Open, deadline)?;
                return Ok(Delivery::new("ax_open", Some(element.clone())));
            }
            if is_row(&probe.role) && probe.actions.contains(&ElementAction::Press) {
                self.platform.perform(element, ElementAction::Press, deadline)?;
                self.guard(cancel)?;
                self.platform.perform(element, ElementAction::Press, deadline)?;
                return Ok(Delivery::new("ax_press_twice", Some(element.clone())));
            }
            return Err(tried_unsupported("no_open_action", &["open", "press_twice"], "the element cannot be double-clicked"));
        }

        // 1. Press. 2. Other default actions. 3. Nearest pressable ancestor.
        if probe.actions.contains(&ElementAction::Press) {
            self.platform.perform(element, ElementAction::Press, deadline)?;
            return Ok(Delivery::new("ax_press", Some(element.clone())));
        }
        for action in [ElementAction::Confirm, ElementAction::Open, ElementAction::Pick] {
            if probe.actions.contains(&action) {
                self.platform.perform(element, action, deadline)?;
                return Ok(Delivery::new("ax_action", Some(element.clone())));
            }
        }
        let mut current = element.clone();
        for _ in 0..ANCESTOR_LEVELS {
            self.guard(cancel)?;
            let Some(parent) = self.platform.parent(&current, deadline) else {
                break;
            };
            let parent_probe = self.platform.probe(&parent, deadline)?;
            if parent_probe.role == roles::WINDOW {
                break;
            }
            if parent_probe.actions.contains(&ElementAction::Press) {
                self.platform.perform(&parent, ElementAction::Press, deadline)?;
                return Ok(Delivery::new("ax_press_ancestor", Some(parent)));
            }
            current = parent;
        }
        Err(tried_unsupported(
            "no_press_action",
            &["press", "confirm", "open", "pick", "ancestor_press"],
            "the element has no click action",
        ))
    }

    fn type_text(
        &self,
        app: &RunningApp,
        target: Option<P::Element>,
        text: &str,
        replace: bool,
        deadline: Deadline,
        cancel: &CancelToken,
    ) -> CuResult<Delivery<P::Element>> {
        if text.chars().count() > MAX_TYPE_CHARS {
            return Err(invalid("text may have at most 10,000 characters"));
        }
        let target = target.ok_or_else(|| unsupported("no_focused_element", "the app has no focused element to type into"))?;
        let probe = self.platform.probe(&target, deadline)?;
        if probe.states.secure || probe.role == roles::SECURE_TEXT_FIELD {
            return Err(ErrorObject::new(ErrorCode::SecureField, "typing into secure text fields is not allowed"));
        }
        let before = probe.value.clone().unwrap_or_default();

        // 1. Accessibility writes.
        let written = if replace {
            self.platform.set_value(&target, &FillValue::Text(text.to_owned()), deadline).is_ok() || {
                let whole = TextRange { start: 0, length: utf16_len(&before) };
                self.platform.set_selected_range(&target, whole, deadline).is_ok()
                    && self.platform.set_selected_text(&target, text, deadline).is_ok()
            }
        } else {
            self.platform.set_selected_text(&target, text, deadline).is_ok()
        };
        if written {
            // Some apps apply the write asynchronously; never fall back to keys after a
            // successful write, or the text could land twice.
            let mut landed = false;
            for delay in [30, 60, 120, 240] {
                std::thread::sleep(Duration::from_millis(delay));
                self.guard(cancel)?;
                let after = self.platform.probe(&target, deadline)?.value.unwrap_or_default();
                landed = if replace {
                    after == text
                } else {
                    after != before
                        && (after.contains(text) || after.chars().count() >= before.chars().count() + text.chars().count())
                };
                if landed {
                    break;
                }
            }
            return Ok(Delivery::new("ax", Some(target)).confirmed(landed));
        }
        self.guard(cancel)?;

        // 2. Keys to the process, only when the intended element has focus.
        let focused = self.platform.focused_element(app, deadline);
        let has_focus = focused.as_ref().is_some_and(|focused| self.platform.same_element(focused, &target));
        if !has_focus {
            let _ = self.platform.set_focused(&target, deadline);
            let focused = self.platform.focused_element(app, deadline);
            if !focused.as_ref().is_some_and(|focused| self.platform.same_element(focused, &target)) {
                return Err(tried_unsupported(
                    "target_not_focused",
                    &["ax_selected_text", "keys"],
                    "the app does not accept text writes and the element cannot take focus",
                ));
            }
        }
        if replace {
            let whole = TextRange { start: 0, length: utf16_len(&before) };
            self.platform.set_selected_range(&target, whole, deadline)?;
        }
        for chunk in utf16_chunks(text, KEY_CHUNK_UNITS) {
            self.guard(cancel)?;
            self.platform.post_text(app, &chunk)?;
        }
        std::thread::sleep(Duration::from_millis(50));
        let after = self.platform.probe(&target, deadline)?.value.unwrap_or_default();
        let landed = if replace { after == text } else { after != before && after.contains(text) };
        Ok(Delivery::new("keys", Some(target)).confirmed(landed))
    }

    fn press_keys(
        &self,
        app: &RunningApp,
        target: Option<P::Element>,
        keys: &str,
        deadline: Deadline,
        cancel: &CancelToken,
    ) -> CuResult<Delivery<P::Element>> {
        let chords = parse_key_sequence(keys)?;
        check_refused(&chords)?;
        // A target was focused before the "before" reading (see `app_act`).

        // Keys into a password field would bypass the secure-field rule; allow only navigation.
        let receiver = target.clone().or_else(|| self.platform.focused_element(app, deadline));
        let receiver_probe = receiver.as_ref().and_then(|receiver| self.platform.probe(receiver, deadline).ok());
        if let Some(probe) = &receiver_probe
            && (probe.states.secure || probe.role == roles::SECURE_TEXT_FIELD)
            && chords.iter().any(|chord| !is_navigation(chord))
        {
            return Err(ErrorObject::new(ErrorCode::SecureField, "typing into secure text fields is not allowed"));
        }
        let text_keys = receiver_probe
            .as_ref()
            .is_some_and(|probe| is_text_role(&probe.role) || probe.states.editable)
            && chords.iter().all(edits_text);

        let mut method = "keys";
        for chord in &chords {
            self.guard(cancel)?;
            let focused = self.platform.focused_element(app, deadline);

            // Return/enter → confirm, escape → cancel, when the focused element offers it.
            let element_action = if chord.is_plain(NamedKey::Return) || chord.is_plain(NamedKey::Enter) {
                Some(ElementAction::Confirm)
            } else if chord.is_plain(NamedKey::Escape) {
                Some(ElementAction::Cancel)
            } else {
                None
            };
            if let (Some(action), Some(focused)) = (element_action, &focused)
                && self.platform.probe(focused, deadline).is_ok_and(|probe| probe.actions.contains(&action))
            {
                self.platform.perform(focused, action, deadline)?;
                if chords.len() == 1 {
                    method = if action == ElementAction::Confirm { "ax_confirm" } else { "ax_cancel" };
                }
                continue;
            }

            if focused.is_none() {
                return Err(unsupported("no_focused_element", "the app has no focused element to receive keys")
                    .with_hint("use computer_invoke_menu for menu shortcuts"));
            }
            self.platform.post_key(app, chord)?;
            std::thread::sleep(Duration::from_millis(10));
        }
        let watched = target.or_else(|| self.platform.focused_element(app, deadline));
        let mut delivery = Delivery::new(method, watched);
        delivery.text_keys = text_keys;
        Ok(delivery)
    }

    #[allow(clippy::too_many_arguments)]
    fn scroll(
        &self,
        app: &RunningApp,
        window: Option<&WindowInfo>,
        target: Option<P::Element>,
        direction: ScrollDirection,
        amount: ScrollAmount,
        times: u32,
        pointer: bool,
        deadline: Deadline,
        cancel: &CancelToken,
    ) -> CuResult<Delivery<P::Element>> {
        let area = match &target {
            Some(target) => {
                let probe = self.platform.probe(target, deadline)?;
                if probe.role == roles::SCROLL_AREA {
                    Ok(target.clone())
                } else if probe.actions.contains(&ElementAction::ScrollToVisible) {
                    self.platform.perform(target, ElementAction::ScrollToVisible, deadline)?;
                    return Ok(Delivery::new("ax_scroll_to_visible", Some(target.clone())));
                } else {
                    self.nearest_scroll_area(target, deadline).ok_or_else(|| {
                        tried_unsupported("no_scroll_area", &["scroll_to_visible", "scroll_area"], "nothing to scroll here")
                    })
                }
            }
            None => {
                let window = window.ok_or_else(|| ErrorObject::new(ErrorCode::WindowNotFound, "the app has no windows"))?;
                self.platform
                    .main_scroll_area(app, window, deadline)
                    .ok_or_else(|| tried_unsupported("no_scroll_area", &["scroll_area"], "the window has no scroll area"))
            }
        };

        // The first step decides the path; later failures are real errors, so the
        // pointer never scrolls on top of a partial accessibility scroll.
        let first = area.clone().and_then(|area| {
            self.guard(cancel)?;
            self.platform.scroll_area(&area, direction, amount, deadline)
        });
        match first {
            Ok(()) => {
                let area = area?;
                for _ in 1..times {
                    self.guard(cancel)?;
                    self.platform.scroll_area(&area, direction, amount, deadline)?;
                }
                Ok(Delivery::new("ax_scroll", Some(area)))
            }
            Err(error) if pointer && error.code == ErrorCode::ActionUnsupported => {
                // 3. Wheel events at the centre of the area (or the target, or the window).
                let window = window.ok_or(error.clone())?;
                let aim = area.ok().or(target);
                let frame = aim.as_ref().and_then(|element| self.platform.element_frame(element, deadline));
                let (x, y) = match frame {
                    Some(frame) => window_point(window, frame)?,
                    None => (window.bounds.width / 2.0, window.bounds.height / 2.0),
                };
                self.guard(cancel)?;
                let guard = || self.guard(cancel);
                let route = self.platform.pointer_scroll(app, window, x, y, direction, amount, times, &guard)?;
                Ok(Delivery::new(route.method(), aim))
            }
            Err(error) => Err(error),
        }
    }

    fn nearest_scroll_area(&self, element: &P::Element, deadline: Deadline) -> Option<P::Element> {
        let mut current = element.clone();
        for _ in 0..8 {
            let parent = self.platform.parent(&current, deadline)?;
            let probe = self.platform.probe(&parent, deadline).ok()?;
            if probe.role == roles::SCROLL_AREA {
                return Some(parent);
            }
            if probe.role == roles::WINDOW {
                return None;
            }
            current = parent;
        }
        None
    }

    fn fill(
        &self,
        target: &P::Element,
        value: &FillValue,
        deadline: Deadline,
        cancel: &CancelToken,
    ) -> CuResult<Delivery<P::Element>> {
        let probe = self.platform.probe(target, deadline)?;
        if probe.states.secure || probe.role == roles::SECURE_TEXT_FIELD {
            return Err(ErrorObject::new(ErrorCode::SecureField, "filling secure text fields is not allowed"));
        }

        // Checkable controls: press when the state differs.
        if let (FillValue::Bool(wanted), Some(checked)) = (value, probe.states.checked) {
            if checked == *wanted {
                let mut delivery = Delivery::new("ax_unchanged", Some(target.clone()));
                delivery.notes.push("the control already had that state".to_owned());
                return Ok(delivery);
            }
            if probe.actions.contains(&ElementAction::Press) {
                self.platform.perform(target, ElementAction::Press, deadline)?;
                let after = self.platform.probe(target, deadline)?;
                return Ok(Delivery::new("ax_press", Some(target.clone())).confirmed(after.states.checked == Some(*wanted)));
            }
        }

        let mut tried = Vec::new();
        if probe.value_settable {
            tried.push("ax_value");
            if self.platform.set_value(target, value, deadline).is_ok() {
                let after = self.platform.probe(target, deadline)?;
                if fill_matches(value, after.value.as_deref()) {
                    return Ok(Delivery::new("ax_value", Some(target.clone())).confirmed(true));
                }
            }
        }

        // Sliders and steppers: step toward a numeric target.
        if let FillValue::Number(wanted) = value
            && (probe.actions.contains(&ElementAction::Increment) || probe.actions.contains(&ElementAction::Decrement))
        {
            tried.push("ax_steps");
            return self.step_to(target, *wanted, &probe, deadline, cancel);
        }

        if probe.value_settable {
            return Ok(Delivery::new("ax_value", Some(target.clone())));
        }
        tried.push("ax_value");
        Err(tried_unsupported("value_not_settable", &tried, "the element's value cannot be set"))
    }

    fn step_to(
        &self,
        target: &P::Element,
        wanted: f64,
        probe: &ElementProbe,
        deadline: Deadline,
        cancel: &CancelToken,
    ) -> CuResult<Delivery<P::Element>> {
        let read = |probe: &ElementProbe| probe.value.as_deref().and_then(|value| value.trim().parse::<f64>().ok());
        let Some(mut current) = read(probe) else {
            return Err(tried_unsupported("value_not_numeric", &["ax_steps"], "the element's value is not a number"));
        };
        for _ in 0..MAX_STEPS {
            if (current - wanted).abs() < 1e-6 {
                return Ok(Delivery::new("ax_steps", Some(target.clone())).confirmed(true));
            }
            self.guard(cancel)?;
            let action = if current < wanted { ElementAction::Increment } else { ElementAction::Decrement };
            self.platform.perform(target, action, deadline)?;
            let Some(next) = read(&self.platform.probe(target, deadline)?) else {
                break;
            };
            // Stop once we cross the target or stop moving.
            let crossed = (current < wanted && next > wanted) || (current > wanted && next < wanted);
            if next == current || crossed {
                current = next;
                break;
            }
            current = next;
        }
        let mut delivery = Delivery::new("ax_steps", Some(target.clone())).confirmed((current - wanted).abs() < 1e-6);
        if !delivery.confirmed {
            delivery.notes.push(format!("stopped stepping at {current}; the control's step size may not reach {wanted}"));
        }
        Ok(delivery)
    }

    #[allow(clippy::too_many_arguments)]
    fn select(
        &self,
        app: &RunningApp,
        target: &P::Element,
        option: Option<&str>,
        text: Option<&str>,
        range: Option<TextRange>,
        deadline: Deadline,
        cancel: &CancelToken,
    ) -> CuResult<Delivery<P::Element>> {
        let given = [option.is_some(), text.is_some(), range.is_some()].iter().filter(|given| **given).count();
        if given > 1 {
            return Err(invalid("pass at most one of option, text, or range"));
        }
        let probe = self.platform.probe(target, deadline)?;

        if let Some(range) = range {
            self.platform.set_selected_range(target, range, deadline)?;
            return Ok(Delivery::new("ax_selected_range", Some(target.clone())));
        }
        if let Some(text) = text {
            let value = probe.value.clone().unwrap_or_default();
            let start = utf16_find(&value, text)
                .ok_or_else(|| ErrorObject::new(ErrorCode::InvalidArgument, "the text does not occur in the element's value"))?;
            self.platform.set_selected_range(target, TextRange { start, length: utf16_len(text) }, deadline)?;
            return Ok(Delivery::new("ax_selected_range", Some(target.clone())));
        }
        let Some(option) = option else {
            if self.platform.set_selected(target, true, deadline).is_ok() {
                return Ok(Delivery::new("ax_selected", Some(target.clone())));
            }
            if probe.actions.contains(&ElementAction::Press) {
                self.platform.perform(target, ElementAction::Press, deadline)?;
                return Ok(Delivery::new("ax_press", Some(target.clone())));
            }
            return Err(tried_unsupported("not_selectable", &["ax_selected", "press"], "the element cannot be selected"));
        };

        let is_menu_control =
            matches!(probe.role.as_str(), roles::POPUP_BUTTON | roles::COMBO_BOX | roles::MENU_BUTTON);
        if is_menu_control {
            return self.select_from_menu(app, target, &probe, option, deadline, cancel);
        }

        // Lists, tables, outlines, tab groups: select the matching descendant.
        let (found, available) = self.find_descendant(target, option, 3, deadline, cancel)?;
        let Some(item) = found else {
            return Err(ErrorObject::new(ErrorCode::ActionUnsupported, format!("no option named {option:?}"))
                .with_details(json!({ "reason": "option_not_found", "available": available })));
        };
        let item_probe = self.platform.probe(&item, deadline)?;
        if self.platform.set_selected(&item, true, deadline).is_ok() {
            return Ok(Delivery::new("ax_selected", Some(target.clone())));
        }
        if item_probe.actions.contains(&ElementAction::Press) {
            self.platform.perform(&item, ElementAction::Press, deadline)?;
            return Ok(Delivery::new("ax_press", Some(target.clone())));
        }
        Err(tried_unsupported("not_selectable", &["ax_selected", "press"], "the option cannot be selected"))
    }

    fn select_from_menu(
        &self,
        app: &RunningApp,
        target: &P::Element,
        probe: &ElementProbe,
        option: &str,
        deadline: Deadline,
        cancel: &CancelToken,
    ) -> CuResult<Delivery<P::Element>> {
        // Combo boxes with a writable value accept the option text directly.
        if probe.role == roles::COMBO_BOX && probe.value_settable {
            let value = FillValue::Text(option.to_owned());
            if self.platform.set_value(target, &value, deadline).is_ok()
                && fill_matches(&value, self.platform.probe(target, deadline)?.value.as_deref())
            {
                return Ok(Delivery::new("ax_value", Some(target.clone())).confirmed(true));
            }
        }

        let open = if probe.actions.contains(&ElementAction::Press) { ElementAction::Press } else { ElementAction::ShowMenu };
        self.platform.perform(target, open, deadline)?;
        let result = self.pick_menu_option(target, option, deadline, cancel);
        if result.is_err() {
            // Close the menu again so the app does not stay in menu tracking.
            let _ = self.platform.post_key(app, &KeyChord { modifiers: Modifiers::default(), key: Key::Named(NamedKey::Escape) });
        }
        result
    }

    fn pick_menu_option(
        &self,
        target: &P::Element,
        option: &str,
        deadline: Deadline,
        cancel: &CancelToken,
    ) -> CuResult<Delivery<P::Element>> {

        // Wait briefly for the menu to appear under the control.
        let mut available = Vec::new();
        for _ in 0..10 {
            self.guard(cancel)?;
            let (found, names) = self.find_descendant(target, option, 3, deadline, cancel)?;
            available = names;
            if let Some(item) = found {
                self.platform.perform(&item, ElementAction::Press, deadline)?;
                return Ok(Delivery::new("ax_menu_option", Some(target.clone())));
            }
            std::thread::sleep(Duration::from_millis(50));
        }

        Err(ErrorObject::new(ErrorCode::ActionUnsupported, format!("no option named {option:?}"))
            .with_details(json!({ "reason": "option_not_found", "available": available })))
    }

    /// Breadth-first search for a descendant whose name or value matches `wanted`.
    /// Returns the match and the names seen (up to 30) for error details.
    fn find_descendant(
        &self,
        root: &P::Element,
        wanted: &str,
        max_depth: usize,
        deadline: Deadline,
        cancel: &CancelToken,
    ) -> CuResult<(Option<P::Element>, Vec<String>)> {
        let mut seen = Vec::new();
        let mut frontier = vec![root.clone()];
        for _ in 0..max_depth {
            let mut next = Vec::new();
            for element in &frontier {
                for child in self.platform.children(element, deadline).into_iter().take(TreeBudget::DEFAULT_CHILDREN) {
                    self.guard(cancel)?;
                    if let Ok(probe) = self.platform.probe(&child, deadline) {
                        let label = probe.name.clone().or(probe.value.clone());
                        if let Some(label) = label {
                            if menu_title_matches(&label, wanted) {
                                return Ok((Some(child), seen));
                            }
                            if seen.len() < 30 && !label.is_empty() {
                                seen.push(label);
                            }
                        }
                    }
                    next.push(child);
                }
            }
            if deadline.expired() {
                break;
            }
            frontier = next;
        }
        Ok((None, seen))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_fill_values_by_type() {
        assert!(fill_matches(&FillValue::Text("hi".into()), Some("hi")));
        assert!(fill_matches(&FillValue::Number(3.0), Some("3")));
        assert!(fill_matches(&FillValue::Bool(true), Some("1")));
        assert!(!fill_matches(&FillValue::Bool(false), Some("1")));
        assert!(!fill_matches(&FillValue::Text("hi".into()), None));
    }
}
