//! Window list, batched tree walk, element probes, hit testing, and fingerprints.
//!
//! Every read is an accessibility read of the target process. Nothing here activates
//! the app, raises a window, or moves the pointer.

use std::hash::{DefaultHasher, Hash, Hasher};
use std::ptr::NonNull;

use cu_core::forbidden::{is_browser, title_marks_private_window};
use cu_core::platform::{ElementProbe, ElementStatus, Fingerprint, RunningApp};
use cu_core::tree::{NodeStates, RawNode, RawTree, Rect, TreeBudget, WindowInfo, cut_text};
use cu_core::{CancelToken, CuResult, Deadline};
use cu_protocol::{ErrorCode, ErrorObject, TextRange, Truncation};
use objc2_core_foundation::{CFDictionary, CFRetained, CFString, CFType, CGRect};
use objc2_core_graphics::{
    CGRectMakeWithDictionaryRepresentation, CGWindowListCopyWindowInfo, CGWindowListOption, kCGWindowBounds,
    kCGWindowLayer, kCGWindowName, kCGWindowNumber, kCGWindowOwnerPID,
};

use crate::ax::{
    self, AxElement, AxFailure, as_bool, as_element, as_elements, as_range, as_string, core_actions, element_hash,
    rect_from, role_words,
};
use crate::web::WebAccess;

// -- windows ------------------------------------------------------------------

/// One on-screen or off-screen window from the window server.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CgWindow {
    pub id: u32,
    pub bounds: Rect,
    pub title: Option<String>,
}

fn dictionary_get(dictionary: &CFDictionary<CFString, CFType>, key: &CFString) -> Option<CFRetained<CFType>> {
    dictionary.get(key)
}

/// Layer-0 windows of `pid`, including off-screen ones.
fn cg_windows(pid: i32) -> Vec<CgWindow> {
    let options = CGWindowListOption::OptionAll | CGWindowListOption::ExcludeDesktopElements;
    let Some(list) = CGWindowListCopyWindowInfo(options, 0) else {
        return Vec::new();
    };
    // SAFETY: the window list is an array of dictionaries; each entry is type-checked below.
    let list: &objc2_core_foundation::CFArray<CFType> = unsafe { list.cast_unchecked() };
    let mut windows = Vec::new();
    for entry in list.iter() {
        let Some(dictionary) = entry.downcast_ref::<CFDictionary>() else {
            continue;
        };
        // SAFETY: window-info dictionaries are keyed by CFString.
        let dictionary: &CFDictionary<CFString, CFType> = unsafe { dictionary.cast_unchecked() };
        // SAFETY: the key constants are valid static CFStrings.
        let (pid_key, layer_key, number_key, bounds_key, name_key) =
            unsafe { (kCGWindowOwnerPID, kCGWindowLayer, kCGWindowNumber, kCGWindowBounds, kCGWindowName) };
        let owner = dictionary_get(dictionary, pid_key).as_deref().and_then(ax::as_f64);
        let layer = dictionary_get(dictionary, layer_key).as_deref().and_then(ax::as_f64);
        if owner != Some(pid as f64) || layer != Some(0.0) {
            continue;
        }
        let Some(number) = dictionary_get(dictionary, number_key).as_deref().and_then(ax::as_f64) else {
            continue;
        };
        let Some(bounds) = dictionary_get(dictionary, bounds_key) else {
            continue;
        };
        let Some(bounds) = bounds.downcast_ref::<CFDictionary>() else {
            continue;
        };
        let mut rect = CGRect::default();
        // SAFETY: valid dictionary and out pointer.
        if !unsafe { CGRectMakeWithDictionaryRepresentation(Some(bounds), &mut rect) } {
            continue;
        }
        let title = dictionary_get(dictionary, name_key).as_deref().and_then(as_string);
        windows.push(CgWindow { id: number as u32, bounds: ax::rect_of(rect), title });
    }
    windows
}

fn same_bounds(a: &Rect, b: &Rect) -> bool {
    (a.x - b.x).abs() <= 1.0 && (a.y - b.y).abs() <= 1.0 && (a.width - b.width).abs() <= 1.0 && (a.height - b.height).abs() <= 1.0
}

/// Matches AX windows (bounds, title) to window-server windows. Pass 1 needs bounds
/// and title; pass 2 accepts bounds when the server title is unknown. Each id is used once.
pub(crate) fn match_cg_windows(ax_windows: &[(Rect, String)], cg: &[CgWindow]) -> Vec<Option<u32>> {
    let mut used = vec![false; cg.len()];
    let mut matched = vec![None; ax_windows.len()];
    for strict in [true, false] {
        for (index, (bounds, title)) in ax_windows.iter().enumerate() {
            if matched[index].is_some() {
                continue;
            }
            let found = cg.iter().enumerate().find(|(cg_index, candidate)| {
                !used[*cg_index]
                    && same_bounds(bounds, &candidate.bounds)
                    && match &candidate.title {
                        Some(cg_title) => cg_title == title,
                        None => !strict,
                    }
            });
            if let Some((cg_index, candidate)) = found {
                used[cg_index] = true;
                matched[index] = Some(candidate.id);
            }
        }
    }
    matched
}

fn app_element_error(failure: AxFailure) -> ErrorObject {
    match failure {
        AxFailure::Invalid => ErrorObject::new(ErrorCode::AppNotFound, "the app is no longer running"),
        other => other.to_error("reading windows"),
    }
}

/// AX windows paired with their [`WindowInfo`].
fn window_pairs(app: &RunningApp, deadline: Deadline) -> CuResult<Vec<(AxElement, WindowInfo)>> {
    let application = AxElement::application(app.process.pid);
    let values = application.attrs(&["AXWindows", "AXFocusedWindow"], deadline).map_err(app_element_error)?;
    let elements = values[0].as_deref().map(as_elements).unwrap_or_default();
    let focused = values[1].as_deref().and_then(as_element);

    let mut found = Vec::new();
    for element in elements {
        let Ok(values) = element.attrs(&["AXRole", "AXTitle", "AXPosition", "AXSize", "AXMinimized", "AXMain"], deadline)
        else {
            continue;
        };
        if values[0].as_deref().and_then(as_string).as_deref() != Some("AXWindow") {
            continue;
        }
        let Some(bounds) = rect_from(values[2].as_deref(), values[3].as_deref()) else {
            continue;
        };
        if bounds.width <= 0.0 || bounds.height <= 0.0 {
            continue;
        }
        let title = values[1].as_deref().and_then(as_string).unwrap_or_default();
        let minimized = values[4].as_deref().and_then(as_bool).unwrap_or(false);
        let main = values[5].as_deref().and_then(as_bool).unwrap_or(false);
        found.push((element, title, bounds, minimized, main));
    }

    let cg = cg_windows(app.process.pid);
    let keys: Vec<(Rect, String)> = found.iter().map(|(_, title, bounds, _, _)| (*bounds, title.clone())).collect();
    let ids = match_cg_windows(&keys, &cg);
    let private_capable = is_browser(&app.bundle_id);

    Ok(found
        .into_iter()
        .zip(ids)
        .map(|((element, title, bounds, minimized, main), id)| {
            let id = match id {
                Some(id) => format!("w{id}"),
                None => format!("a{}", element_hash(&element)),
            };
            let info = WindowInfo {
                focused: focused.as_ref() == Some(&element),
                private: private_capable && title_marks_private_window(&title),
                id,
                title,
                bounds,
                minimized,
                main,
            };
            (element, info)
        })
        .collect())
}

pub fn windows(app: &RunningApp, deadline: Deadline) -> CuResult<Vec<WindowInfo>> {
    Ok(window_pairs(app, deadline)?.into_iter().map(|(_, info)| info).collect())
}

/// The AX window element for a window id from [`windows`].
pub fn window_element(app: &RunningApp, window: &WindowInfo, deadline: Deadline) -> Option<AxElement> {
    window_pairs(app, deadline).ok()?.into_iter().find(|(_, info)| info.id == window.id).map(|(element, _)| element)
}

// -- tree walk ----------------------------------------------------------------

const NODE_ATTRIBUTES: [&str; 15] = [
    "AXRole",
    "AXSubrole",
    "AXTitle",
    "AXDescription",
    "AXValue",
    "AXHelp",
    "AXEnabled",
    "AXFocused",
    "AXSelected",
    "AXExpanded",
    "AXPosition",
    "AXSize",
    "AXVisibleRows",
    "AXContents",
    "AXChildren",
];

/// Roles that never carry useful actions, so their action names are not read.
fn skips_actions(role: &str) -> bool {
    matches!(
        role,
        "AXStaticText" | "AXGroup" | "AXImage" | "AXScrollArea" | "AXSplitGroup" | "AXLayoutArea" | "AXWebArea"
            | "AXUnknown" | "AXWindow" | "AXList" | "AXTable" | "AXOutline" | "AXColumn" | "AXValueIndicator"
    )
}

fn is_text_role(role: &str) -> bool {
    matches!(role, "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField")
}

fn is_checkable(role: &str, subrole: Option<&str>) -> bool {
    matches!(role, "AXCheckBox" | "AXRadioButton") && subrole != Some("AXTabButton") || subrole == Some("AXSwitch")
}

/// Children attribute to follow for a role: visible rows for tables and outlines.
pub(crate) fn uses_visible_rows(role: &str) -> bool {
    matches!(role, "AXTable" | "AXOutline")
}

/// Fully outside the window, with a real area: offscreen content to skip.
pub(crate) fn is_offscreen(bounds: Option<Rect>, window: &Rect) -> bool {
    let Some(bounds) = bounds else {
        return false;
    };
    if bounds.width <= 0.0 || bounds.height <= 0.0 {
        return false;
    }
    bounds.x + bounds.width <= window.x
        || bounds.y + bounds.height <= window.y
        || bounds.x >= window.x + window.width
        || bounds.y >= window.y + window.height
}

struct Frame {
    element: AxElement,
    parent: Option<usize>,
    depth: usize,
    in_web: bool,
}

pub fn snapshot(
    web: &WebAccess,
    app: &RunningApp,
    window: &WindowInfo,
    budget: &TreeBudget,
    deadline: Deadline,
    cancel: &CancelToken,
) -> CuResult<RawTree<AxElement>> {
    let root = window_element(app, window, deadline)
        .ok_or_else(|| ErrorObject::new(ErrorCode::WindowNotFound, "the window closed; call computer_snapshot again"))?;

    let mut tree = RawTree { nodes: Vec::new(), truncated: None, menus: Vec::new(), needs_web_accessibility: false };
    let mut web_area_empty = false;
    let mut timeouts_in_a_row = 0;
    let mut stack = vec![Frame { element: root, parent: None, depth: 0, in_web: false }];

    while let Some(frame) = stack.pop() {
        cancel.check()?;
        if deadline.expired() {
            tree.truncated = Some(Truncation::Deadline);
            break;
        }
        if tree.nodes.len() >= budget.max_nodes {
            tree.truncated = Some(Truncation::Nodes);
            break;
        }

        let values = match frame.element.attrs(&NODE_ATTRIBUTES, deadline) {
            Ok(values) => {
                timeouts_in_a_row = 0;
                values
            }
            Err(failure) if frame.parent.is_none() => {
                return Err(match failure {
                    AxFailure::Invalid => ErrorObject::new(ErrorCode::WindowNotFound, "the window closed"),
                    other => other.to_error("reading the window"),
                });
            }
            Err(AxFailure::Timeout) => {
                timeouts_in_a_row += 1;
                if timeouts_in_a_row >= 2 {
                    tree.truncated = Some(Truncation::Deadline);
                    break;
                }
                continue;
            }
            Err(_) => continue,
        };

        let text = |index: usize| values[index].as_deref().and_then(as_string);
        let flag = |index: usize| values[index].as_deref().and_then(as_bool);
        let raw_role = text(0).unwrap_or_default();
        let subrole = text(1);

        // Menus are reached through computer_invoke_menu, not the window tree.
        if matches!(raw_role.as_str(), "AXMenuBar" | "AXMenu" | "AXMenuBarItem") {
            continue;
        }
        let bounds = rect_from(values[10].as_deref(), values[11].as_deref());
        if frame.parent.is_some() && is_offscreen(bounds, &window.bounds) {
            continue;
        }

        let secure = subrole.as_deref() == Some("AXSecureTextField");
        let mut states = NodeStates {
            focused: flag(7).unwrap_or(false),
            selected: flag(8).unwrap_or(false),
            disabled: flag(6) == Some(false),
            expanded: flag(9),
            secure,
            ..NodeStates::default()
        };

        // Values: never for secure fields; checkable controls become states.
        let mut value = None;
        let mut value_len = 0;
        if !secure && let Some(raw) = values[4].as_deref() {
            let number = ax::as_f64(raw);
            if is_checkable(&raw_role, subrole.as_deref()) {
                match number.map(|number| number as i64) {
                    Some(0) => states.checked = Some(false),
                    Some(1) => states.checked = Some(true),
                    Some(2) => value = Some("mixed".to_owned()),
                    _ => {}
                }
            } else if subrole.as_deref() == Some("AXTabButton") {
                states.selected |= number == Some(1.0);
            } else if raw_role == "AXDisclosureTriangle" {
                states.expanded = number.map(|number| number != 0.0);
            } else if let Some(string) = as_string(raw) {
                let (cut, total) = cut_text(&string, budget.max_text);
                value = Some(cut);
                value_len = total;
            }
        }
        if value.is_some() && value_len == 0 {
            value_len = value.as_deref().map(|value| value.chars().count()).unwrap_or(0);
        }

        if is_text_role(&raw_role) {
            states.editable = frame.element.is_settable("AXValue", deadline).unwrap_or(false);
        }
        let in_web = frame.in_web || raw_role == "AXWebArea";
        let reads_actions = !skips_actions(&raw_role) || (in_web && matches!(raw_role.as_str(), "AXGroup" | "AXImage"));
        let actions = if reads_actions {
            frame.element.action_names(deadline).map(|names| core_actions(&names)).unwrap_or_default()
        } else {
            Vec::new()
        };

        let cut = |text: Option<String>| text.filter(|text| !text.is_empty()).map(|text| cut_text(&text, budget.max_text).0);
        let description = cut(text(3)).or_else(|| cut(text(5)));

        // Children: visible rows for tables and outlines, contents when children are empty.
        let mut children = values[14].as_deref().map(as_elements).unwrap_or_default();
        if uses_visible_rows(&raw_role)
            && let Some(rows) = values[12].as_deref().map(as_elements)
            && !rows.is_empty()
        {
            children = rows;
        }
        if children.is_empty() {
            children = values[13].as_deref().map(as_elements).unwrap_or_default();
        }
        if raw_role == "AXWebArea" && children.is_empty() {
            web_area_empty = true;
        }

        let index = tree.nodes.len();
        tree.nodes.push(RawNode {
            handle: frame.element,
            role: role_words(&raw_role, subrole.as_deref()),
            name: cut(text(2)),
            value,
            value_len,
            description,
            states,
            bounds,
            actions,
            children: Vec::new(),
        });
        if let Some(parent) = frame.parent {
            tree.nodes[parent].children.push(index);
        }

        if children.is_empty() {
            continue;
        }
        if frame.depth + 1 >= budget.max_depth {
            tree.truncated.get_or_insert(Truncation::Depth);
            continue;
        }
        if children.len() > budget.max_children {
            children.truncate(budget.max_children);
            tree.truncated.get_or_insert(Truncation::Nodes);
        }
        for child in children.into_iter().rev() {
            stack.push(Frame { element: child, parent: Some(index), depth: frame.depth + 1, in_web });
        }
    }

    tree.menus = menu_titles(app, deadline);
    let enabled = web.is_enabled(app);
    tree.needs_web_accessibility =
        (web_area_empty && (!enabled || web.is_settling(app))) || (!enabled && web.exposes_opt_in(app, deadline));
    Ok(tree)
}

/// Top-level menu bar titles, without the Apple menu.
fn menu_titles(app: &RunningApp, deadline: Deadline) -> Vec<String> {
    let application = AxElement::application(app.process.pid);
    let Ok(Some(bar)) = application.element("AXMenuBar", deadline) else {
        return Vec::new();
    };
    let items = bar.elements("AXChildren", deadline).unwrap_or_default();
    items
        .iter()
        .skip(1)
        .filter_map(|item| item.string("AXTitle", deadline).ok().flatten())
        .filter(|title| !title.is_empty())
        .collect()
}

// -- elements -----------------------------------------------------------------

pub fn element_status(element: &AxElement, deadline: Deadline) -> ElementStatus {
    // A timeout counts as invalid: the engine then reports `stale_element`.
    let Ok(values) = element.attrs(&["AXRole", "AXSubrole"], deadline) else {
        return ElementStatus::Invalid;
    };
    let Some(role) = values[0].as_deref().and_then(as_string) else {
        return ElementStatus::Invalid;
    };
    let subrole = values[1].as_deref().and_then(as_string);
    match element.pid() {
        Ok(pid) => ElementStatus::Alive { role: role_words(&role, subrole.as_deref()), pid },
        Err(_) => ElementStatus::Invalid,
    }
}

fn child_count(element: &AxElement, deadline: Deadline) -> usize {
    if element.arm(deadline).is_err() {
        return 0;
    }
    let name = ax::cfstr("AXChildren");
    let mut count: isize = 0;
    // SAFETY: valid element, attribute name, and out pointer.
    let code = unsafe { element.0.attribute_value_count(&name, NonNull::from(&mut count)) };
    if AxFailure::from_code(code).is_some() { 0 } else { count.max(0) as usize }
}

fn probe_element(element: &AxElement, deadline: Deadline, with_window: bool) -> CuResult<ElementProbe> {
    let values = element
        .attrs(
            &[
                "AXRole",
                "AXSubrole",
                "AXTitle",
                "AXDescription",
                "AXValue",
                "AXEnabled",
                "AXFocused",
                "AXSelected",
                "AXExpanded",
                "AXSelectedTextRange",
                "AXWindow",
            ],
            deadline,
        )
        .map_err(|failure| failure.to_error("reading the element"))?;
    let text = |index: usize| values[index].as_deref().and_then(as_string);
    let flag = |index: usize| values[index].as_deref().and_then(as_bool);
    let raw_role = text(0).unwrap_or_default();
    let subrole = text(1);
    let secure = subrole.as_deref() == Some("AXSecureTextField");

    let mut states = NodeStates {
        focused: flag(6).unwrap_or(false),
        selected: flag(7).unwrap_or(false),
        disabled: flag(5) == Some(false),
        expanded: flag(8),
        secure,
        ..NodeStates::default()
    };
    let mut value = None;
    if !secure && let Some(raw) = values[4].as_deref() {
        if is_checkable(&raw_role, subrole.as_deref()) {
            states.checked = ax::as_f64(raw).map(|number| number == 1.0);
        }
        value = as_string(raw);
    }
    let value_settable = !secure && element.is_settable("AXValue", deadline).unwrap_or(false);
    states.editable = is_text_role(&raw_role) && value_settable;

    let window_id = if with_window {
        values[10].as_deref().and_then(as_element).and_then(|window| window_id_of(&window, deadline))
    } else {
        None
    };

    Ok(ElementProbe {
        role: role_words(&raw_role, subrole.as_deref()),
        name: text(2).filter(|name| !name.is_empty()).or_else(|| text(3).filter(|text| !text.is_empty())),
        value,
        selected_range: values[9]
            .as_deref()
            .and_then(as_range)
            .map(|range| TextRange { start: range.location.max(0) as usize, length: range.length.max(0) as usize }),
        states,
        child_count: child_count(element, deadline),
        actions: element.action_names(deadline).map(|names| core_actions(&names)).unwrap_or_default(),
        value_settable,
        window_id,
    })
}

/// Window id (same scheme as [`windows`]) of an AX window element.
fn window_id_of(window: &AxElement, deadline: Deadline) -> Option<String> {
    let pid = window.pid().ok()?;
    let app = RunningApp {
        name: String::new(),
        bundle_id: String::new(),
        process: cu_core::platform::ProcessRef { pid, start_time: 0 },
    };
    window_pairs(&app, deadline).ok()?.into_iter().find(|(element, _)| element == window).map(|(_, info)| info.id)
}

/// Probes without the window lookup, which reads the whole window list.
pub fn probe(element: &AxElement, deadline: Deadline) -> CuResult<ElementProbe> {
    probe_element(element, deadline, false)
}

pub fn element_window_id(element: &AxElement, deadline: Deadline) -> Option<String> {
    let window = element.element("AXWindow", deadline).ok().flatten()?;
    window_id_of(&window, deadline)
}

pub fn parent(element: &AxElement, deadline: Deadline) -> Option<AxElement> {
    element.element("AXParent", deadline).ok().flatten()
}

pub fn children(element: &AxElement, deadline: Deadline) -> Vec<AxElement> {
    element.elements("AXChildren", deadline).unwrap_or_default()
}

pub fn focused_element(app: &RunningApp, deadline: Deadline) -> Option<AxElement> {
    AxElement::application(app.process.pid).element("AXFocusedUIElement", deadline).ok().flatten()
}

pub fn element_at(app: &RunningApp, x: f64, y: f64, deadline: Deadline) -> Option<AxElement> {
    AxElement::application(app.process.pid).element_at(x, y, deadline).ok().flatten()
}

// -- fingerprint --------------------------------------------------------------

/// Cheap observable state, polled every 50 ms while an action settles.
pub fn fingerprint(
    app: &RunningApp,
    window: Option<&WindowInfo>,
    target: Option<&AxElement>,
    deadline: Deadline,
) -> Fingerprint {
    let application = AxElement::application(app.process.pid);
    let Ok(values) = application.attrs(&["AXWindows", "AXFocusedUIElement", "AXChildren", "AXFocusedWindow"], deadline)
    else {
        return Fingerprint::default();
    };
    let windows = values[0].as_deref().map(as_elements).unwrap_or_default();
    let focused = values[1].as_deref().and_then(as_element);
    let app_children = values[2].as_deref().map(as_elements).unwrap_or_default();

    // Menus open as extra children of the application element.
    let menu_open = app_children.iter().filter(|child| !windows.contains(child)).any(|child| {
        child.string("AXRole", deadline).ok().flatten().as_deref() == Some("AXMenu")
    });

    // The target window: same frame as the requested window, else the focused one.
    let target_window = window
        .and_then(|window| {
            windows.iter().find(|candidate| {
                candidate.frame(deadline).ok().flatten().is_some_and(|frame| same_bounds(&frame, &window.bounds))
            })
        })
        .cloned()
        .or_else(|| values[3].as_deref().and_then(as_element));
    let mut hasher = DefaultHasher::new();
    if let Some(target_window) = &target_window
        && let Ok(window_values) = target_window.attrs(&["AXTitle", "AXChildren"], deadline)
    {
        window_values[0].as_deref().and_then(as_string).hash(&mut hasher);
        for child in window_values[1].as_deref().map(as_elements).unwrap_or_default() {
            element_hash(&child).hash(&mut hasher);
        }
    }

    let target_probe = target.and_then(|target| probe_element(target, deadline, false).ok());
    let parent_child_count = target.and_then(|target| parent(target, deadline)).map(|parent| child_count(&parent, deadline));

    Fingerprint {
        window_ids: windows.iter().map(|window| format!("{:x}", element_hash(window))).collect(),
        focused_element: focused.as_ref().map(element_hash),
        target: target_probe,
        parent_child_count,
        menu_open,
        window_hash: hasher.finish(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cu_core::tree::roles;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect { x, y, width, height }
    }

    #[test]
    fn matches_window_server_windows_by_bounds_and_title() {
        let cg = vec![
            CgWindow { id: 10, bounds: rect(0.0, 0.0, 100.0, 100.0), title: Some("Other".into()) },
            CgWindow { id: 11, bounds: rect(0.0, 0.0, 100.0, 100.0), title: Some("Doc".into()) },
            CgWindow { id: 12, bounds: rect(200.0, 0.0, 50.0, 50.0), title: None },
        ];
        let ax = vec![(rect(0.5, 0.0, 100.0, 100.0), "Doc".to_owned()), (rect(200.0, 0.0, 50.0, 50.0), "Untitled".to_owned())];
        assert_eq!(match_cg_windows(&ax, &cg), vec![Some(11), Some(12)]);

        let unmatched = vec![(rect(500.0, 500.0, 10.0, 10.0), "Nope".to_owned())];
        assert_eq!(match_cg_windows(&unmatched, &cg), vec![None]);
    }

    #[test]
    fn uses_each_window_server_id_once() {
        let cg = vec![CgWindow { id: 7, bounds: rect(0.0, 0.0, 10.0, 10.0), title: None }];
        let ax = vec![(rect(0.0, 0.0, 10.0, 10.0), "A".to_owned()), (rect(0.0, 0.0, 10.0, 10.0), "B".to_owned())];
        assert_eq!(match_cg_windows(&ax, &cg), vec![Some(7), None]);
    }

    #[test]
    fn detects_offscreen_nodes() {
        let window = rect(100.0, 100.0, 400.0, 300.0);
        assert!(is_offscreen(Some(rect(0.0, 0.0, 50.0, 50.0)), &window));
        assert!(is_offscreen(Some(rect(100.0, 400.0, 50.0, 20.0)), &window));
        assert!(!is_offscreen(Some(rect(90.0, 90.0, 50.0, 50.0)), &window));
        assert!(!is_offscreen(Some(rect(0.0, 0.0, 0.0, 0.0)), &window));
        assert!(!is_offscreen(None, &window));
    }

    #[test]
    fn chooses_children_and_checkable_roles() {
        assert!(uses_visible_rows("AXTable"));
        assert!(uses_visible_rows("AXOutline"));
        assert!(!uses_visible_rows("AXList"));
        assert!(is_checkable("AXCheckBox", None));
        assert!(is_checkable("AXCheckBox", Some("AXSwitch")));
        assert!(!is_checkable("AXRadioButton", Some("AXTabButton")));
        assert!(skips_actions("AXStaticText"));
        assert!(!skips_actions("AXButton"));
        assert_eq!(roles::STATIC_TEXT, role_words("AXStaticText", None));
    }
}
