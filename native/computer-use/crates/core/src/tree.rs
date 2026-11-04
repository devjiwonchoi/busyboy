//! Platform-neutral element tree produced by a backend walk.

use cu_protocol::Truncation;

/// A rectangle in points. Screen coordinates unless documented otherwise.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }

    pub fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }
}

/// Element actions the core knows how to order. Backends map them to native names
/// (for example `AXPress`) and report which ones an element advertises.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ElementAction {
    Press,
    ShowMenu,
    Confirm,
    Open,
    Pick,
    Cancel,
    Increment,
    Decrement,
    ScrollToVisible,
}

impl ElementAction {
    pub fn as_str(self) -> &'static str {
        match self {
            ElementAction::Press => "press",
            ElementAction::ShowMenu => "show_menu",
            ElementAction::Confirm => "confirm",
            ElementAction::Open => "open",
            ElementAction::Pick => "pick",
            ElementAction::Cancel => "cancel",
            ElementAction::Increment => "increment",
            ElementAction::Decrement => "decrement",
            ElementAction::ScrollToVisible => "scroll_to_visible",
        }
    }
}

/// State flags rendered as words after a node.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct NodeStates {
    pub focused: bool,
    pub selected: bool,
    pub disabled: bool,
    /// `Some(true)` expanded, `Some(false)` collapsed, `None` not expandable.
    pub expanded: Option<bool>,
    /// The value can be written.
    pub editable: bool,
    /// A secure (password) text field. Its value is never read or returned.
    pub secure: bool,
    /// `Some` for checkable controls.
    pub checked: Option<bool>,
}

/// Role words the core treats specially. Backends must emit these exact strings.
pub mod roles {
    pub const WINDOW: &str = "window";
    pub const SCROLL_AREA: &str = "scroll area";
    pub const SCROLL_BAR: &str = "scroll bar";
    pub const TEXT_FIELD: &str = "text field";
    pub const TEXT_AREA: &str = "text area";
    pub const SECURE_TEXT_FIELD: &str = "secure text field";
    pub const COMBO_BOX: &str = "combo box";
    pub const POPUP_BUTTON: &str = "popup button";
    pub const MENU_BUTTON: &str = "menu button";
    pub const MENU: &str = "menu";
    pub const MENU_ITEM: &str = "menu item";
    pub const ROW: &str = "row";
    pub const CELL: &str = "cell";
    pub const OUTLINE_ROW: &str = "outline row";
    pub const LIST: &str = "list";
    pub const TABLE: &str = "table";
    pub const OUTLINE: &str = "outline";
    pub const TAB_GROUP: &str = "tab group";
    pub const RADIO_BUTTON: &str = "radio button";
    pub const CHECK_BOX: &str = "checkbox";
    pub const SWITCH: &str = "switch";
    pub const SLIDER: &str = "slider";
    pub const STEPPER: &str = "stepper";
    pub const WEB_AREA: &str = "web area";
    pub const STATIC_TEXT: &str = "text";
    pub const GROUP: &str = "group";
}

/// One node of a walked tree.
#[derive(Debug, Clone)]
pub struct RawNode<E> {
    /// Native handle, retained for the ref table.
    pub handle: E,
    /// Lowercase role words, e.g. `"popup button"`.
    pub role: String,
    pub name: Option<String>,
    /// Value text, already cut to the text budget. `None` for secure fields.
    pub value: Option<String>,
    /// Full value length in characters before cutting.
    pub value_len: usize,
    pub description: Option<String>,
    pub states: NodeStates,
    /// Screen bounds in points.
    pub bounds: Option<Rect>,
    pub actions: Vec<ElementAction>,
    /// Indexes into [`RawTree::nodes`].
    pub children: Vec<usize>,
}

impl<E> RawNode<E> {
    pub fn has(&self, action: ElementAction) -> bool {
        self.actions.contains(&action)
    }
}

/// A window of the target app.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowInfo {
    /// Stable id for the life of the window, e.g. `w1234`.
    pub id: String,
    pub title: String,
    /// Screen bounds in points.
    pub bounds: Rect,
    pub minimized: bool,
    pub main: bool,
    pub focused: bool,
    /// Private or incognito browser window (heuristic).
    pub private: bool,
}

/// Result of one tree walk.
#[derive(Debug, Clone)]
pub struct RawTree<E> {
    /// Node 0 is the root (the window).
    pub nodes: Vec<RawNode<E>>,
    pub truncated: Option<Truncation>,
    /// Top-level menu bar titles.
    pub menus: Vec<String>,
    /// The tree contains web content that has not been exposed yet, so the core
    /// should ask the backend to enable web-content accessibility and walk again.
    pub needs_web_accessibility: bool,
}

/// Limits for one walk. Defaults and hard maxima come from the spec.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TreeBudget {
    pub max_depth: usize,
    pub max_nodes: usize,
    pub max_children: usize,
    /// Characters kept per text field.
    pub max_text: usize,
    /// Characters of rendered outline.
    pub max_output: usize,
}

impl TreeBudget {
    pub const DEFAULT_DEPTH: usize = 30;
    pub const MAX_DEPTH: usize = 60;
    pub const DEFAULT_NODES: usize = 1_500;
    pub const MAX_NODES: usize = 5_000;
    pub const DEFAULT_CHILDREN: usize = 200;
    pub const MAX_CHILDREN: usize = 1_000;
    pub const DEFAULT_TEXT: usize = 1_024;
    pub const MAX_TEXT: usize = 4_096;
    pub const DEFAULT_OUTPUT: usize = 60_000;

    /// Applies per-call overrides, clamped to the hard maxima.
    pub fn with_overrides(max_nodes: Option<usize>, max_depth: Option<usize>) -> Self {
        TreeBudget {
            max_depth: max_depth.unwrap_or(Self::DEFAULT_DEPTH).clamp(1, Self::MAX_DEPTH),
            max_nodes: max_nodes.unwrap_or(Self::DEFAULT_NODES).clamp(1, Self::MAX_NODES),
            ..TreeBudget::default()
        }
    }
}

impl Default for TreeBudget {
    fn default() -> Self {
        TreeBudget {
            max_depth: Self::DEFAULT_DEPTH,
            max_nodes: Self::DEFAULT_NODES,
            max_children: Self::DEFAULT_CHILDREN,
            max_text: Self::DEFAULT_TEXT,
            max_output: Self::DEFAULT_OUTPUT,
        }
    }
}

/// Cuts `text` to at most `max_chars` characters on a char boundary.
pub fn cut_text(text: &str, max_chars: usize) -> (String, usize) {
    let total = text.chars().count();
    if total <= max_chars {
        return (text.to_owned(), total);
    }
    (text.chars().take(max_chars).collect(), total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_budget_overrides_to_hard_maxima() {
        let budget = TreeBudget::with_overrides(Some(100_000), Some(0));
        assert_eq!(budget.max_nodes, TreeBudget::MAX_NODES);
        assert_eq!(budget.max_depth, 1);
        assert_eq!(budget.max_children, TreeBudget::DEFAULT_CHILDREN);

        let defaults = TreeBudget::with_overrides(None, None);
        assert_eq!(defaults, TreeBudget::default());
    }

    #[test]
    fn cuts_text_on_char_boundaries() {
        assert_eq!(cut_text("héllo", 2), ("hé".to_owned(), 5));
        assert_eq!(cut_text("hi", 5), ("hi".to_owned(), 2));
    }
}
