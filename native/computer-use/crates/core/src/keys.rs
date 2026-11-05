//! Parses `computer_press` key strings and refuses system-level combos.
//!
//! Syntax: chords joined by `+`, sequences separated by spaces, e.g. `"cmd+a"`,
//! `"shift+tab"`, `"down down return"`.

use cu_protocol::{ErrorCode, ErrorObject};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct Modifiers {
    pub cmd: bool,
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
    pub function: bool,
}

impl Modifiers {
    pub fn is_empty(&self) -> bool {
        *self == Modifiers::default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NamedKey {
    Return,
    Enter,
    Escape,
    Tab,
    Space,
    Delete,
    ForwardDelete,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    F(u8),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Key {
    Named(NamedKey),
    /// A printable character, lowercased for letters. The backend maps it through
    /// the current keyboard layout.
    Char(char),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct KeyChord {
    pub modifiers: Modifiers,
    pub key: Key,
}

impl KeyChord {
    pub fn is_plain(&self, key: NamedKey) -> bool {
        self.modifiers.is_empty() && self.key == Key::Named(key)
    }
}

fn invalid(message: String) -> ErrorObject {
    ErrorObject::new(ErrorCode::InvalidArgument, message)
}

fn parse_named(token: &str) -> Option<Key> {
    let named = match token {
        "return" => NamedKey::Return,
        "enter" => NamedKey::Enter,
        "escape" | "esc" => NamedKey::Escape,
        "tab" => NamedKey::Tab,
        "space" => NamedKey::Space,
        "delete" | "backspace" => NamedKey::Delete,
        "forward_delete" => NamedKey::ForwardDelete,
        "up" => NamedKey::Up,
        "down" => NamedKey::Down,
        "left" => NamedKey::Left,
        "right" => NamedKey::Right,
        "home" => NamedKey::Home,
        "end" => NamedKey::End,
        "page_up" => NamedKey::PageUp,
        "page_down" => NamedKey::PageDown,
        "plus" => return Some(Key::Char('+')),
        "minus" => return Some(Key::Char('-')),
        _ => {
            let number = token.strip_prefix('f')?.parse::<u8>().ok()?;
            if !(1..=12).contains(&number) {
                return None;
            }
            NamedKey::F(number)
        }
    };
    Some(Key::Named(named))
}

/// Parses one chord such as `cmd+shift+z`.
pub fn parse_chord(text: &str) -> Result<KeyChord, ErrorObject> {
    let lowered = text.to_lowercase();
    let parts: Vec<&str> = lowered.split('+').collect();
    let Some((key_part, modifier_parts)) = parts.split_last() else {
        return Err(invalid(format!("empty key chord in {text:?}")));
    };

    let mut modifiers = Modifiers::default();
    for part in modifier_parts {
        match *part {
            "cmd" | "command" | "meta" => modifiers.cmd = true,
            "shift" => modifiers.shift = true,
            "alt" | "option" | "opt" => modifiers.alt = true,
            "ctrl" | "control" => modifiers.ctrl = true,
            "fn" | "globe" => modifiers.function = true,
            other => return Err(invalid(format!("unknown modifier {other:?} in {text:?}"))),
        }
    }

    let key = if let Some(named) = parse_named(key_part) {
        named
    } else {
        let mut characters = key_part.chars();
        match (characters.next(), characters.next()) {
            (Some(character), None) if !character.is_control() => Key::Char(character),
            _ => return Err(invalid(format!("unknown key {key_part:?} in {text:?}"))),
        }
    };

    Ok(KeyChord { modifiers, key })
}

/// Parses a space-separated sequence of chords. At most 50 chords.
pub fn parse_key_sequence(text: &str) -> Result<Vec<KeyChord>, ErrorObject> {
    let chords = text.split_whitespace().map(parse_chord).collect::<Result<Vec<_>, _>>()?;
    if chords.is_empty() {
        return Err(invalid("keys must name at least one key".to_owned()));
    }
    if chords.len() > 50 {
        return Err(invalid("keys may name at most 50 chords".to_owned()));
    }
    Ok(chords)
}

/// Why a chord is refused, if it is: quit, force quit, log out, lock screen,
/// screenshots, and globe/fn system shortcuts.
pub fn refused_reason(chord: &KeyChord) -> Option<&'static str> {
    let m = chord.modifiers;
    let ch = match chord.key {
        Key::Char(character) => Some(character),
        _ => None,
    };

    if m.cmd && !m.ctrl && ch == Some('q') && !m.shift {
        return Some("quit");
    }
    if m.cmd && m.ctrl && ch == Some('q') {
        return Some("lock_screen");
    }
    if m.cmd && m.shift && ch == Some('q') {
        return Some("log_out");
    }
    if m.cmd && m.alt && chord.key == Key::Named(NamedKey::Escape) {
        return Some("force_quit");
    }
    if m.cmd && m.shift && matches!(ch, Some('3' | '4' | '5' | '6')) {
        return Some("screenshot");
    }
    if m.function {
        let is_navigation = matches!(
            chord.key,
            Key::Named(
                NamedKey::F(_)
                    | NamedKey::Up
                    | NamedKey::Down
                    | NamedKey::Left
                    | NamedKey::Right
                    | NamedKey::Delete
                    | NamedKey::Return
            )
        );
        if !is_navigation {
            return Some("system_shortcut");
        }
    }
    None
}

/// Returns `key_refused` for the first refused chord.
pub fn check_refused(chords: &[KeyChord]) -> Result<(), ErrorObject> {
    for chord in chords {
        if let Some(reason) = refused_reason(chord) {
            return Err(ErrorObject::with_reason(
                ErrorCode::KeyRefused,
                reason,
                "this key combination is not allowed for computer use",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chord(text: &str) -> KeyChord {
        parse_chord(text).unwrap()
    }

    #[test]
    fn parses_chords_and_sequences() {
        assert_eq!(
            chord("cmd+a"),
            KeyChord { modifiers: Modifiers { cmd: true, ..Modifiers::default() }, key: Key::Char('a') }
        );
        assert_eq!(
            chord("Shift+Tab"),
            KeyChord { modifiers: Modifiers { shift: true, ..Modifiers::default() }, key: Key::Named(NamedKey::Tab) }
        );
        assert!(chord("option+f12").modifiers.alt);
        assert_eq!(chord("f12").key, Key::Named(NamedKey::F(12)));
        assert_eq!(chord("cmd+plus").key, Key::Char('+'));

        let sequence = parse_key_sequence("down down  return").unwrap();
        assert_eq!(sequence.len(), 3);
        assert!(sequence[2].is_plain(NamedKey::Return));
    }

    #[test]
    fn rejects_bad_key_strings() {
        assert_eq!(parse_chord("hyper+a").unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(parse_chord("cmd+").unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(parse_chord("f13").unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(parse_chord("cmd+abc").unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(parse_key_sequence("   ").unwrap_err().code, ErrorCode::InvalidArgument);
    }

    #[test]
    fn refuses_system_combos() {
        for text in ["cmd+q", "ctrl+cmd+q", "cmd+shift+q", "cmd+alt+shift+q", "cmd+alt+escape", "cmd+shift+4", "ctrl+cmd+shift+3", "fn+e", "fn+q"] {
            assert!(refused_reason(&chord(text)).is_some(), "{text} should be refused");
        }
        for text in ["cmd+a", "cmd+w", "shift+tab", "return", "fn+f5", "fn+left", "cmd+3"] {
            assert_eq!(refused_reason(&chord(text)), None, "{text} should be allowed");
        }

        let error = check_refused(&parse_key_sequence("cmd+a cmd+q").unwrap()).unwrap_err();
        assert_eq!(error.code, ErrorCode::KeyRefused);
        assert_eq!(error.details.unwrap()["reason"], "quit");
    }
}
