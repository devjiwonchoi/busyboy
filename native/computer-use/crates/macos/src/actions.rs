//! Element actions, value and text writes, scrolling, and menu-bar walks.
//!
//! Everything here is an accessibility call on the target app's elements. Nothing
//! posts events, activates the app, or raises windows.

use std::collections::VecDeque;

use cu_core::platform::{RunningApp, unsupported};
use cu_core::text::menu_title_matches;
use cu_core::tree::{ElementAction, WindowInfo};
use cu_core::{CuResult, Deadline};
use cu_protocol::{FillValue, ScrollAmount, ScrollDirection, TextRange};
use objc2_application_services::AXUIElement;
use objc2_core_foundation::{CFArray, CFNumber, CFRetained, CFString, CFType, Type};

use crate::ax::{self, AxElement, AxFailure, AxResult, cf_bool, cfstr, range_value};

fn ax_err<T>(result: AxResult<T>, phase: &str) -> CuResult<T> {
    result.map_err(|failure| failure.to_error(phase))
}

pub fn perform(element: &AxElement, action: ElementAction, deadline: Deadline) -> CuResult<()> {
    let name = ax::action_name(action);
    deadline.check(name)?;
    ax_err(element.perform(name, deadline), name)
}

pub fn set_value(element: &AxElement, value: &FillValue, deadline: Deadline) -> CuResult<()> {
    deadline.check("set value")?;
    // Match the type the element already holds: many controls keep numbers (sliders,
    // checkboxes as 0/1) and reject strings, and text fields reject numbers.
    let current = element.attr("AXValue", deadline).ok().flatten();
    let holds_number = current.as_deref().is_some_and(|value| value.downcast_ref::<CFNumber>().is_some());
    let holds_text = current.as_deref().is_some_and(|value| value.downcast_ref::<CFString>().is_some());

    let written: CFRetained<CFType> = match value {
        FillValue::Text(text) => match text.trim().parse::<f64>() {
            Ok(number) if holds_number => number_value(number),
            _ => cf(cfstr(text)),
        },
        FillValue::Number(number) if holds_text => cf(cfstr(&format_number(*number))),
        FillValue::Number(number) => number_value(*number),
        FillValue::Bool(flag) if holds_number => cf(CFNumber::new_i32(i32::from(*flag))),
        FillValue::Bool(flag) => cf(cf_bool(*flag)),
    };
    ax_err(element.set_attr("AXValue", &written, deadline), "set value")
}

pub fn set_selected_text(element: &AxElement, text: &str, deadline: Deadline) -> CuResult<()> {
    deadline.check("type")?;
    ax_err(element.set_attr("AXSelectedText", &cfstr(text), deadline), "type")
}

pub fn set_selected_range(element: &AxElement, range: TextRange, deadline: Deadline) -> CuResult<()> {
    deadline.check("select text")?;
    let value = range_value(range.start, range.length);
    ax_err(element.set_attr("AXSelectedTextRange", &value, deadline), "select text")
}

pub fn set_selected(element: &AxElement, selected: bool, deadline: Deadline) -> CuResult<()> {
    deadline.check("select")?;
    if element.is_settable("AXSelected", deadline).unwrap_or(false) {
        return ax_err(element.set_attr("AXSelected", &cf_bool(selected), deadline), "select");
    }
    // Rows often keep `AXSelected` read-only; the owning table or outline takes the
    // selection through `AXSelectedRows` (lists and others through `AXSelectedChildren`).
    let parent = ax_err(element.element("AXParent", deadline), "select")?;
    if let Some(parent) = parent {
        for attribute in ["AXSelectedRows", "AXSelectedChildren"] {
            if !parent.is_settable(attribute, deadline).unwrap_or(false) {
                continue;
            }
            let mut rows = if selected { Vec::new() } else { parent.elements(attribute, deadline).unwrap_or_default() };
            if selected {
                rows.push(element.clone());
            } else {
                rows.retain(|row| row != element);
            }
            let handles: Vec<CFRetained<AXUIElement>> = rows.into_iter().map(|row| row.0).collect();
            let array = CFArray::from_retained_objects(&handles);
            return ax_err(parent.set_attr(attribute, &array, deadline), "select");
        }
    }
    // Last try: the write may still work even though the app reports it read-only.
    ax_err(element.set_attr("AXSelected", &cf_bool(selected), deadline), "select")
}

pub fn set_focused(element: &AxElement, deadline: Deadline) -> CuResult<()> {
    deadline.check("focus")?;
    // Focus within the app only. Never AXRaise / AXMain / AXFrontmost / activate.
    ax_err(element.set_attr("AXFocused", &cf_bool(true), deadline), "focus")
}

// -- scrolling ------------------------------------------------------------------

/// Fallback steps in scroll-bar value units (0.0–1.0) when sizes are unknown.
const LINE_STEP: f64 = 0.05;
const PAGE_STEP: f64 = 0.25;
/// One line, in points, when sizes are known.
const LINE_POINTS: f64 = 40.0;
/// Share of the visible size one page moves (keeps a little context on screen).
const PAGE_OVERLAP: f64 = 0.9;

pub fn scroll_area(
    element: &AxElement,
    direction: ScrollDirection,
    amount: ScrollAmount,
    deadline: Deadline,
) -> CuResult<()> {
    deadline.check("scroll")?;
    let vertical = matches!(direction, ScrollDirection::Up | ScrollDirection::Down);
    let forward = matches!(direction, ScrollDirection::Down | ScrollDirection::Right);
    let mut tried = Vec::new();

    if let Some(bar) = scroll_bar(element, vertical, deadline) {
        // 1. Move the bar's value.
        if bar.is_settable("AXValue", deadline).unwrap_or(false) {
            tried.push("scroll_bar_value");
            let current = bar.attr("AXValue", deadline).ok().flatten().as_deref().and_then(ax::as_f64);
            if let Some(current) = current {
                let step = scroll_step(element, vertical, amount, deadline);
                let target = next_scroll_value(current, step, forward);
                if bar.set_attr("AXValue", &number_value(target), deadline).is_ok() {
                    return Ok(());
                }
            }
        }
        // 2. The bar's own step actions.
        let actions = bar.action_names(deadline).unwrap_or_default();
        for name in bar_actions(vertical, forward, amount) {
            if actions.iter().any(|action| action == name) {
                tried.push(name);
                if bar.perform(name, deadline).is_ok() {
                    return Ok(());
                }
            }
        }
    }

    // 3. Page actions some scroll areas advertise themselves.
    let actions = element.action_names(deadline).unwrap_or_default();
    for name in area_actions(vertical, forward) {
        if actions.iter().any(|action| action == name) {
            tried.push(name);
            if element.perform(name, deadline).is_ok() {
                return Ok(());
            }
        }
    }

    Err(unsupported("no_scroll_bar", "this scroll area has no scroll bar or page action to move")
        .with_details(serde_json::json!({ "reason": "no_scroll_bar", "tried": tried })))
}

/// The area's scroll bar for one axis: the standard attribute first, then a child
/// scroll bar with the matching `AXOrientation`.
fn scroll_bar(area: &AxElement, vertical: bool, deadline: Deadline) -> Option<AxElement> {
    let attribute = if vertical { "AXVerticalScrollBar" } else { "AXHorizontalScrollBar" };
    if let Ok(Some(bar)) = area.element(attribute, deadline) {
        return Some(bar);
    }
    let orientation = if vertical { "AXVerticalOrientation" } else { "AXHorizontalOrientation" };
    area.elements("AXChildren", deadline).ok()?.into_iter().find(|child| {
        child
            .attrs(&["AXRole", "AXOrientation"], deadline)
            .ok()
            .map(|values| {
                let text = |index: usize| values[index].as_deref().and_then(ax::as_string);
                text(0).as_deref() == Some("AXScrollBar") && text(1).as_deref() == Some(orientation)
            })
            .unwrap_or(false)
    })
}

/// Step in value units: derived from visible vs content size along the axis when
/// both are known, else fixed fractions.
fn scroll_step(area: &AxElement, vertical: bool, amount: ScrollAmount, deadline: Deadline) -> f64 {
    let along = |rect: cu_core::tree::Rect| if vertical { rect.height } else { rect.width };
    let visible = area.frame(deadline).ok().flatten().map(along);
    let content = area.elements("AXContents", deadline).ok().and_then(|contents| {
        contents.into_iter().filter_map(|item| item.frame(deadline).ok().flatten()).map(along).reduce(f64::max)
    });
    step_fraction(visible, content, amount)
}

/// Pure step math. The bar's value spans the scrollable range `content - visible`.
fn step_fraction(visible: Option<f64>, content: Option<f64>, amount: ScrollAmount) -> f64 {
    if let (Some(visible), Some(content)) = (visible, content) {
        let range = content - visible;
        if visible > 0.0 && range > 0.0 {
            let points = match amount {
                ScrollAmount::Line => LINE_POINTS,
                ScrollAmount::Page => visible * PAGE_OVERLAP,
            };
            return (points / range).clamp(0.001, 1.0);
        }
    }
    match amount {
        ScrollAmount::Line => LINE_STEP,
        ScrollAmount::Page => PAGE_STEP,
    }
}

fn next_scroll_value(current: f64, step: f64, forward: bool) -> f64 {
    let next = if forward { current + step } else { current - step };
    next.clamp(0.0, 1.0)
}

/// Scroll-bar actions to try, most specific first. Increment moves down/right.
fn bar_actions(vertical: bool, forward: bool, amount: ScrollAmount) -> Vec<&'static str> {
    let page = match (vertical, forward) {
        (true, true) => ["AXScrollDownByPage", "AXScrollPageDown"],
        (true, false) => ["AXScrollUpByPage", "AXScrollPageUp"],
        (false, true) => ["AXScrollRightByPage", "AXScrollPageRight"],
        (false, false) => ["AXScrollLeftByPage", "AXScrollPageLeft"],
    };
    let step = if forward { "AXIncrement" } else { "AXDecrement" };
    match amount {
        ScrollAmount::Page => vec![page[0], page[1], step],
        ScrollAmount::Line => vec![step],
    }
}

fn area_actions(vertical: bool, forward: bool) -> [&'static str; 2] {
    match (vertical, forward) {
        (true, true) => ["AXScrollDownByPage", "AXScrollPageDown"],
        (true, false) => ["AXScrollUpByPage", "AXScrollPageUp"],
        (false, true) => ["AXScrollRightByPage", "AXScrollPageRight"],
        (false, false) => ["AXScrollLeftByPage", "AXScrollPageLeft"],
    }
}

/// How deep below the window to look for scroll areas, and how many nodes at most.
const SCROLL_SEARCH_DEPTH: usize = 5;
const SCROLL_SEARCH_NODES: usize = 300;

pub fn main_scroll_area(app: &RunningApp, window: &WindowInfo, deadline: Deadline) -> Option<AxElement> {
    let root = crate::tree::window_element(app, window, deadline)?;
    let mut queue = VecDeque::from([(root, 0usize)]);
    let mut visited = 0;
    let mut best: Option<(f64, AxElement)> = None;
    while let Some((element, depth)) = queue.pop_front() {
        visited += 1;
        if visited > SCROLL_SEARCH_NODES || deadline.expired() {
            break;
        }
        let Ok(values) = element.attrs(&["AXRole", "AXPosition", "AXSize", "AXChildren"], deadline) else {
            continue;
        };
        let role = values[0].as_deref().and_then(ax::as_string);
        if role.as_deref() == Some("AXScrollArea") {
            let area = ax::rect_from(values[1].as_deref(), values[2].as_deref())
                .map(|rect| rect.width * rect.height)
                .unwrap_or(0.0);
            if best.as_ref().is_none_or(|(largest, _)| area > *largest) {
                best = Some((area, element));
            }
            // Nested scroll areas are smaller than their container; do not descend.
            continue;
        }
        if depth >= SCROLL_SEARCH_DEPTH {
            continue;
        }
        let children = values[3].as_deref().map(ax::as_elements).unwrap_or_default();
        queue.extend(children.into_iter().map(|child| (child, depth + 1)));
    }
    best.map(|(_, element)| element)
}

// -- menus ------------------------------------------------------------------------

/// Most titles listed in a `menu_item_not_found` error.
const MAX_AVAILABLE: usize = 30;

struct MenuEntry {
    element: AxElement,
    title: String,
    enabled: bool,
}

pub fn press_menu_path(app: &RunningApp, path: &[String], deadline: Deadline) -> CuResult<()> {
    let app_element = AxElement::application(app.process.pid);
    let menu_bar = ax_err(app_element.element("AXMenuBar", deadline), "menu walk")?
        .ok_or_else(|| unsupported("no_menu_bar", format!("{} has no menu bar", app.name)))?;

    let mut container = menu_bar;
    for (index, wanted) in path.iter().enumerate() {
        deadline.check("menu walk")?;
        let entries = ax_err(menu_entries(&container, deadline), "menu walk")?;
        let Some(entry) = entries.iter().find(|entry| menu_title_matches(&entry.title, wanted)) else {
            return Err(not_found(wanted, &path[..index], &entries));
        };
        if index + 1 == path.len() {
            if !entry.enabled {
                return Err(unsupported("menu_item_disabled", format!("the menu item {wanted:?} is disabled")));
            }
            return ax_err(entry.element.perform("AXPress", deadline), "menu press");
        }
        container = entry.element.clone();
    }
    Err(unsupported("menu_item_not_found", "the menu path is empty"))
}

/// Titled entries one level below `container`. The menu bar holds items directly;
/// a menu bar item or a menu item holds them inside its `AXMenu` child. Reading
/// these attributes does not open the menu on screen.
fn menu_entries(container: &AxElement, deadline: Deadline) -> AxResult<Vec<MenuEntry>> {
    let role = container.string("AXRole", deadline)?;
    let items = if role.as_deref() == Some("AXMenuBar") {
        container.elements("AXChildren", deadline)?
    } else {
        let menu = container
            .elements("AXChildren", deadline)?
            .into_iter()
            .find(|child| child.string("AXRole", deadline).ok().flatten().as_deref() == Some("AXMenu"));
        match menu {
            Some(menu) => menu.elements("AXChildren", deadline)?,
            None => Vec::new(),
        }
    };

    let mut entries = Vec::with_capacity(items.len());
    for item in items {
        let values = match item.attrs(&["AXTitle", "AXEnabled"], deadline) {
            Ok(values) => values,
            Err(AxFailure::Timeout) => return Err(AxFailure::Timeout),
            Err(_) => continue,
        };
        // Separators and spacer items have no title.
        let Some(title) = values[0].as_deref().and_then(ax::as_string).filter(|title| !title.trim().is_empty()) else {
            continue;
        };
        let enabled = values[1].as_deref().and_then(ax::as_bool).unwrap_or(true);
        entries.push(MenuEntry { element: item, title, enabled });
    }
    Ok(entries)
}

fn not_found(wanted: &str, parents: &[String], entries: &[MenuEntry]) -> cu_protocol::ErrorObject {
    let available: Vec<&str> = entries.iter().take(MAX_AVAILABLE).map(|entry| entry.title.as_str()).collect();
    let place =
        if parents.is_empty() { "the menu bar".to_owned() } else { format!("the {:?} menu", parents.join(" > ")) };
    unsupported("menu_item_not_found", format!("no menu item {wanted:?} in {place}"))
        .with_details(serde_json::json!({ "reason": "menu_item_not_found", "available": available }))
}

// -- values -----------------------------------------------------------------------

fn cf<T: AsRef<CFType>>(value: CFRetained<T>) -> CFRetained<CFType> {
    let value: &CFType = (*value).as_ref();
    value.retain()
}

fn number_value(number: f64) -> CFRetained<CFType> {
    if number.fract() == 0.0 && number.abs() < i64::MAX as f64 {
        cf(CFNumber::new_i64(number as i64))
    } else {
        cf(CFNumber::new_f64(number))
    }
}

fn format_number(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() < 1e15 { format!("{}", number as i64) } else { format!("{number}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_from_sizes_or_constants() {
        // 500 visible of 1500 content: range 1000, a page is 450 points.
        assert!((step_fraction(Some(500.0), Some(1500.0), ScrollAmount::Page) - 0.45).abs() < 1e-9);
        assert!((step_fraction(Some(500.0), Some(1500.0), ScrollAmount::Line) - 0.04).abs() < 1e-9);
        // Content no larger than the view, or unknown sizes: constants.
        assert_eq!(step_fraction(Some(500.0), Some(400.0), ScrollAmount::Page), PAGE_STEP);
        assert_eq!(step_fraction(None, Some(400.0), ScrollAmount::Line), LINE_STEP);
        // Tiny range: one page covers it all.
        assert_eq!(step_fraction(Some(500.0), Some(510.0), ScrollAmount::Page), 1.0);
    }

    #[test]
    fn scroll_values_stay_in_bounds() {
        assert_eq!(next_scroll_value(0.9, 0.25, true), 1.0);
        assert_eq!(next_scroll_value(0.1, 0.25, false), 0.0);
        assert!((next_scroll_value(0.5, 0.25, true) - 0.75).abs() < 1e-9);
    }

    #[test]
    fn picks_scroll_actions_by_direction() {
        assert_eq!(bar_actions(true, true, ScrollAmount::Line), vec!["AXIncrement"]);
        assert_eq!(bar_actions(true, false, ScrollAmount::Page)[0], "AXScrollUpByPage");
        assert_eq!(bar_actions(false, true, ScrollAmount::Page).last(), Some(&"AXIncrement"));
        assert_eq!(area_actions(false, false)[0], "AXScrollLeftByPage");
    }

    #[test]
    fn formats_numbers_for_text_values() {
        assert_eq!(format_number(3.0), "3");
        assert_eq!(format_number(2.5), "2.5");
    }

    // Live: walks TextEdit's real menu bar and presses Format > Font > Bold. Not run in
    // CI; needs Accessibility and a running TextEdit with a rich-text document.
    #[test]
    #[ignore]
    fn live_presses_textedit_menu() {
        let output = std::process::Command::new("pgrep").arg("-x").arg("TextEdit").output().unwrap();
        let pid: i32 = String::from_utf8_lossy(&output.stdout).trim().parse().unwrap();
        let app = RunningApp {
            name: "TextEdit".into(),
            bundle_id: "com.apple.TextEdit".into(),
            process: cu_core::platform::ProcessRef { pid, start_time: 0 },
        };
        let path = ["Format", "Font", "Bold"].map(String::from);
        press_menu_path(&app, &path, Deadline::after(std::time::Duration::from_secs(2))).unwrap();
        let error = press_menu_path(
            &app,
            &["Format".into(), "Nope".into()],
            Deadline::after(std::time::Duration::from_secs(2)),
        )
        .unwrap_err();
        assert_eq!(error.details.unwrap()["reason"], "menu_item_not_found");
    }
}
