//! Small text helpers shared by the engine and backends.

/// Normalizes a menu title for matching: case-insensitive, `…` equals `...`, and
/// trailing shortcut glyphs are ignored.
pub fn normalize_menu_title(title: &str) -> String {
    let replaced = title.replace('\u{2026}', "...");
    // Cut a trailing shortcut such as " ⌘S" or " ⇧⌘Z".
    let is_glyph = |c: char| matches!(c, '⌘' | '⇧' | '⌥' | '⌃' | '⇪' | '🌐' | 'ⓕ');
    let cut = replaced
        .char_indices()
        .find(|(index, c)| is_glyph(*c) && replaced[..*index].ends_with(char::is_whitespace))
        .map(|(index, _)| index)
        .unwrap_or(replaced.len());
    replaced[..cut].trim().to_lowercase()
}

pub fn menu_title_matches(candidate: &str, wanted: &str) -> bool {
    normalize_menu_title(candidate) == normalize_menu_title(wanted)
}

/// Leaf titles that quit, log out, lock, or power off. Refused like their key combos.
const REFUSED_MENU_LEAVES: &[&str] = &["quit", "force quit", "log out", "lock screen", "shut down", "restart", "sleep"];

/// Why a menu path is refused, if it is: anything in the Apple menu, and quit-like items.
pub fn refused_menu_reason(path: &[String]) -> Option<&'static str> {
    let first = path.first().map(|title| normalize_menu_title(title))?;
    if first == "apple" {
        return Some("refused_menu");
    }
    let leaf = normalize_menu_title(path.last()?);
    let leaf = leaf.trim_end_matches('.');
    let refused = REFUSED_MENU_LEAVES
        .iter()
        .any(|refused| leaf == *refused || leaf.starts_with(&format!("{refused} ")));
    refused.then_some("refused_menu")
}

/// UTF-16 offset of the first occurrence of `needle` in `haystack`.
pub fn utf16_find(haystack: &str, needle: &str) -> Option<usize> {
    let byte_index = haystack.find(needle)?;
    Some(haystack[..byte_index].encode_utf16().count())
}

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Splits text into chunks of at most `max_units` UTF-16 code units without breaking
/// a character apart.
pub fn utf16_chunks(text: &str, max_units: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut units = 0;
    for character in text.chars() {
        let width = character.len_utf16();
        if units + width > max_units && !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
            units = 0;
        }
        current.push(character);
        units += width;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_menu_titles_loosely() {
        assert!(menu_title_matches("Export As…", "export as..."));
        assert!(menu_title_matches("Save ⌘S", "save"));
        assert!(menu_title_matches("  Bold ", "BOLD"));
        assert!(!menu_title_matches("Bold", "Italic"));
    }

    #[test]
    fn refuses_quit_and_apple_menu_paths() {
        let path = |items: &[&str]| items.iter().map(|item| item.to_string()).collect::<Vec<_>>();
        assert_eq!(refused_menu_reason(&path(&["Apple", "Lock Screen"])), Some("refused_menu"));
        assert_eq!(refused_menu_reason(&path(&["TextEdit", "Quit TextEdit"])), Some("refused_menu"));
        assert_eq!(refused_menu_reason(&path(&["File", "Log Out…"])), Some("refused_menu"));
        assert_eq!(refused_menu_reason(&path(&["Format", "Font", "Bold"])), None);
        assert_eq!(refused_menu_reason(&path(&["Edit", "Quitting Tips"])), None);
    }

    #[test]
    fn handles_utf16_offsets_and_chunks() {
        assert_eq!(utf16_find("a😀b", "b"), Some(3));
        assert_eq!(utf16_find("abc", "z"), None);
        let chunks = utf16_chunks(&"😀".repeat(15), 20);
        assert!(chunks.iter().all(|chunk| utf16_len(chunk) <= 20));
        assert_eq!(chunks.concat(), "😀".repeat(15));
        assert_eq!(utf16_chunks("", 20), Vec::<String>::new());
    }
}
