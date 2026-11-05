//! In-memory [`Platform`] for tests. It models one or more apps with a small element
//! tree and applies actions to that tree, so engine behavior can be tested without an OS.

use std::collections::{BTreeMap, HashMap};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::{Arc, Mutex};

use cu_protocol::{
    AppEntry, ErrorCode, ErrorObject, FillValue, GrantStatus, MouseButton, PermissionKind, PermissionsStatus, Screenshot,
    ScreenshotOmitted, ScrollAmount, ScrollDirection, StopMonitorStatus, TextRange,
};

use crate::keys::{Key, KeyChord, Modifiers};
use crate::platform::*;
use crate::text::menu_title_matches;
use crate::tree::*;
use crate::{CancelToken, CuResult, Deadline};

#[derive(Debug, Clone, Default)]
pub struct FakeNode {
    pub role: String,
    pub name: Option<String>,
    pub value: Option<String>,
    pub states: NodeStates,
    pub actions: Vec<ElementAction>,
    pub value_settable: bool,
    /// Accepts selected-text writes (most text views do).
    pub accepts_selected_text: bool,
    pub selected_range: Option<TextRange>,
    pub children: Vec<u64>,
    pub parent: Option<u64>,
    pub window: String,
    pub bounds: Option<Rect>,
    /// Times pressed.
    pub presses: u32,
}

#[derive(Debug, Clone)]
pub struct FakeApp {
    pub name: String,
    pub bundle_id: Option<String>,
    pub process: Option<ProcessRef>,
    pub windows: Vec<WindowInfo>,
    /// Root element id per window id.
    pub roots: HashMap<String, u64>,
    pub focused: Option<u64>,
    pub menus: Vec<(Vec<String>, bool)>,
    pub needs_web_accessibility: bool,
}

/// One experimental pointer delivery, in window-local points.
#[derive(Debug, Clone, PartialEq)]
pub enum PointerCall {
    Click { window: String, x: f64, y: f64, button: MouseButton, count: u32 },
    Scroll { window: String, x: f64, y: f64, direction: ScrollDirection, times: u32 },
}

#[derive(Default)]
pub struct FakeWorld {
    pub apps: Vec<FakeApp>,
    pub nodes: BTreeMap<u64, FakeNode>,
    pub next_id: u64,
    pub locked: bool,
    pub accessibility: bool,
    pub screen_recording: bool,
    pub monitor_armed: bool,
    pub monitor_targets: Vec<MonitorTarget>,
    pub posted_keys: Vec<KeyChord>,
    pub posted_text: Vec<String>,
    pub pressed_menus: Vec<Vec<String>>,
    pub web_accessibility_enabled: HashMap<String, bool>,
    pub web_accessibility_restored: Vec<String>,
    pub launched: Vec<String>,
    /// Snapshot calls, for timing-sensitive tests.
    pub snapshots: usize,
    /// Each snapshot sleeps this long, so tests can cancel mid-request.
    pub snapshot_delay_ms: u64,
    /// Route the fake pointer reports; `None` makes it unavailable.
    pub pointer_route: Option<PointerRoute>,
    /// Every pointer delivery the engine asked for.
    pub pointer_calls: Vec<PointerCall>,
    /// When set, only this many more fingerprint reads succeed; later ones get no
    /// answer, like an app that times out.
    pub fingerprint_reads_left: Option<usize>,
    /// When set, every posted key also counts a press on this node, like an app
    /// that redraws something unrelated on each key.
    pub key_side_effect: Option<u64>,
    /// Window reads time out while the per-call limit is below this, like a
    /// napping app that answers slowly.
    pub window_read_needs: std::time::Duration,
    /// The next this-many window reads time out, like a brief stall.
    pub window_read_timeouts: usize,
    /// Window reads so far, including failed ones.
    pub window_reads: usize,
}

#[derive(Default)]
pub struct FakePlatform {
    pub world: Mutex<FakeWorld>,
    sink: Mutex<Option<EventSink>>,
}

fn not_found(message: &str) -> ErrorObject {
    ErrorObject::new(ErrorCode::AppNotFound, message)
}

impl FakePlatform {
    pub fn new() -> Self {
        let platform = FakePlatform::default();
        {
            let mut world = platform.world.lock().unwrap();
            world.accessibility = true;
            world.next_id = 1;
            world.pointer_route = Some(PointerRoute::WindowServer);
        }
        platform
    }

    /// Emits an event as if the OS reported it.
    pub fn emit(&self, event: PlatformEvent) {
        let sink = self.sink.lock().unwrap().clone();
        if let Some(sink) = sink {
            sink(event);
        }
    }

    pub fn with_world<T>(&self, f: impl FnOnce(&mut FakeWorld) -> T) -> T {
        f(&mut self.world.lock().unwrap())
    }

    /// Adds a node and returns its id.
    pub fn add_node(&self, parent: Option<u64>, window: &str, node: FakeNode) -> u64 {
        self.with_world(|world| {
            let id = world.next_id;
            world.next_id += 1;
            world.nodes.insert(id, FakeNode { parent, window: window.to_owned(), ..node });
            if let Some(parent) = parent {
                world.nodes.get_mut(&parent).unwrap().children.push(id);
            }
            id
        })
    }

    /// A running TextEdit-like app with a window, a Bold button, and a text area.
    /// Returns `(bold, text_area)` node ids.
    pub fn with_text_editor(&self) -> (u64, u64) {
        let window = WindowInfo {
            id: "w1".into(),
            title: "Untitled".into(),
            bounds: Rect { x: 100.0, y: 100.0, width: 600.0, height: 400.0 },
            minimized: false,
            main: true,
            focused: true,
            private: false,
        };
        self.with_world(|world| {
            world.apps.push(FakeApp {
                name: "TextEdit".into(),
                bundle_id: Some("com.apple.TextEdit".into()),
                process: Some(ProcessRef { pid: 4121, start_time: 7 }),
                windows: vec![window],
                roots: HashMap::new(),
                focused: None,
                menus: vec![(vec!["Format".into(), "Font".into(), "Bold".into()], true), (vec!["File".into(), "Print…".into()], false)],
                needs_web_accessibility: false,
            })
        });
        let root = self.add_node(None, "w1", FakeNode { role: roles::WINDOW.into(), name: Some("Untitled".into()), ..FakeNode::default() });
        let toolbar = self.add_node(Some(root), "w1", FakeNode { role: "toolbar".into(), ..FakeNode::default() });
        let bold = self.add_node(
            Some(toolbar),
            "w1",
            FakeNode {
                role: "button".into(),
                name: Some("Bold".into()),
                actions: vec![ElementAction::Press],
                bounds: Some(Rect { x: 110.0, y: 110.0, width: 30.0, height: 20.0 }),
                ..FakeNode::default()
            },
        );
        let text = self.add_node(
            Some(root),
            "w1",
            FakeNode {
                role: roles::TEXT_AREA.into(),
                value: Some("Hello".into()),
                value_settable: true,
                accepts_selected_text: true,
                states: NodeStates { editable: true, focused: true, ..NodeStates::default() },
                bounds: Some(Rect { x: 100.0, y: 140.0, width: 600.0, height: 360.0 }),
                ..FakeNode::default()
            },
        );
        self.with_world(|world| {
            let app = world.apps.last_mut().unwrap();
            app.roots.insert("w1".into(), root);
            app.focused = Some(text);
        });
        (bold, text)
    }

    fn app_index(world: &FakeWorld, app: &RunningApp) -> Option<usize> {
        world.apps.iter().position(|candidate| candidate.process == Some(app.process))
    }

    fn probe_node(world: &FakeWorld, id: u64) -> Option<ElementProbe> {
        let node = world.nodes.get(&id)?;
        Some(ElementProbe {
            role: node.role.clone(),
            name: node.name.clone(),
            value: if node.states.secure { None } else { node.value.clone() },
            selected_range: node.selected_range,
            states: node.states.clone(),
            child_count: node.children.len(),
            actions: node.actions.clone(),
            value_settable: node.value_settable,
            window_id: Some(node.window.clone()),
        })
    }
}

impl Platform for FakePlatform {
    type Element = u64;

    fn name(&self) -> &'static str {
        "fake"
    }

    fn capabilities(&self) -> Vec<String> {
        Vec::new()
    }

    fn set_event_sink(&self, sink: EventSink) {
        *self.sink.lock().unwrap() = Some(sink);
    }

    fn permissions(&self) -> PermissionsStatus {
        self.with_world(|world| PermissionsStatus {
            accessibility: if world.accessibility { GrantStatus::Granted } else { GrantStatus::NotGranted },
            screen_recording: if world.screen_recording { GrantStatus::Granted } else { GrantStatus::NotGranted },
            stop_monitor: StopMonitorStatus::Available,
        })
    }

    fn request_permission(&self, _kind: PermissionKind) -> CuResult<()> {
        Ok(())
    }

    fn list_apps(&self, _include_installed: bool) -> CuResult<Vec<AppEntry>> {
        Ok(self.with_world(|world| {
            world
                .apps
                .iter()
                .map(|app| AppEntry {
                    name: app.name.clone(),
                    bundle_id: app.bundle_id.clone(),
                    running: app.process.is_some(),
                    pid: app.process.map(|process| process.pid),
                    regular: true,
                    forbidden: None,
                })
                .collect()
        }))
    }

    fn resolve_app(&self, query: &str) -> CuResult<AppTarget> {
        self.with_world(|world| {
            world
                .apps
                .iter()
                .find(|app| app.bundle_id.as_deref() == Some(query) || app.name.eq_ignore_ascii_case(query))
                .map(|app| AppTarget { name: app.name.clone(), bundle_id: app.bundle_id.clone(), process: app.process })
                .ok_or_else(|| not_found("no such app"))
        })
    }

    fn process_start_time(&self, pid: i32) -> Option<u64> {
        self.with_world(|world| {
            world.apps.iter().filter_map(|app| app.process).find(|process| process.pid == pid).map(|process| process.start_time)
        })
    }

    fn launch_app(&self, bundle_id: &str, _deadline: Deadline) -> CuResult<LaunchOutcome> {
        self.with_world(|world| {
            let next_pid = 9000 + world.launched.len() as i32;
            let app = world
                .apps
                .iter_mut()
                .find(|app| app.bundle_id.as_deref() == Some(bundle_id))
                .ok_or_else(|| ErrorObject::new(ErrorCode::AppLaunchFailed, "not installed"))?;
            let process = ProcessRef { pid: next_pid, start_time: 1 };
            app.process = Some(process);
            let outcome = LaunchOutcome {
                app: RunningApp { name: app.name.clone(), bundle_id: bundle_id.to_owned(), process },
                focus_changed: false,
            };
            world.launched.push(bundle_id.to_owned());
            Ok(outcome)
        })
    }

    fn windows(&self, app: &RunningApp, deadline: Deadline) -> CuResult<Vec<WindowInfo>> {
        self.with_world(|world| {
            world.window_reads += 1;
            let stalled = world.window_read_timeouts > 0;
            world.window_read_timeouts = world.window_read_timeouts.saturating_sub(1);
            if stalled || deadline.call_timeout() < world.window_read_needs {
                return Err(ErrorObject::new(ErrorCode::Timeout, "the app did not respond during reading windows")
                    .with_details(serde_json::json!({ "phase": "reading windows" })));
            }
            let index = Self::app_index(world, app).ok_or_else(|| not_found("app is not running"))?;
            Ok(world.apps[index].windows.clone())
        })
    }

    fn snapshot(
        &self,
        app: &RunningApp,
        window: &WindowInfo,
        budget: &TreeBudget,
        deadline: Deadline,
        cancel: &CancelToken,
    ) -> CuResult<RawTree<u64>> {
        let delay = self.with_world(|world| world.snapshot_delay_ms);
        if delay > 0 {
            for _ in 0..delay / 10 {
                std::thread::sleep(std::time::Duration::from_millis(10));
                cancel.check()?;
            }
        }
        self.with_world(|world| {
            world.snapshots += 1;
            let index = Self::app_index(world, app).ok_or_else(|| not_found("app is not running"))?;
            let fake_app = &world.apps[index];
            let root = *fake_app
                .roots
                .get(&window.id)
                .ok_or_else(|| ErrorObject::new(ErrorCode::WindowNotFound, "no such window"))?;
            let needs_web = fake_app.needs_web_accessibility
                && !world.web_accessibility_enabled.get(&app.bundle_id).copied().unwrap_or(false);

            let mut tree = RawTree {
                nodes: Vec::new(),
                truncated: None,
                menus: fake_app.menus.iter().filter_map(|(path, _)| path.first().cloned()).collect(),
                needs_web_accessibility: needs_web,
            };
            let mut stack = vec![(root, None::<usize>, 0usize)];
            while let Some((id, parent, depth)) = stack.pop() {
                if deadline.expired() {
                    tree.truncated = Some(cu_protocol::Truncation::Deadline);
                    break;
                }
                if tree.nodes.len() >= budget.max_nodes {
                    tree.truncated = Some(cu_protocol::Truncation::Nodes);
                    break;
                }
                let node = &world.nodes[&id];
                let (value, value_len) = match (&node.value, node.states.secure) {
                    (Some(value), false) => {
                        let (cut, total) = cut_text(value, budget.max_text);
                        (Some(cut), total)
                    }
                    _ => (None, 0),
                };
                let index = tree.nodes.len();
                tree.nodes.push(RawNode {
                    handle: id,
                    role: node.role.clone(),
                    name: node.name.clone(),
                    value,
                    value_len,
                    description: None,
                    states: NodeStates { focused: fake_app.focused == Some(id), ..node.states.clone() },
                    bounds: node.bounds,
                    actions: node.actions.clone(),
                    children: Vec::new(),
                });
                if let Some(parent) = parent {
                    tree.nodes[parent].children.push(index);
                }
                if depth + 1 >= budget.max_depth {
                    if !node.children.is_empty() {
                        tree.truncated.get_or_insert(cu_protocol::Truncation::Depth);
                    }
                    continue;
                }
                for child in node.children.iter().rev() {
                    stack.push((*child, Some(index), depth + 1));
                }
            }
            Ok(tree)
        })
    }

    fn element_key(&self, element: &u64) -> u64 {
        *element
    }

    fn same_element(&self, a: &u64, b: &u64) -> bool {
        a == b
    }

    fn element_status(&self, element: &u64, _deadline: Deadline) -> ElementStatus {
        self.with_world(|world| {
            let Some(node) = world.nodes.get(element) else {
                return ElementStatus::Invalid;
            };
            let pid = world
                .apps
                .iter()
                .find(|app| app.roots.values().any(|root| is_ancestor(world, *root, *element)))
                .and_then(|app| app.process)
                .map(|process| process.pid)
                .unwrap_or(0);
            ElementStatus::Alive { role: node.role.clone(), pid }
        })
    }

    fn probe(&self, element: &u64, _deadline: Deadline) -> CuResult<ElementProbe> {
        self.with_world(|world| {
            Self::probe_node(world, *element).ok_or_else(|| ErrorObject::new(ErrorCode::StaleElement, "element is gone"))
        })
    }

    fn element_window_id(&self, element: &u64, _deadline: Deadline) -> Option<String> {
        self.with_world(|world| world.nodes.get(element).map(|node| node.window.clone()))
    }

    fn parent(&self, element: &u64, _deadline: Deadline) -> Option<u64> {
        self.with_world(|world| world.nodes.get(element)?.parent)
    }

    fn children(&self, element: &u64, _deadline: Deadline) -> Vec<u64> {
        self.with_world(|world| world.nodes.get(element).map(|node| node.children.clone()).unwrap_or_default())
    }

    fn focused_element(&self, app: &RunningApp, _deadline: Deadline) -> Option<u64> {
        self.with_world(|world| world.apps[Self::app_index(world, app)?].focused)
    }

    fn element_at(&self, app: &RunningApp, x: f64, y: f64, _deadline: Deadline) -> Option<u64> {
        self.with_world(|world| {
            let fake_app = &world.apps[Self::app_index(world, app)?];
            // Smallest node whose bounds contain the point.
            world
                .nodes
                .iter()
                .filter(|(id, node)| {
                    fake_app.roots.values().any(|root| is_ancestor(world, *root, **id))
                        && node.bounds.is_some_and(|bounds| bounds.contains(x, y))
                })
                .min_by(|(_, a), (_, b)| {
                    let area = |node: &FakeNode| node.bounds.map(|bounds| bounds.width * bounds.height).unwrap_or(f64::MAX);
                    area(a).total_cmp(&area(b))
                })
                .map(|(id, _)| *id)
        })
    }

    fn fingerprint(
        &self,
        app: &RunningApp,
        _window: Option<&WindowInfo>,
        target: Option<&u64>,
        _deadline: Deadline,
    ) -> Option<Fingerprint> {
        self.with_world(|world| {
            if let Some(left) = &mut world.fingerprint_reads_left {
                if *left == 0 {
                    return None;
                }
                *left -= 1;
            }
            let Some(index) = Self::app_index(world, app) else {
                return Some(Fingerprint::default());
            };
            let fake_app = &world.apps[index];
            let mut hasher = DefaultHasher::new();
            for node in world.nodes.values() {
                node.value.hash(&mut hasher);
                node.children.len().hash(&mut hasher);
                node.presses.hash(&mut hasher);
            }
            Some(Fingerprint {
                window_ids: fake_app.windows.iter().map(|window| window.id.clone()).collect(),
                focused_element: fake_app.focused,
                target: target.and_then(|id| Self::probe_node(world, *id)),
                parent_child_count: None,
                menu_open: false,
                window_hash: hasher.finish(),
            })
        })
    }

    fn perform(&self, element: &u64, action: ElementAction, _deadline: Deadline) -> CuResult<()> {
        self.with_world(|world| {
            let node = world.nodes.get_mut(element).ok_or_else(|| ErrorObject::new(ErrorCode::StaleElement, "gone"))?;
            if !node.actions.contains(&action) {
                return Err(unsupported("action_not_advertised", "not advertised"));
            }
            match action {
                ElementAction::Press => {
                    node.presses += 1;
                    if let Some(checked) = node.states.checked {
                        node.states.checked = Some(!checked);
                    }
                }
                ElementAction::Increment | ElementAction::Decrement => {
                    let current: f64 = node.value.as_deref().and_then(|value| value.parse().ok()).unwrap_or(0.0);
                    let next = if action == ElementAction::Increment { current + 1.0 } else { current - 1.0 };
                    node.value = Some(format!("{next}"));
                }
                _ => node.presses += 1,
            }
            Ok(())
        })
    }

    fn set_value(&self, element: &u64, value: &FillValue, _deadline: Deadline) -> CuResult<()> {
        self.with_world(|world| {
            let node = world.nodes.get_mut(element).ok_or_else(|| ErrorObject::new(ErrorCode::StaleElement, "gone"))?;
            if !node.value_settable {
                return Err(unsupported("value_not_settable", "read-only"));
            }
            node.value = Some(match value {
                FillValue::Text(text) => text.clone(),
                FillValue::Number(number) => format!("{number}"),
                FillValue::Bool(flag) => if *flag { "1".into() } else { "0".into() },
            });
            Ok(())
        })
    }

    fn set_selected_text(&self, element: &u64, text: &str, _deadline: Deadline) -> CuResult<()> {
        self.with_world(|world| {
            let node = world.nodes.get_mut(element).ok_or_else(|| ErrorObject::new(ErrorCode::StaleElement, "gone"))?;
            if !node.accepts_selected_text {
                return Err(unsupported("selected_text_unsupported", "no selected text"));
            }
            let mut value = node.value.clone().unwrap_or_default();
            match node.selected_range.take() {
                Some(range) => {
                    let units: Vec<u16> = value.encode_utf16().collect();
                    let end = (range.start + range.length).min(units.len());
                    let mut replaced = String::from_utf16_lossy(&units[..range.start.min(units.len())]);
                    replaced.push_str(text);
                    replaced.push_str(&String::from_utf16_lossy(&units[end..]));
                    value = replaced;
                }
                None => value.push_str(text),
            }
            node.value = Some(value);
            Ok(())
        })
    }

    fn set_selected_range(&self, element: &u64, range: TextRange, _deadline: Deadline) -> CuResult<()> {
        self.with_world(|world| {
            let node = world.nodes.get_mut(element).ok_or_else(|| ErrorObject::new(ErrorCode::StaleElement, "gone"))?;
            node.selected_range = Some(range);
            Ok(())
        })
    }

    fn set_selected(&self, element: &u64, selected: bool, _deadline: Deadline) -> CuResult<()> {
        self.with_world(|world| {
            let node = world.nodes.get_mut(element).ok_or_else(|| ErrorObject::new(ErrorCode::StaleElement, "gone"))?;
            if !matches!(node.role.as_str(), roles::ROW | roles::RADIO_BUTTON | "tab") {
                return Err(unsupported("not_selectable", "not selectable"));
            }
            node.states.selected = selected;
            Ok(())
        })
    }

    fn set_focused(&self, element: &u64, _deadline: Deadline) -> CuResult<()> {
        self.with_world(|world| {
            let window = world.nodes.get(element).map(|node| node.window.clone());
            let app = world.apps.iter_mut().find(|app| window.as_ref().is_some_and(|window| app.roots.contains_key(window)));
            if let Some(app) = app {
                app.focused = Some(*element);
            }
            Ok(())
        })
    }

    fn scroll_area(&self, element: &u64, _direction: ScrollDirection, _amount: ScrollAmount, _deadline: Deadline) -> CuResult<()> {
        self.with_world(|world| {
            if let Some(node) = world.nodes.get_mut(element) {
                node.presses += 1;
            }
        });
        Ok(())
    }

    fn main_scroll_area(&self, _app: &RunningApp, _window: &WindowInfo, _deadline: Deadline) -> Option<u64> {
        self.with_world(|world| world.nodes.iter().find(|(_, node)| node.role == roles::SCROLL_AREA).map(|(id, _)| *id))
    }

    fn press_menu_path(&self, app: &RunningApp, path: &[String], _deadline: Deadline) -> CuResult<()> {
        self.with_world(|world| {
            let index = Self::app_index(world, app).ok_or_else(|| not_found("app is not running"))?;
            let item = world.apps[index].menus.iter().find(|(candidate, _)| {
                candidate.len() == path.len() && candidate.iter().zip(path).all(|(a, b)| menu_title_matches(a, b))
            });
            match item {
                None => Err(unsupported("menu_item_not_found", "no such menu item")),
                Some((_, false)) => Err(unsupported("menu_item_disabled", "the menu item is disabled")),
                Some((_, true)) => {
                    world.pressed_menus.push(path.to_vec());
                    // Model a visible effect: the focused element's value changes.
                    if let Some(focused) = world.apps[index].focused
                        && let Some(node) = world.nodes.get_mut(&focused)
                    {
                        node.presses += 1;
                    }
                    Ok(())
                }
            }
        })
    }

    fn post_key(&self, app: &RunningApp, chord: &KeyChord) -> CuResult<()> {
        self.with_world(|world| {
            world.posted_keys.push(*chord);
            if let Some(id) = world.key_side_effect
                && let Some(node) = world.nodes.get_mut(&id)
            {
                node.presses += 1;
            }
            let Some(node) = Self::app_index(world, app)
                .and_then(|index| world.apps[index].focused)
                .and_then(|focused| world.nodes.get_mut(&focused))
            else {
                return;
            };
            let only_cmd = Modifiers { cmd: true, ..Modifiers::default() };
            match chord.key {
                Key::Char(character) if chord.modifiers.is_empty() => {
                    node.value.get_or_insert_with(String::new).push(character);
                }
                // Select all, as a text view does.
                Key::Char('a') if chord.modifiers == only_cmd && node.accepts_selected_text => {
                    let length = node.value.as_deref().map(crate::text::utf16_len).unwrap_or(0);
                    node.selected_range = Some(TextRange { start: 0, length });
                }
                _ => {}
            }
        });
        Ok(())
    }

    fn post_text(&self, app: &RunningApp, text: &str) -> CuResult<()> {
        self.with_world(|world| {
            world.posted_text.push(text.to_owned());
            if let Some(index) = Self::app_index(world, app)
                && let Some(focused) = world.apps[index].focused
                && let Some(node) = world.nodes.get_mut(&focused)
            {
                node.value.get_or_insert_with(String::new).push_str(text);
            }
        });
        Ok(())
    }

    fn capture_window(&self, _app: &RunningApp, _window: &WindowInfo, _deadline: Deadline) -> Result<Screenshot, ScreenshotOmitted> {
        Ok(Screenshot { mime_type: "image/png".into(), data: String::new(), width: 1, height: 1 })
    }

    fn is_locked(&self) -> bool {
        self.with_world(|world| world.locked)
    }

    fn set_monitor(&self, armed: bool, targets: Vec<MonitorTarget>) {
        self.with_world(|world| {
            world.monitor_armed = armed;
            world.monitor_targets = targets;
        });
    }

    fn enable_web_accessibility(&self, app: &RunningApp) -> CuResult<bool> {
        self.with_world(|world| world.web_accessibility_enabled.insert(app.bundle_id.clone(), true));
        Ok(true)
    }

    fn element_frame(&self, element: &u64, _deadline: Deadline) -> Option<Rect> {
        self.with_world(|world| world.nodes.get(element)?.bounds)
    }

    /// Records the call and models an effect: the smallest node under the point
    /// counts a press, so the fingerprint changes.
    fn pointer_click(
        &self,
        app: &RunningApp,
        window: &WindowInfo,
        x: f64,
        y: f64,
        button: MouseButton,
        count: u32,
        guard: StepGuard<'_>,
    ) -> CuResult<PointerRoute> {
        guard()?;
        let route = self.with_world(|world| {
            world.pointer_calls.push(PointerCall::Click { window: window.id.clone(), x, y, button, count });
            world.pointer_route
        });
        let route = route.ok_or_else(|| unsupported("pointer_unavailable", "no pointer"))?;
        if let Some(hit) = self.element_at(app, window.bounds.x + x, window.bounds.y + y, Deadline::from_ms(None)) {
            self.with_world(|world| world.nodes.get_mut(&hit).unwrap().presses += count);
        }
        Ok(route)
    }

    fn pointer_scroll(
        &self,
        _app: &RunningApp,
        window: &WindowInfo,
        x: f64,
        y: f64,
        direction: ScrollDirection,
        _amount: ScrollAmount,
        times: u32,
        guard: StepGuard<'_>,
    ) -> CuResult<PointerRoute> {
        guard()?;
        self.with_world(|world| {
            world.pointer_calls.push(PointerCall::Scroll { window: window.id.clone(), x, y, direction, times });
            world.pointer_route
        })
        .ok_or_else(|| unsupported("pointer_unavailable", "no pointer"))
    }

    fn restore_web_accessibility(&self, app: &RunningApp) {
        self.with_world(|world| {
            world.web_accessibility_enabled.remove(&app.bundle_id);
            world.web_accessibility_restored.push(app.bundle_id.clone());
        });
    }
}

fn is_ancestor(world: &FakeWorld, ancestor: u64, mut node: u64) -> bool {
    loop {
        if node == ancestor {
            return true;
        }
        match world.nodes.get(&node).and_then(|node| node.parent) {
            Some(parent) => node = parent,
            None => return false,
        }
    }
}

/// Shared handle used by tests that also need to emit events.
pub type SharedFake = Arc<FakePlatform>;
