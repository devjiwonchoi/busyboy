//! Prunes a walked tree and renders the compact, model-facing outline.

use cu_protocol::Truncation;

use crate::tree::{ElementAction, RawNode, RawTree, Rect, roles};

/// One emitted line: a node index and its indentation depth.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Line {
    pub node: usize,
    pub depth: usize,
}

fn is_structural<E>(node: &RawNode<E>) -> bool {
    let has_actions = node.actions.iter().any(|action| *action != ElementAction::ScrollToVisible);
    node.name.is_none()
        && node.value.is_none()
        && node.description.is_none()
        && !has_actions
        && !node.states.focused
        && !node.states.selected
}

/// Chooses the lines to emit. Purely structural containers with a single child are
/// collapsed into that child, and empty structural leaves are dropped.
pub fn layout<E>(tree: &RawTree<E>) -> Vec<Line> {
    let mut lines = Vec::new();
    if tree.nodes.is_empty() {
        return lines;
    }

    // Iterative pre-order walk; children pushed in reverse to keep order.
    let mut stack = vec![(0usize, 0usize)];
    while let Some((index, depth)) = stack.pop() {
        let node = &tree.nodes[index];
        let structural = index != 0 && is_structural(node);

        if structural && node.children.len() == 1 {
            stack.push((node.children[0], depth));
            continue;
        }
        if structural && node.children.is_empty() && node.role != roles::WEB_AREA {
            continue;
        }

        lines.push(Line { node: index, depth });
        for child in node.children.iter().rev() {
            stack.push((*child, depth + 1));
        }
    }
    lines
}

fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// Renders a single node line without indentation.
pub fn render_node<E>(node: &RawNode<E>, number: u32, window_origin: Option<Rect>) -> String {
    let mut line = format!("e{number} {}", node.role);

    let mut name = node.name.clone().or_else(|| node.description.clone());
    let mut value = node.value.clone();
    // Static text carries its text in the value; show it as the name.
    if name.is_none() && node.role == roles::STATIC_TEXT {
        name = value.take();
    }
    if let Some(name) = &name {
        line.push(' ');
        line.push_str(&quote(name));
    }

    if !node.states.secure
        && let Some(value) = value.filter(|value| Some(value) != name.as_ref())
    {
        let shown = value.chars().count();
        if node.value_len > shown {
            line.push_str(&format!(" value={}", quote(&format!("{value}…({} chars)", node.value_len))));
        } else {
            line.push_str(&format!(" value={}", quote(&value)));
        }
    }

    let states = &node.states;
    let words = [
        (states.focused, "focused"),
        (states.selected, "selected"),
        (states.disabled, "disabled"),
        (states.expanded == Some(true), "expanded"),
        (states.expanded == Some(false), "collapsed"),
        (states.editable && !states.secure, "editable"),
        (states.secure, "secure"),
        (states.checked == Some(true), "checked"),
        (states.checked == Some(false), "unchecked"),
    ];
    for (on, word) in words {
        if on {
            line.push(' ');
            line.push_str(word);
        }
    }

    if let (Some(origin), Some(bounds)) = (window_origin, node.bounds) {
        line.push_str(&format!(
            " @{},{},{},{}",
            (bounds.x - origin.x).round(),
            (bounds.y - origin.y).round(),
            bounds.width.round(),
            bounds.height.round()
        ));
    }
    line
}

pub struct Rendered {
    pub text: String,
    /// Lines actually emitted, with their ref numbers.
    pub emitted: usize,
    pub size_truncated: bool,
}

/// Renders lines with their ref numbers, stopping at `max_output` characters.
pub fn render_lines<E>(
    tree: &RawTree<E>,
    lines: &[Line],
    numbers: &[u32],
    window_origin: Option<Rect>,
    max_output: usize,
) -> Rendered {
    let mut text = String::new();
    let mut emitted = 0;
    for (line, number) in lines.iter().zip(numbers) {
        let rendered = render_node(&tree.nodes[line.node], *number, window_origin);
        if text.len() + rendered.len() + line.depth * 2 + 1 > max_output {
            return Rendered { text, emitted, size_truncated: true };
        }
        for _ in 0..line.depth {
            text.push_str("  ");
        }
        text.push_str(&rendered);
        text.push('\n');
        emitted += 1;
    }
    Rendered { text, emitted, size_truncated: false }
}

/// Picks the reported truncation: a walk budget first, then output size.
pub fn truncation(tree_truncated: Option<Truncation>, size_truncated: bool) -> Option<Truncation> {
    tree_truncated.or(size_truncated.then_some(Truncation::Size))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::NodeStates;

    fn node(role: &str, name: Option<&str>, children: Vec<usize>) -> RawNode<()> {
        RawNode {
            handle: (),
            role: role.to_owned(),
            name: name.map(str::to_owned),
            value: None,
            value_len: 0,
            description: None,
            states: NodeStates::default(),
            bounds: None,
            actions: vec![],
            children,
        }
    }

    fn sample() -> RawTree<()> {
        let mut text_area = node("text area", None, vec![]);
        text_area.value = Some("Hello wor".to_owned());
        text_area.value_len = 214;
        text_area.states.focused = true;
        text_area.states.editable = true;

        let mut bold = node("button", None, vec![]);
        bold.description = Some("Bold".to_owned());
        bold.actions = vec![ElementAction::Press];

        let mut secure = node("secure text field", Some("Password"), vec![]);
        secure.states.secure = true;
        secure.states.editable = true;

        RawTree {
            nodes: vec![
                node("window", Some("Untitled"), vec![1, 3, 6]),
                node("toolbar", None, vec![2]),
                bold,
                node("group", None, vec![4]),
                node("scroll area", None, vec![5]),
                text_area,
                secure,
            ],
            truncated: None,
            menus: vec![],
            needs_web_accessibility: false,
        }
    }

    #[test]
    fn collapses_single_child_structure_and_renders_states() {
        let tree = sample();
        let lines = layout(&tree);
        let nodes: Vec<usize> = lines.iter().map(|line| line.node).collect();
        // The toolbar, group, and scroll area each wrap one child and say nothing.
        assert_eq!(nodes, vec![0, 2, 5, 6]);

        let numbers: Vec<u32> = (1..=lines.len() as u32).collect();
        let rendered = render_lines(&tree, &lines, &numbers, None, 10_000);
        assert_eq!(
            rendered.text,
            concat!(
                "e1 window \"Untitled\"\n",
                "  e2 button \"Bold\"\n",
                "  e3 text area value=\"Hello wor…(214 chars)\" focused editable\n",
                "  e4 secure text field \"Password\" secure\n",
            )
        );
        assert!(!rendered.size_truncated);
    }

    #[test]
    fn stops_at_the_output_budget() {
        let tree = sample();
        let lines = layout(&tree);
        let numbers: Vec<u32> = (1..=lines.len() as u32).collect();
        let rendered = render_lines(&tree, &lines, &numbers, None, 30);
        assert!(rendered.size_truncated);
        assert_eq!(rendered.emitted, 1);
        assert_eq!(truncation(None, rendered.size_truncated), Some(Truncation::Size));
        assert_eq!(truncation(Some(Truncation::Deadline), true), Some(Truncation::Deadline));
    }

    #[test]
    fn appends_window_local_bounds_when_asked() {
        let mut button = node("button", Some("OK"), vec![]);
        button.bounds = Some(Rect { x: 110.0, y: 220.0, width: 80.0, height: 24.0 });
        let origin = Rect { x: 100.0, y: 200.0, width: 500.0, height: 400.0 };
        assert_eq!(render_node(&button, 3, Some(origin)), "e3 button \"OK\" @10,20,80,24");
    }

    #[test]
    fn escapes_quotes_and_newlines() {
        let mut label = node("text", None, vec![]);
        label.value = Some("say \"hi\"\nnow".to_owned());
        assert_eq!(render_node(&label, 1, None), "e1 text \"say \\\"hi\\\"\\nnow\"");
    }
}
