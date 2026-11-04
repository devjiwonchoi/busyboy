//! Fingerprint comparison and settling after an action.

use std::time::{Duration, Instant};

use cu_protocol::Effect;

use super::Engine;
use crate::deadline::{CancelToken, Deadline};
use crate::platform::{Fingerprint, Platform, RunningApp};
use crate::tree::WindowInfo;

/// The tree counts as quiet after this long without a change.
const QUIET: Duration = Duration::from_millis(150);
const POLL: Duration = Duration::from_millis(50);
/// Longest settle wait.
const MAX_SETTLE: Duration = Duration::from_secs(3);

/// What changed between two fingerprints.
pub(crate) fn diff(before: &Fingerprint, after: &Fingerprint) -> Effect {
    let mut effect = Effect {
        new_window: after.window_ids.iter().any(|id| !before.window_ids.contains(id)),
        window_closed: before.window_ids.iter().any(|id| !after.window_ids.contains(id)),
        focus_changed: before.focused_element != after.focused_element,
        menu_opened: !before.menu_open && after.menu_open,
        tree_changed: before.window_hash != after.window_hash || before.parent_child_count != after.parent_child_count,
        ..Effect::default()
    };

    if let (Some(before), Some(after)) = (&before.target, &after.target) {
        effect.value_changed = before.value != after.value;
        effect.selection_changed =
            before.selected_range != after.selected_range || before.states.selected != after.states.selected;
        effect.tree_changed |= before.child_count != after.child_count
            || before.states.expanded != after.states.expanded
            || before.states.checked != after.states.checked
            || before.states.disabled != after.states.disabled;
    }
    effect
}

impl<P: Platform> Engine<P> {
    /// Waits until the fingerprint stops changing for 150 ms, capped at 3 s and the
    /// request deadline. Returns the last fingerprint.
    pub(crate) fn settle(
        &self,
        app: &RunningApp,
        window: Option<&WindowInfo>,
        target: Option<&P::Element>,
        deadline: Deadline,
        cancel: &CancelToken,
    ) -> Fingerprint {
        let started = Instant::now();
        // Bound every read by the settle cap, not only the loop.
        let deadline = deadline.capped(MAX_SETTLE);
        let mut last = self.platform.fingerprint(app, window, target, deadline);
        let mut quiet_since = Instant::now();
        while started.elapsed() < MAX_SETTLE && deadline.remaining() > POLL && !cancel.is_cancelled() {
            std::thread::sleep(POLL);
            let next = self.platform.fingerprint(app, window, target, deadline);
            if next != last {
                last = next;
                quiet_since = Instant::now();
            } else if quiet_since.elapsed() >= QUIET {
                break;
            }
        }
        last
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::ElementProbe;

    #[test]
    fn reports_each_kind_of_change() {
        let before = Fingerprint {
            window_ids: vec!["w1".into(), "w2".into()],
            focused_element: Some(1),
            target: Some(ElementProbe { value: Some("a".into()), ..ElementProbe::default() }),
            ..Fingerprint::default()
        };
        assert_eq!(diff(&before, &before), Effect::default());

        let mut after = before.clone();
        after.window_ids = vec!["w1".into(), "w3".into()];
        after.focused_element = Some(2);
        after.menu_open = true;
        after.target = Some(ElementProbe { value: Some("ab".into()), ..ElementProbe::default() });
        let effect = diff(&before, &after);
        assert!(effect.new_window && effect.window_closed && effect.focus_changed && effect.menu_opened && effect.value_changed);
        assert!(!effect.selection_changed);
    }
}
