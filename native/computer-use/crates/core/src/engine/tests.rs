use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cu_protocol::{ErrorCode, MouseButton, Notification, RequestId, ScrollDirection, method};
use serde_json::{Value, json};

use super::Engine;
use crate::fake::{FakeApp, FakeNode, FakePlatform, PointerCall};
use crate::platform::{PlatformEvent, PointerRoute, ProcessRef};
use crate::tree::{ElementAction, NodeStates, roles};

struct Harness {
    engine: Arc<Engine<FakePlatform>>,
    platform: Arc<FakePlatform>,
    notifications: Arc<Mutex<Vec<Notification>>>,
    next_id: Mutex<u64>,
}

impl Harness {
    fn new() -> Self {
        let platform = Arc::new(FakePlatform::new());
        let notifications = Arc::new(Mutex::new(Vec::new()));
        let sink = notifications.clone();
        let engine = Engine::new(platform.clone(), "test", Arc::new(move |n| sink.lock().unwrap().push(n)));
        Harness { engine, platform, notifications, next_id: Mutex::new(1) }
    }

    fn call(&self, name: &str, params: Value) -> Result<Value, cu_protocol::ErrorObject> {
        let id = {
            let mut next = self.next_id.lock().unwrap();
            *next += 1;
            RequestId::Number(*next)
        };
        self.engine.handle(1, &id, name, params)
    }

    fn begin(&self, turn: &str) {
        self.call(method::SESSION_BEGIN, json!({"threadId": "t1", "turnId": turn})).unwrap();
    }

    fn state(&self, turn: &str, app: &str) -> Result<Value, cu_protocol::ErrorObject> {
        self.call(method::APP_STATE, json!({"threadId": "t1", "turnId": turn, "app": app}))
    }

    fn act(&self, turn: &str, action: Value) -> Result<Value, cu_protocol::ErrorObject> {
        self.call(method::APP_ACT, json!({"threadId": "t1", "turnId": turn, "app": "TextEdit", "action": action}))
    }

    /// Ref of the first tree line containing `needle`.
    fn find_ref(tree: &str, needle: &str) -> String {
        let line = tree.lines().find(|line| line.contains(needle)).unwrap_or_else(|| panic!("{needle} not in {tree}"));
        line.trim().split(' ').next().unwrap().to_owned()
    }
}

fn code(result: Result<Value, cu_protocol::ErrorObject>) -> ErrorCode {
    result.expect_err("expected an error").code
}

#[test]
fn hello_rejects_other_protocol_versions() {
    let harness = Harness::new();
    let ok = harness.engine.hello(json!({"protocolVersion": 1, "client": "busyboy-desktop"})).unwrap();
    assert_eq!(ok["protocolVersion"], 1);
    assert_eq!(ok["platform"], "fake");
    let error = harness.engine.hello(json!({"protocolVersion": 2, "client": "busyboy-desktop"})).unwrap_err();
    assert_eq!(error.code, ErrorCode::VersionMismatch);
}

#[test]
fn requires_an_active_turn_for_reads_and_actions() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    assert_eq!(code(harness.state("u1", "TextEdit")), ErrorCode::TurnInactive);

    harness.begin("u1");
    assert!(harness.state("u1", "TextEdit").is_ok());
    let other_thread = harness.call(method::APP_STATE, json!({"threadId": "t2", "turnId": "u1", "app": "TextEdit"}));
    assert_eq!(code(other_thread), ErrorCode::TurnInactive);

    harness.call(method::SESSION_END, json!({"threadId": "t1", "turnId": "u1"})).unwrap();
    assert_eq!(code(harness.state("u1", "TextEdit")), ErrorCode::TurnInactive);
}

#[test]
fn renders_state_with_refs_and_screenshot_reasons() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    harness.begin("u1");

    let state = harness.call(method::APP_STATE, json!({"threadId": "t1", "turnId": "u1", "app": "TextEdit", "includeScreenshot": true})).unwrap();
    let tree = state["tree"].as_str().unwrap();
    assert!(tree.starts_with("app: TextEdit (com.apple.TextEdit) pid 4121 · window \"Untitled\" [w1] · focused: e"), "{tree}");
    assert!(tree.contains("menus: Format, File"));
    assert!(tree.contains("button \"Bold\""));
    assert!(tree.contains("text area value=\"Hello\" focused editable"));
    assert_eq!(state["screenshot"], Value::Null);
    assert_eq!(state["screenshotOmitted"], "screen_recording_not_granted");
    assert_eq!(state["app"], json!({"name": "TextEdit", "bundleId": "com.apple.TextEdit", "pid": 4121}));

    harness.platform.with_world(|world| world.screen_recording = true);
    let with_image = harness.call(method::APP_STATE, json!({"threadId": "t1", "turnId": "u1", "app": "TextEdit", "includeScreenshot": true})).unwrap();
    assert_eq!(with_image["screenshot"]["mimeType"], "image/png");
    let without = harness.state("u1", "TextEdit").unwrap();
    assert_eq!(without["screenshotOmitted"], "not_requested");
}

#[test]
fn refuses_forbidden_apps_and_missing_accessibility() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    harness.platform.with_world(|world| {
        world.apps.push(FakeApp {
            name: "Terminal".into(),
            bundle_id: Some("com.apple.Terminal".into()),
            process: Some(ProcessRef { pid: 50, start_time: 1 }),
            windows: vec![],
            roots: Default::default(),
            focused: None,
            menus: vec![],
            needs_web_accessibility: false,
        })
    });
    harness.begin("u1");

    let error = harness.state("u1", "Terminal").unwrap_err();
    assert_eq!(error.code, ErrorCode::AppForbidden);
    assert_eq!(error.details.unwrap()["reason"], "terminal");

    let resolved = harness.call(method::APPS_RESOLVE, json!({"app": "Terminal"})).unwrap();
    assert_eq!(resolved["forbidden"], "terminal");
    let listed = harness.call(method::APPS_LIST, json!({})).unwrap();
    assert_eq!(listed["apps"][1]["forbidden"], "terminal");

    harness.platform.with_world(|world| world.accessibility = false);
    let error = harness.state("u1", "TextEdit").unwrap_err();
    assert_eq!(error.code, ErrorCode::PermissionRequired);
    assert_eq!(error.details.unwrap()["missing"], json!(["accessibility"]));
}

#[test]
fn clicks_a_ref_with_press_and_returns_verified_state() {
    let harness = Harness::new();
    let (bold, _) = harness.platform.with_text_editor();
    harness.begin("u1");
    let tree = harness.state("u1", "TextEdit").unwrap()["tree"].as_str().unwrap().to_owned();
    let bold_ref = Harness::find_ref(&tree, "Bold");

    let result = harness.act("u1", json!({"kind": "click", "ref": bold_ref})).unwrap();
    assert_eq!(result["method"], "ax_press");
    assert_eq!(result["verified"], true);
    assert!(result["state"]["tree"].as_str().unwrap().contains(&format!("{bold_ref} button \"Bold\"")), "refs stay stable");
    assert_eq!(harness.platform.with_world(|world| world.nodes[&bold].presses), 1);

    let no_state = harness.act("u1", json!({"kind": "click", "ref": bold_ref})).unwrap();
    assert!(no_state.get("state").is_some());
    let no_state = harness.call(
        method::APP_ACT,
        json!({"threadId": "t1", "turnId": "u1", "app": "TextEdit", "returnState": false, "action": {"kind": "click", "ref": bold_ref}}),
    )
    .unwrap();
    assert!(no_state.get("state").is_none());

    let both = harness.act("u1", json!({"kind": "click", "ref": bold_ref, "x": 1.0, "y": 1.0}));
    assert_eq!(code(both), ErrorCode::InvalidArgument);
}

#[test]
fn actions_attach_screenshots_when_granted_and_explain_when_not() {
    let harness = Harness::new();
    let (bold, _) = harness.platform.with_text_editor();
    harness.begin("u1");
    let tree = harness.state("u1", "TextEdit").unwrap()["tree"].as_str().unwrap().to_owned();
    let bold_ref = Harness::find_ref(&tree, "Bold");

    for granted in [true, false] {
        harness.platform.with_world(|world| world.screen_recording = granted);
        let result = harness.call(method::APP_ACT, json!({
            "threadId": "t1", "turnId": "u1", "app": "TextEdit",
            "includeScreenshot": true, "action": {"kind": "click", "ref": bold_ref}
        })).unwrap();
        assert_eq!(result["verified"], true);
        let state = &result["state"];
        if granted {
            assert_eq!(state["screenshot"]["mimeType"], "image/png");
            assert!(state.get("notes").is_none());
        } else {
            assert_eq!(state["screenshot"], Value::Null);
            assert_eq!(state["screenshotOmitted"], "screen_recording_not_granted");
            let notes = state["notes"].as_array().unwrap();
            assert_eq!(notes.len(), 1);
            assert!(notes[0].as_str().unwrap().contains("No screenshot: BusyBoy lacks Screen Recording permission"));
        }
    }
    assert_eq!(harness.platform.with_world(|world| world.nodes[&bold].presses), 2);
    let result = harness.act("u1", json!({"kind": "click", "ref": bold_ref})).unwrap();
    assert_eq!(result["state"]["screenshotOmitted"], "not_requested");
}

#[test]
fn clicks_window_points_through_hit_testing() {
    let harness = Harness::new();
    let (bold, _) = harness.platform.with_text_editor();
    harness.begin("u1");
    harness.state("u1", "TextEdit").unwrap();

    // The window starts at (100, 100); Bold sits at (110, 110).
    let result = harness.act("u1", json!({"kind": "click", "x": 15.0, "y": 15.0})).unwrap();
    assert_eq!(result["method"], "ax_press");
    assert_eq!(harness.platform.with_world(|world| world.nodes[&bold].presses), 1);

    let outside = harness.act("u1", json!({"kind": "click", "x": 5000.0, "y": 15.0}));
    assert_eq!(code(outside), ErrorCode::InvalidArgument);
}

#[test]
fn falls_back_to_a_pressable_ancestor_then_reports_unsupported() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    let root = harness.platform.with_world(|world| world.apps[0].roots["w1"]);
    let row = harness.platform.add_node(
        Some(root),
        "w1",
        FakeNode { role: "cell".into(), name: Some("Row".into()), actions: vec![ElementAction::Press], ..FakeNode::default() },
    );
    harness.platform.add_node(Some(row), "w1", FakeNode { role: "image".into(), name: Some("Icon".into()), ..FakeNode::default() });
    harness.platform.add_node(Some(root), "w1", FakeNode { role: "image".into(), name: Some("Lonely".into()), ..FakeNode::default() });
    harness.begin("u1");
    let tree = harness.state("u1", "TextEdit").unwrap()["tree"].as_str().unwrap().to_owned();

    let result = harness.act("u1", json!({"kind": "click", "ref": Harness::find_ref(&tree, "Icon")})).unwrap();
    assert_eq!(result["method"], "ax_press_ancestor");
    assert_eq!(harness.platform.with_world(|world| world.nodes[&row].presses), 1);

    let error = harness.act("u1", json!({"kind": "click", "ref": Harness::find_ref(&tree, "Lonely")})).unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionUnsupported);
    assert!(error.hint.unwrap().contains("computer_invoke_menu"));
}

#[test]
fn applies_ref_staleness_rules() {
    let harness = Harness::new();
    let (bold, _) = harness.platform.with_text_editor();
    harness.begin("u1");
    let tree = harness.state("u1", "TextEdit").unwrap()["tree"].as_str().unwrap().to_owned();
    let bold_ref = Harness::find_ref(&tree, "Bold");

    assert_eq!(code(harness.act("u1", json!({"kind": "click", "ref": "e999"}))), ErrorCode::ElementNotFound);

    // The element disappears: stale.
    harness.platform.with_world(|world| world.nodes.remove(&bold));
    let error = harness.act("u1", json!({"kind": "click", "ref": bold_ref})).unwrap_err();
    assert_eq!(error.code, ErrorCode::StaleElement);
    assert!(error.hint.unwrap().contains("call computer_snapshot again"));
}

#[test]
fn stale_after_the_app_restarts() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    harness.begin("u1");
    let tree = harness.state("u1", "TextEdit").unwrap()["tree"].as_str().unwrap().to_owned();
    let bold_ref = Harness::find_ref(&tree, "Bold");

    harness.platform.with_world(|world| world.apps[0].process = Some(ProcessRef { pid: 4121, start_time: 8 }));
    assert_eq!(code(harness.act("u1", json!({"kind": "click", "ref": bold_ref}))), ErrorCode::StaleElement);
}

#[test]
fn types_through_accessibility_then_falls_back_to_process_keys() {
    let harness = Harness::new();
    let (_, text) = harness.platform.with_text_editor();
    harness.begin("u1");
    harness.state("u1", "TextEdit").unwrap();

    let result = harness.act("u1", json!({"kind": "type", "text": " world"})).unwrap();
    assert_eq!(result["method"], "ax");
    assert_eq!(result["verified"], true);
    assert_eq!(harness.platform.with_world(|world| world.nodes[&text].value.clone()).unwrap(), "Hello world");

    let replaced = harness.act("u1", json!({"kind": "type", "text": "fresh", "replace": true})).unwrap();
    assert_eq!(replaced["method"], "ax");
    assert_eq!(harness.platform.with_world(|world| world.nodes[&text].value.clone()).unwrap(), "fresh");

    harness.platform.with_world(|world| {
        let node = world.nodes.get_mut(&text).unwrap();
        node.accepts_selected_text = false;
        node.value_settable = false;
    });
    let long_text = "x".repeat(45);
    let keys = harness.act("u1", json!({"kind": "type", "text": long_text})).unwrap();
    assert_eq!(keys["method"], "keys");
    assert_eq!(keys["verified"], true);
    let chunks = harness.platform.with_world(|world| world.posted_text.clone());
    assert_eq!(chunks.iter().map(|chunk| chunk.len()).collect::<Vec<_>>(), vec![20, 20, 5]);
}

#[test]
fn refuses_secure_fields_and_system_key_combos() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    let root = harness.platform.with_world(|world| world.apps[0].roots["w1"]);
    harness.platform.add_node(
        Some(root),
        "w1",
        FakeNode {
            role: roles::SECURE_TEXT_FIELD.into(),
            name: Some("Password".into()),
            value: Some("hunter2".into()),
            value_settable: true,
            states: NodeStates { secure: true, ..NodeStates::default() },
            ..FakeNode::default()
        },
    );
    harness.begin("u1");
    let tree = harness.state("u1", "TextEdit").unwrap()["tree"].as_str().unwrap().to_owned();
    assert!(!tree.contains("hunter2"), "secure values never appear");
    let password = Harness::find_ref(&tree, "Password");

    assert_eq!(code(harness.act("u1", json!({"kind": "type", "ref": password, "text": "x"}))), ErrorCode::SecureField);
    assert_eq!(code(harness.act("u1", json!({"kind": "fill", "ref": password, "value": "x"}))), ErrorCode::SecureField);
    assert_eq!(code(harness.act("u1", json!({"kind": "key", "keys": "cmd+q"}))), ErrorCode::KeyRefused);
    assert!(harness.platform.with_world(|world| world.posted_keys.is_empty()));
}

#[test]
fn posts_keys_to_the_process_and_needs_a_focused_element() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    harness.begin("u1");
    harness.state("u1", "TextEdit").unwrap();

    let result = harness.act("u1", json!({"kind": "key", "keys": "cmd+a"})).unwrap();
    assert_eq!(result["method"], "keys");
    assert_eq!(harness.platform.with_world(|world| world.posted_keys.len()), 1);

    harness.platform.with_world(|world| world.apps[0].focused = None);
    let error = harness.act("u1", json!({"kind": "key", "keys": "down"})).unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionUnsupported);
    assert!(error.hint.unwrap().contains("computer_invoke_menu"));
}

/// TextEdit with focus on the Bold button, so the text area is in the background.
fn editor_focused_elsewhere(harness: &Harness) -> (String, u64) {
    let (bold, text) = harness.platform.with_text_editor();
    harness.platform.with_world(|world| world.apps[0].focused = Some(bold));
    harness.begin("u1");
    let tree = harness.state("u1", "TextEdit").unwrap()["tree"].as_str().unwrap().to_owned();
    (Harness::find_ref(&tree, "text area"), text)
}

#[test]
fn select_all_on_a_text_ref_is_verified_by_the_selection() {
    let harness = Harness::new();
    let (area, text) = editor_focused_elsewhere(&harness);

    let result = harness.act("u1", json!({"kind": "key", "keys": "cmd+a", "ref": area})).unwrap();
    assert_eq!(result["verified"], true);
    assert_eq!(result["effect"]["selectionChanged"], true);
    // Focusing the target before the keys is our own step, not an effect.
    assert!(result["effect"].get("focusChanged").is_none_or(|changed| changed == false));
    let range = harness.platform.with_world(|world| world.nodes[&text].selected_range);
    assert_eq!(range, Some(cu_protocol::TextRange { start: 0, length: 5 }));
}

#[test]
fn ignored_select_all_is_not_verified_by_focus_or_redraws() {
    let harness = Harness::new();
    let (area, text) = editor_focused_elsewhere(&harness);
    // The app ignores the key (no select-all) but redraws something on each key.
    let bold = harness.platform.with_world(|world| {
        world.nodes.get_mut(&text).unwrap().accepts_selected_text = false;
        world.apps[0].focused
    });
    harness.platform.with_world(|world| world.key_side_effect = bold);

    let result = harness.act("u1", json!({"kind": "key", "keys": "cmd+a", "ref": area})).unwrap();
    assert_eq!(result["effect"]["treeChanged"], true);
    assert_eq!(result["verified"], false);
}

#[test]
fn an_app_that_stops_answering_after_a_key_reports_no_closed_window() {
    let harness = Harness::new();
    let (area, text) = editor_focused_elsewhere(&harness);
    harness.platform.with_world(|world| world.nodes.get_mut(&text).unwrap().accepts_selected_text = false);
    // The "before" reading works; every reading after the key times out.
    harness.platform.with_world(|world| world.fingerprint_reads_left = Some(1));

    let result = harness.act("u1", json!({"kind": "key", "keys": "cmd+a", "ref": area})).unwrap();
    assert_eq!(result["verified"], false);
    assert_eq!(result["effect"], json!({}));
    assert!(result["notes"].as_array().unwrap().iter().any(|note| note.as_str().unwrap().contains("did not answer")));
    assert_eq!(result["state"]["window"], "w1", "the window is still there");
}

#[test]
fn keys_that_are_not_text_edits_still_count_any_change() {
    let harness = Harness::new();
    let (area, _text) = editor_focused_elsewhere(&harness);
    let bold = harness.platform.with_world(|world| world.apps[0].focused);
    harness.platform.with_world(|world| world.key_side_effect = bold);

    // cmd+b has no fixed text meaning; a visible change counts.
    let result = harness.act("u1", json!({"kind": "key", "keys": "cmd+b", "ref": area})).unwrap();
    assert_eq!(result["verified"], true);
}

#[test]
fn reads_windows_of_a_slow_background_app_by_waiting_longer() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    harness.begin("u1");
    // The first answer takes longer than the usual 250 ms per call.
    harness.platform.with_world(|world| world.window_read_needs = Duration::from_millis(800));

    let state = harness.state("u1", "TextEdit").unwrap();
    assert_eq!(state["window"], "w1");
    assert_eq!(harness.platform.with_world(|world| world.window_reads), 2);
}

#[test]
fn retries_a_brief_window_read_stall() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    harness.begin("u1");
    harness.platform.with_world(|world| world.window_read_timeouts = 2);
    assert_eq!(harness.state("u1", "TextEdit").unwrap()["window"], "w1");
    harness.platform.with_world(|world| world.window_read_timeouts = 1);
    assert_eq!(harness.act("u1", json!({"kind": "key", "keys": "a"})).unwrap()["verified"], true);
}

#[test]
fn an_app_that_never_answers_is_a_timeout_not_a_missing_window() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    harness.begin("u1");
    harness.platform.with_world(|world| world.window_read_timeouts = usize::MAX);
    let error = harness.state("u1", "TextEdit").unwrap_err();
    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(error.retryable);
    assert_eq!(harness.platform.with_world(|world| world.window_reads), 3);
}

#[test]
fn invokes_menus_and_reports_disabled_items() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    harness.begin("u1");

    let result = harness.act("u1", json!({"kind": "menu", "path": ["format", "Font", "Bold"]})).unwrap();
    assert_eq!(result["method"], "ax_menu");
    assert_eq!(result["verified"], true);

    let error = harness.act("u1", json!({"kind": "menu", "path": ["File", "Print..."]})).unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionUnsupported);
    assert_eq!(error.details.unwrap()["reason"], "menu_item_disabled");
}

#[test]
fn fills_values_and_steps_sliders() {
    let harness = Harness::new();
    let (_, text) = harness.platform.with_text_editor();
    let root = harness.platform.with_world(|world| world.apps[0].roots["w1"]);
    let slider = harness.platform.add_node(
        Some(root),
        "w1",
        FakeNode {
            role: roles::SLIDER.into(),
            name: Some("Size".into()),
            value: Some("2".into()),
            actions: vec![ElementAction::Increment, ElementAction::Decrement],
            ..FakeNode::default()
        },
    );
    harness.begin("u1");
    let tree = harness.state("u1", "TextEdit").unwrap()["tree"].as_str().unwrap().to_owned();

    let filled = harness.act("u1", json!({"kind": "fill", "ref": Harness::find_ref(&tree, "text area"), "value": "Replaced"})).unwrap();
    assert_eq!(filled["method"], "ax_value");
    assert_eq!(harness.platform.with_world(|world| world.nodes[&text].value.clone()).unwrap(), "Replaced");

    let stepped = harness.act("u1", json!({"kind": "fill", "ref": Harness::find_ref(&tree, "Size"), "value": 5})).unwrap();
    assert_eq!(stepped["method"], "ax_steps");
    assert_eq!(stepped["verified"], true);
    assert_eq!(harness.platform.with_world(|world| world.nodes[&slider].value.clone()).unwrap(), "5");
}

/// Runs one physical input through the stop classifier, as the OS monitor does.
fn press(harness: &Harness, input: crate::stop::PhysicalInput) {
    let targets = harness.platform.with_world(|world| world.monitor_targets.clone());
    if let Some(event) = crate::stop::classify_input(&input, &targets) {
        harness.platform.emit(event);
    }
}

fn escape_key(user_data: i64) -> crate::stop::PhysicalInput {
    crate::stop::PhysicalInput {
        kind: crate::stop::InputKind::KeyDown,
        escape: true,
        key_target: None,
        location: (0.0, 0.0),
        click_owner: None,
        click_on_busyboy: false,
        user_data,
    }
}

#[test]
fn escape_during_a_session_sends_one_stopped_notification() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    // The session is open but has not touched an app yet (an approval card is showing).
    harness.begin("u1");
    assert!(harness.platform.with_world(|world| world.monitor_armed));

    // Our own Esc (tagged) stops nothing.
    press(&harness, escape_key(crate::stop::EVENT_TAG));
    assert!(harness.notifications.lock().unwrap().is_empty());

    // The user presses Esc twice; the turn stops once.
    press(&harness, escape_key(0));
    press(&harness, escape_key(0));
    let stopped: Vec<_> =
        harness.notifications.lock().unwrap().iter().filter(|n| n.method == "stopped").cloned().collect();
    assert_eq!(stopped.len(), 1);
    assert_eq!(stopped[0].params, json!({"threadId": "t1", "turnId": "u1", "reason": "user_escape"}));
    assert!(!harness.platform.with_world(|world| world.monitor_armed));
}

#[test]
fn escape_stops_the_turn_and_cancels_in_flight_work() {
    let harness = Arc::new(Harness::new());
    harness.platform.with_text_editor();
    harness.begin("u1");
    assert!(harness.platform.with_world(|world| world.monitor_armed));
    harness.platform.with_world(|world| world.snapshot_delay_ms = 3_000);

    let worker = {
        let harness = harness.clone();
        std::thread::spawn(move || harness.state("u1", "TextEdit"))
    };
    std::thread::sleep(Duration::from_millis(100));
    let pressed = Instant::now();
    harness.platform.emit(PlatformEvent::Escape);
    let error = worker.join().unwrap().unwrap_err();
    assert!(pressed.elapsed() < Duration::from_secs(1), "stop took {:?}", pressed.elapsed());
    assert_eq!(error.code, ErrorCode::Stopped);
    assert_eq!(error.details.unwrap()["reason"], "user_escape");

    let notifications = harness.notifications.lock().unwrap().clone();
    assert_eq!(notifications[0].method, "stopped");
    assert_eq!(notifications[0].params, json!({"threadId": "t1", "turnId": "u1", "reason": "user_escape"}));

    harness.platform.with_world(|world| world.snapshot_delay_ms = 0);
    let again = harness.state("u1", "TextEdit").unwrap_err();
    assert_eq!(again.code, ErrorCode::Stopped);
    assert!(!harness.platform.with_world(|world| world.monitor_armed), "stopped turns disarm the monitor");

    // The next turn works again.
    harness.begin("u2");
    harness.platform.with_world(|world| world.snapshot_delay_ms = 0);
    assert!(harness.state("u2", "TextEdit").is_ok());
}

#[test]
fn user_input_stops_only_turns_operating_that_app() {
    let harness = Harness::new();
    let (bold, _) = harness.platform.with_text_editor();
    let _ = bold;
    harness.begin("u1");
    harness.begin("u2");
    harness.call(method::APP_ACT, json!({"threadId": "t1", "turnId": "u1", "app": "TextEdit", "returnState": false, "action": {"kind": "key", "keys": "a"}})).unwrap();
    let targets = harness.platform.with_world(|world| world.monitor_targets.clone());
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].pid, 4121);

    harness.platform.emit(PlatformEvent::UserInput { pid: 999 });
    assert!(harness.notifications.lock().unwrap().is_empty());

    harness.platform.emit(PlatformEvent::UserInput { pid: 4121 });
    let notifications = harness.notifications.lock().unwrap().clone();
    assert_eq!(notifications.len(), 1);
    assert_eq!(notifications[0].params["turnId"], "u1");
    assert_eq!(notifications[0].params["reason"], "user_input");
    assert!(harness.state("u2", "TextEdit").is_ok());
}

#[test]
fn refuses_while_locked_and_reports_lock_changes() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    harness.begin("u1");

    harness.platform.with_world(|world| world.locked = true);
    let error = harness.state("u1", "TextEdit").unwrap_err();
    assert_eq!(error.code, ErrorCode::ScreenLocked);
    assert!(error.retryable);
    assert!(error.hint.unwrap().contains("do not ask for the password"));

    harness.platform.emit(PlatformEvent::LockChanged { locked: true });
    let notifications = harness.notifications.lock().unwrap().clone();
    assert_eq!(notifications[0].method, "lock_changed");
    assert_eq!(notifications[1].params["reason"], "screen_locked");

    // Lock does not stop the turn for good.
    harness.platform.with_world(|world| world.locked = false);
    harness.platform.emit(PlatformEvent::LockChanged { locked: false });
    assert!(harness.state("u1", "TextEdit").is_ok());
}

#[test]
fn client_cancel_stops_in_flight_requests() {
    let harness = Arc::new(Harness::new());
    harness.platform.with_text_editor();
    harness.begin("u1");
    harness.platform.with_world(|world| world.snapshot_delay_ms = 3_000);

    let worker = {
        let harness = harness.clone();
        std::thread::spawn(move || harness.state("u1", "TextEdit"))
    };
    std::thread::sleep(Duration::from_millis(100));
    let cancelled = harness.call(method::CANCEL, json!({})).unwrap();
    assert_eq!(cancelled["cancelled"], 1);
    let error = worker.join().unwrap().unwrap_err();
    assert_eq!(error.code, ErrorCode::Stopped);
    assert_eq!(error.details.unwrap()["reason"], "client_stop");
}

#[test]
fn enables_web_accessibility_and_restores_it_when_the_turn_ends() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    harness.platform.with_world(|world| world.apps[0].needs_web_accessibility = true);
    harness.begin("u1");

    let state = harness.state("u1", "TextEdit").unwrap();
    assert!(state.get("notes").is_none(), "content appeared after enablement: {state}");
    assert_eq!(harness.platform.with_world(|world| world.web_accessibility_enabled.get("com.apple.TextEdit").copied()), Some(true));

    harness.call(method::SESSION_END, json!({"threadId": "t1", "turnId": "u1"})).unwrap();
    assert_eq!(harness.platform.with_world(|world| world.web_accessibility_restored.clone()), vec!["com.apple.TextEdit"]);
}

#[test]
fn launches_apps_that_are_not_running() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    harness.platform.with_world(|world| world.apps[0].process = None);
    harness.begin("u1");

    // The fake relaunch gets a new pid, so the window roots stay keyed by window id.
    let state = harness.state("u1", "TextEdit").unwrap();
    assert_eq!(state["launched"], true);
    assert_eq!(harness.platform.with_world(|world| world.launched.clone()), vec!["com.apple.TextEdit"]);
}

#[test]
fn refless_actions_check_the_focused_window_even_when_private() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    harness.platform.with_world(|world| {
        let app = &mut world.apps[0];
        app.windows[0].focused = false;
        let mut private = app.windows[0].clone();
        private.id = "w2".into();
        private.focused = true;
        private.private = true;
        app.windows.push(private);
    });
    harness.begin("u1");
    // Reads skip the private window...
    assert!(harness.state("u1", "TextEdit").is_ok());
    // ...but typing, keys, and menus would land in it, so they are refused.
    for action in [
        json!({"kind": "type", "text": "x"}),
        json!({"kind": "key", "keys": "cmd+a"}),
        json!({"kind": "menu", "path": ["Format", "Font", "Bold"]}),
    ] {
        let error = harness.act("u1", action).unwrap_err();
        assert_eq!(error.code, ErrorCode::AppForbidden);
        assert_eq!(error.details.unwrap()["reason"], "private_window");
    }
}

#[test]
fn refuses_actions_in_localized_security_panes_but_allows_reads() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    harness.platform.with_world(|world| {
        let app = &mut world.apps[0];
        app.name = "System Settings".into();
        app.bundle_id = Some("com.apple.systempreferences".into());
        app.windows[0].title = "공유".into();
    });
    harness.begin("u1");
    let settings = |action: Value| {
        harness.call(
            method::APP_ACT,
            json!({"threadId": "t1", "turnId": "u1", "app": "System Settings", "action": action}),
        )
    };

    assert!(harness.state("u1", "System Settings").is_ok());
    let error = settings(json!({"kind": "key", "keys": "cmd+a"})).unwrap_err();
    assert_eq!(error.code, ErrorCode::AppForbidden);
    assert_eq!(error.details.unwrap()["reason"], "system_security");

    // Another pane in the same language is fine.
    harness.platform.with_world(|world| world.apps[0].windows[0].title = "디스플레이".into());
    assert!(settings(json!({"kind": "key", "keys": "cmd+a"})).is_ok());
}

#[test]
fn press_refuses_characters_into_secure_fields() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    let root = harness.platform.with_world(|world| world.apps[0].roots["w1"]);
    let password = harness.platform.add_node(
        Some(root),
        "w1",
        FakeNode { role: roles::SECURE_TEXT_FIELD.into(), states: NodeStates { secure: true, ..NodeStates::default() }, ..FakeNode::default() },
    );
    harness.platform.with_world(|world| world.apps[0].focused = Some(password));
    harness.begin("u1");
    harness.state("u1", "TextEdit").unwrap();

    assert_eq!(code(harness.act("u1", json!({"kind": "key", "keys": "h i"}))), ErrorCode::SecureField);
    assert_eq!(code(harness.act("u1", json!({"kind": "key", "keys": "cmd+v"}))), ErrorCode::SecureField);
    assert!(harness.platform.with_world(|world| world.posted_keys.is_empty()));
    assert!(harness.act("u1", json!({"kind": "key", "keys": "tab"})).is_ok());
}

#[test]
fn refuses_quit_and_apple_menu_items() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    harness.begin("u1");
    for path in [json!(["TextEdit", "Quit TextEdit"]), json!(["Apple", "Lock Screen"])] {
        let error = harness.act("u1", json!({"kind": "menu", "path": path})).unwrap_err();
        assert_eq!(error.code, ErrorCode::ActionUnsupported);
        assert_eq!(error.details.unwrap()["reason"], "refused_menu");
    }
    assert!(harness.platform.with_world(|world| world.pressed_menus.is_empty()));
}

#[test]
fn unchanged_checkboxes_are_not_verified() {
    let harness = Harness::new();
    harness.platform.with_text_editor();
    let root = harness.platform.with_world(|world| world.apps[0].roots["w1"]);
    harness.platform.add_node(
        Some(root),
        "w1",
        FakeNode {
            role: roles::CHECK_BOX.into(),
            name: Some("Wrap".into()),
            actions: vec![ElementAction::Press],
            states: NodeStates { checked: Some(true), ..NodeStates::default() },
            ..FakeNode::default()
        },
    );
    harness.begin("u1");
    let tree = harness.state("u1", "TextEdit").unwrap()["tree"].as_str().unwrap().to_owned();
    let result = harness.act("u1", json!({"kind": "fill", "ref": Harness::find_ref(&tree, "Wrap"), "value": true})).unwrap();
    assert_eq!(result["verified"], false);
    assert_eq!(result["method"], "ax_unchanged");
}

#[test]
fn cancel_only_reaches_the_calling_clients_requests() {
    let harness = Arc::new(Harness::new());
    harness.platform.with_text_editor();
    harness.begin("u1");
    harness.platform.with_world(|world| world.snapshot_delay_ms = 3_000);

    let worker = {
        let harness = harness.clone();
        std::thread::spawn(move || {
            harness.engine.handle(
                7,
                &RequestId::Number(5),
                method::APP_STATE,
                json!({"threadId": "t1", "turnId": "u1", "app": "TextEdit"}),
            )
        })
    };
    std::thread::sleep(Duration::from_millis(100));
    let other = harness.engine.handle(8, &RequestId::Number(9), method::CANCEL, json!({"requestId": 5})).unwrap();
    assert_eq!(other["cancelled"], 0);
    let own = harness.engine.handle(7, &RequestId::Number(6), method::CANCEL, json!({"requestId": 5})).unwrap();
    assert_eq!(own["cancelled"], 1);
    assert_eq!(worker.join().unwrap().unwrap_err().code, ErrorCode::Stopped);
}

// -- experimental pointer ------------------------------------------------------

fn pointer_act(harness: &Harness, action: Value) -> Result<Value, cu_protocol::ErrorObject> {
    harness.call(
        method::APP_ACT,
        json!({"threadId": "t1", "turnId": "u1", "app": "TextEdit", "experimentalPointer": true, "action": action}),
    )
}

/// TextEdit plus a custom-drawn canvas with no accessibility actions at window-local
/// (100, 60)–(300, 160). Returns the canvas tree ref and the node id.
fn editor_with_canvas(harness: &Harness) -> (String, u64) {
    harness.platform.with_text_editor();
    let root = harness.platform.with_world(|world| world.apps[0].roots["w1"]);
    let canvas = harness.platform.add_node(
        Some(root),
        "w1",
        FakeNode {
            role: "group".into(),
            name: Some("Canvas".into()),
            bounds: Some(crate::tree::Rect { x: 200.0, y: 160.0, width: 200.0, height: 100.0 }),
            ..FakeNode::default()
        },
    );
    harness.begin("u1");
    let tree = harness.state("u1", "TextEdit").unwrap()["tree"].as_str().unwrap().to_owned();
    (Harness::find_ref(&tree, "Canvas"), canvas)
}

fn pointer_calls(harness: &Harness) -> Vec<PointerCall> {
    harness.platform.with_world(|world| world.pointer_calls.clone())
}

#[test]
fn pointer_off_never_posts_pointer_events() {
    let harness = Harness::new();
    let (canvas_ref, _) = editor_with_canvas(&harness);
    let tree = harness.state("u1", "TextEdit").unwrap()["tree"].as_str().unwrap().to_owned();
    assert!(!tree.contains('@'), "no bounds while the pointer is off: {tree}");
    let bold_ref = Harness::find_ref(&tree, "Bold");

    for action in [
        json!({"kind": "click", "ref": canvas_ref}),
        json!({"kind": "click", "x": 150.0, "y": 100.0}),
        json!({"kind": "click", "ref": bold_ref, "button": "right"}),
        json!({"kind": "click", "ref": bold_ref, "count": 2}),
        json!({"kind": "scroll", "direction": "down"}),
    ] {
        assert_eq!(code(harness.act("u1", action.clone())), ErrorCode::ActionUnsupported, "{action}");
    }
    assert!(pointer_calls(&harness).is_empty());
}

#[test]
fn pointer_on_shows_window_local_bounds() {
    let harness = Harness::new();
    editor_with_canvas(&harness);
    let state = harness
        .call(method::APP_STATE, json!({"threadId": "t1", "turnId": "u1", "app": "TextEdit", "experimentalPointer": true}))
        .unwrap();
    let tree = state["tree"].as_str().unwrap();
    assert!(tree.contains("button \"Bold\" @10,10,30,20"), "{tree}");
    assert!(tree.contains("group \"Canvas\" @100,60,200,100"), "{tree}");

    // Action results carry the same bounds in their returned state.
    let result = pointer_act(&harness, json!({"kind": "click", "ref": Harness::find_ref(tree, "Bold")})).unwrap();
    assert!(result["state"]["tree"].as_str().unwrap().contains("@10,10,30,20"));
}

#[test]
fn pointer_on_runs_after_accessibility_steps_fail() {
    let harness = Harness::new();
    let (canvas_ref, canvas) = editor_with_canvas(&harness);
    let tree = harness.state("u1", "TextEdit").unwrap()["tree"].as_str().unwrap().to_owned();
    let bold_ref = Harness::find_ref(&tree, "Bold");

    // A pressable element still uses AXPress.
    let pressed = pointer_act(&harness, json!({"kind": "click", "ref": bold_ref})).unwrap();
    assert_eq!(pressed["method"], "ax_press");
    assert!(pointer_calls(&harness).is_empty());

    // No AX action: background click at the element centre, window-local.
    let clicked = pointer_act(&harness, json!({"kind": "click", "ref": canvas_ref})).unwrap();
    assert_eq!(clicked["method"], "pointer");
    assert_eq!(clicked["verified"], true, "the fake reacts, so the fingerprint changed");
    assert_eq!(harness.platform.with_world(|world| world.nodes[&canvas].presses), 1);

    // Coordinates with nothing pressable: the point itself.
    pointer_act(&harness, json!({"kind": "click", "x": 120.0, "y": 70.0})).unwrap();
    // Right and double clicks without menu/open actions.
    pointer_act(&harness, json!({"kind": "click", "ref": bold_ref, "button": "right"})).unwrap();
    pointer_act(&harness, json!({"kind": "click", "ref": bold_ref, "count": 2})).unwrap();
    // Scroll with no scroll area: wheel at the window centre.
    let scrolled = pointer_act(&harness, json!({"kind": "scroll", "direction": "down", "times": 3})).unwrap();
    assert_eq!(scrolled["method"], "pointer");

    let click = |x: f64, y: f64, button: MouseButton, count: u32| PointerCall::Click { window: "w1".into(), x, y, button, count };
    assert_eq!(
        pointer_calls(&harness),
        vec![
            click(200.0, 110.0, MouseButton::Left, 1),
            click(120.0, 70.0, MouseButton::Left, 1),
            click(25.0, 20.0, MouseButton::Right, 1),
            click(25.0, 20.0, MouseButton::Left, 2),
            PointerCall::Scroll { window: "w1".into(), x: 300.0, y: 200.0, direction: ScrollDirection::Down, times: 3 },
        ]
    );
}

#[test]
fn pointer_results_are_verified_only_by_an_observed_change() {
    let harness = Harness::new();
    editor_with_canvas(&harness);
    harness.platform.with_world(|world| world.pointer_route = Some(PointerRoute::Public));

    // Nothing under (590, 30), so nothing changes: posted but not verified, not an error.
    let result = pointer_act(&harness, json!({"kind": "click", "x": 590.0, "y": 30.0})).unwrap();
    assert_eq!(result["method"], "pointer_public");
    assert_eq!(result["verified"], false);

    // A backend without a pointer reports action_unsupported.
    harness.platform.with_world(|world| world.pointer_route = None);
    let error = pointer_act(&harness, json!({"kind": "click", "x": 590.0, "y": 30.0})).unwrap_err();
    assert_eq!(error.code, ErrorCode::ActionUnsupported);
    assert_eq!(error.details.unwrap()["reason"], "pointer_unavailable");
}

#[test]
fn pointer_stops_when_the_turn_is_locked_out() {
    let harness = Harness::new();
    let (canvas_ref, _) = editor_with_canvas(&harness);
    harness.platform.with_world(|world| world.locked = true);
    assert_eq!(code(pointer_act(&harness, json!({"kind": "click", "ref": canvas_ref}))), ErrorCode::ScreenLocked);
    assert!(pointer_calls(&harness).is_empty());
}
