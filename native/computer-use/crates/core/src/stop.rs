//! What one physical input means for the stop monitor (SPEC §5.6). The OS backend
//! copies a few fields out of each event and asks [`classify_input`]; keeping the
//! decision here lets it be tested without an event tap.

use crate::platform::{MonitorTarget, PlatformEvent};

/// Value stamped into the user-data field of every event we post, so the stop
/// monitor can tell our own input from the user's.
pub const EVENT_TAG: i64 = 0x4255_5359_424F_5901; // "BUSYBOY\x01"

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputKind {
    KeyDown,
    MouseDown,
}

/// The parts of one physical input the decision needs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PhysicalInput {
    pub kind: InputKind,
    /// A key-down of the Esc key.
    pub escape: bool,
    /// The process a key-down goes to, when known.
    pub key_target: Option<i32>,
    /// Screen points with a top-left origin, the same space as the target frames.
    pub location: (f64, f64),
    /// The event's user-data field; [`EVENT_TAG`] marks our own events.
    pub user_data: i64,
}

/// Esc stops every live turn, wherever it is pressed. A key into an operated app,
/// or a click inside one of its operated windows, stops the turns that use it.
/// Our own events never stop anything.
pub fn classify_input(input: &PhysicalInput, targets: &[MonitorTarget]) -> Option<PlatformEvent> {
    if input.user_data == EVENT_TAG {
        return None;
    }
    match input.kind {
        InputKind::KeyDown if input.escape => Some(PlatformEvent::Escape),
        InputKind::KeyDown => {
            let pid = input.key_target?;
            targets.iter().any(|target| target.pid == pid).then_some(PlatformEvent::UserInput { pid })
        }
        InputKind::MouseDown => targets
            .iter()
            .find(|target| target.frames.iter().any(|frame| frame.contains(input.location.0, input.location.1)))
            .map(|target| PlatformEvent::UserInput { pid: target.pid }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::Rect;

    fn targets() -> Vec<MonitorTarget> {
        vec![MonitorTarget { pid: 42, frames: vec![Rect { x: 100.0, y: 100.0, width: 400.0, height: 300.0 }] }]
    }

    fn key(escape: bool, key_target: Option<i32>, user_data: i64) -> PhysicalInput {
        PhysicalInput { kind: InputKind::KeyDown, escape, key_target, location: (0.0, 0.0), user_data }
    }

    fn click(x: f64, y: f64, user_data: i64) -> PhysicalInput {
        PhysicalInput { kind: InputKind::MouseDown, escape: false, key_target: None, location: (x, y), user_data }
    }

    #[test]
    fn escape_stops_anywhere_even_without_targets() {
        assert_eq!(classify_input(&key(true, Some(7), 0), &[]), Some(PlatformEvent::Escape));
        assert_eq!(classify_input(&key(true, None, 0), &targets()), Some(PlatformEvent::Escape));
    }

    #[test]
    fn our_own_events_are_ignored() {
        assert_eq!(classify_input(&key(true, None, EVENT_TAG), &targets()), None);
        assert_eq!(classify_input(&key(false, Some(42), EVENT_TAG), &targets()), None);
        assert_eq!(classify_input(&click(200.0, 200.0, EVENT_TAG), &targets()), None);
        // Events from other apps carry their own (or no) user data and still count.
        assert_eq!(classify_input(&key(true, None, 1), &targets()), Some(PlatformEvent::Escape));
    }

    #[test]
    fn key_down_into_a_target_app_is_user_input() {
        assert_eq!(classify_input(&key(false, Some(42), 0), &targets()), Some(PlatformEvent::UserInput { pid: 42 }));
        assert_eq!(classify_input(&key(false, Some(7), 0), &targets()), None);
        assert_eq!(classify_input(&key(false, None, 0), &targets()), None);
    }

    #[test]
    fn mouse_down_inside_a_target_frame_is_user_input() {
        assert_eq!(classify_input(&click(150.0, 120.0, 0), &targets()), Some(PlatformEvent::UserInput { pid: 42 }));
        assert_eq!(classify_input(&click(50.0, 50.0, 0), &targets()), None);
        assert_eq!(classify_input(&click(500.0, 400.0, 0), &targets()), None);
    }
}
