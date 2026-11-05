//! Layout-aware key events posted to one process, tagged with [`crate::EVENT_TAG`].
//!
//! Portions adapted from agent-desktop (https://github.com/vercel-labs/agent-desktop, Apache-2.0) at d3dc190. Modified by BusyBoy.
//! (Technique: reverse lookup of a character through `UCKeyTranslate` on the current
//! layout, rejecting dead keys, and reading the layout on the main thread only.)
//!
//! Events go only to the target pid through `CGEventPostToPid`, from a private event
//! source so the user's physical modifier state does not leak in. Nothing here posts
//! to a session or HID tap.

use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use cu_core::CuResult;
use cu_core::keys::{Key, KeyChord, Modifiers, NamedKey};
use cu_core::platform::{RunningApp, unsupported};
use cu_core::text::utf16_chunks;
use objc2_core_foundation::{CFData, CFRetained, CFString, CFType};
use objc2_core_graphics::{CGEvent, CGEventField, CGEventFlags, CGEventSource, CGEventSourceStateID};

/// Most UTF-16 units one Unicode key event carries.
pub const MAX_TEXT_UNITS: usize = 20;

/// How a printable character is typed on a layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyMapping {
    pub code: u16,
    pub shift: bool,
    pub option: bool,
}

type ReverseMap = HashMap<char, KeyMapping>;

pub fn post_key(app: &RunningApp, chord: &KeyChord) -> CuResult<()> {
    let (code, flags) = match chord.key {
        Key::Named(named) => (named_key_code(named), modifier_flags(&chord.modifiers) | implicit_flags(named)),
        Key::Char(character) => {
            let mapping = lookup_char(character).ok_or_else(|| {
                unsupported("unmappable_key", format!("no key types {character:?} on the current keyboard layout"))
            })?;
            let mut modifiers = chord.modifiers;
            modifiers.shift |= mapping.shift;
            modifiers.alt |= mapping.option;
            (mapping.code, modifier_flags(&modifiers))
        }
    };
    let source = private_source()?;
    for down in [true, false] {
        let event = CGEvent::new_keyboard_event(Some(&source), code, down)
            .ok_or_else(|| unsupported("event_create_failed", "could not create a key event"))?;
        CGEvent::set_flags(Some(&event), flags);
        post(app.process.pid, &event);
    }
    Ok(())
}

pub fn post_text(app: &RunningApp, text: &str) -> CuResult<()> {
    let source = private_source()?;
    // The core already chunks; split again so one event never exceeds the limit.
    for units in text_chunks(text) {
        for down in [true, false] {
            let event = CGEvent::new_keyboard_event(Some(&source), 0, down)
                .ok_or_else(|| unsupported("event_create_failed", "could not create a key event"))?;
            CGEvent::set_flags(Some(&event), CGEventFlags::empty());
            // SAFETY: `units` is a live buffer of exactly `units.len()` UTF-16 units.
            unsafe { CGEvent::keyboard_set_unicode_string(Some(&event), units.len() as _, units.as_ptr()) };
            post(app.process.pid, &event);
        }
    }
    Ok(())
}

/// Text split into UTF-16 buffers of at most [`MAX_TEXT_UNITS`] units, never
/// splitting a surrogate pair.
fn text_chunks(text: &str) -> Vec<Vec<u16>> {
    utf16_chunks(text, MAX_TEXT_UNITS).iter().map(|chunk| chunk.encode_utf16().collect()).collect()
}

fn private_source() -> CuResult<CFRetained<CGEventSource>> {
    let source = CGEventSource::new(CGEventSourceStateID::Private)
        .ok_or_else(|| unsupported("event_source_failed", "could not create a private event source"))?;
    CGEventSource::set_user_data(Some(&source), crate::EVENT_TAG);
    Ok(source)
}

/// Tags and posts one event to the pid only.
fn post(pid: i32, event: &CGEvent) {
    CGEvent::set_integer_value_field(Some(event), CGEventField::EventSourceUserData, crate::EVENT_TAG);
    CGEvent::post_to_pid(pid, Some(event));
}

// -- fixed tables ---------------------------------------------------------------

/// Virtual key code for a named key. These keys sit at the same code on every layout.
pub fn named_key_code(key: NamedKey) -> u16 {
    match key {
        NamedKey::Return => 36,
        NamedKey::Enter => 76,
        NamedKey::Tab => 48,
        NamedKey::Space => 49,
        NamedKey::Delete => 51,
        NamedKey::Escape => 53,
        NamedKey::ForwardDelete => 117,
        NamedKey::Home => 115,
        NamedKey::End => 119,
        NamedKey::PageUp => 116,
        NamedKey::PageDown => 121,
        NamedKey::Left => 123,
        NamedKey::Right => 124,
        NamedKey::Down => 125,
        NamedKey::Up => 126,
        NamedKey::F(number) => match number {
            1 => 122,
            2 => 120,
            3 => 99,
            4 => 118,
            5 => 96,
            6 => 97,
            7 => 98,
            8 => 100,
            9 => 101,
            10 => 109,
            11 => 103,
            _ => 111,
        },
    }
}

pub fn modifier_flags(modifiers: &Modifiers) -> CGEventFlags {
    let mut flags = CGEventFlags::empty();
    if modifiers.cmd {
        flags |= CGEventFlags::MaskCommand;
    }
    if modifiers.shift {
        flags |= CGEventFlags::MaskShift;
    }
    if modifiers.alt {
        flags |= CGEventFlags::MaskAlternate;
    }
    if modifiers.ctrl {
        flags |= CGEventFlags::MaskControl;
    }
    if modifiers.function {
        flags |= CGEventFlags::MaskSecondaryFn;
    }
    flags
}

/// Flags a physical keyboard sets on its own for these keys: arrows report numeric
/// pad + fn, the navigation and function keys report fn, keypad enter reports numeric pad.
fn implicit_flags(key: NamedKey) -> CGEventFlags {
    match key {
        NamedKey::Up | NamedKey::Down | NamedKey::Left | NamedKey::Right => {
            CGEventFlags::MaskNumericPad | CGEventFlags::MaskSecondaryFn
        }
        NamedKey::Home
        | NamedKey::End
        | NamedKey::PageUp
        | NamedKey::PageDown
        | NamedKey::ForwardDelete
        | NamedKey::F(_) => CGEventFlags::MaskSecondaryFn,
        NamedKey::Enter => CGEventFlags::MaskNumericPad,
        _ => CGEventFlags::empty(),
    }
}

/// US ANSI positions, used for ASCII characters the current layout does not type
/// (e.g. `cmd+c` on a Cyrillic layout, where AppKit matches shortcuts by ANSI
/// position) and when the layout cannot be read at all.
fn ansi_mapping(character: char) -> Option<KeyMapping> {
    let plain = |code| Some(KeyMapping { code, shift: false, option: false });
    let shifted = |code| Some(KeyMapping { code, shift: true, option: false });
    match character {
        'a' => plain(0),
        's' => plain(1),
        'd' => plain(2),
        'f' => plain(3),
        'h' => plain(4),
        'g' => plain(5),
        'z' => plain(6),
        'x' => plain(7),
        'c' => plain(8),
        'v' => plain(9),
        'b' => plain(11),
        'q' => plain(12),
        'w' => plain(13),
        'e' => plain(14),
        'r' => plain(15),
        'y' => plain(16),
        't' => plain(17),
        '1' => plain(18),
        '2' => plain(19),
        '3' => plain(20),
        '4' => plain(21),
        '6' => plain(22),
        '5' => plain(23),
        '=' => plain(24),
        '9' => plain(25),
        '7' => plain(26),
        '-' => plain(27),
        '8' => plain(28),
        '0' => plain(29),
        ']' => plain(30),
        'o' => plain(31),
        'u' => plain(32),
        '[' => plain(33),
        'i' => plain(34),
        'p' => plain(35),
        'l' => plain(37),
        'j' => plain(38),
        '\'' => plain(39),
        'k' => plain(40),
        ';' => plain(41),
        '\\' => plain(42),
        ',' => plain(43),
        '/' => plain(44),
        'n' => plain(45),
        'm' => plain(46),
        '.' => plain(47),
        ' ' => plain(49),
        '`' => plain(50),
        '!' => shifted(18),
        '@' => shifted(19),
        '#' => shifted(20),
        '$' => shifted(21),
        '^' => shifted(22),
        '%' => shifted(23),
        '+' => shifted(24),
        '(' => shifted(25),
        '&' => shifted(26),
        '_' => shifted(27),
        '*' => shifted(28),
        ')' => shifted(29),
        '}' => shifted(30),
        '{' => shifted(33),
        '"' => shifted(39),
        ':' => shifted(41),
        '|' => shifted(42),
        '<' => shifted(43),
        '?' => shifted(44),
        '>' => shifted(47),
        '~' => shifted(50),
        _ => None,
    }
}

// -- reverse layout map (pure) ----------------------------------------------------

/// Modifier states (shift, option) tried per key, plainest first.
const MODIFIER_STATES: [(bool, bool); 4] = [(false, false), (true, false), (false, true), (true, true)];

/// Key codes that may type characters, main block first so `1` maps to the number
/// row rather than the keypad.
fn candidate_codes() -> impl Iterator<Item = u16> {
    let keypad = |code: &u16| (65..=92).contains(code);
    (0u16..128).filter(move |code| !keypad(code)).chain((0u16..128).filter(keypad))
}

/// A translation is a typable character only when it is exactly one UTF-16 unit,
/// not a control character, and did not start a dead-key sequence.
fn accepted(status: i32, dead_key_state: u32, units: &[u16]) -> Option<char> {
    if status != 0 || dead_key_state != 0 || units.len() != 1 {
        return None;
    }
    char::from_u32(u32::from(units[0])).filter(|character| !character.is_control())
}

/// Builds char → key from `translate(code, shift, option)`. The plainest modifier
/// state wins, then the main block over the keypad.
fn build_reverse_map(translate: impl Fn(u16, bool, bool) -> Option<char>) -> ReverseMap {
    let mut map = ReverseMap::new();
    for (shift, option) in MODIFIER_STATES {
        for code in candidate_codes() {
            if let Some(character) = translate(code, shift, option) {
                map.entry(character).or_insert(KeyMapping { code, shift, option });
            }
        }
    }
    map
}

/// The current layout first, then ANSI positions for ASCII.
fn resolve(map: Option<&ReverseMap>, character: char) -> Option<KeyMapping> {
    map.and_then(|map| map.get(&character).copied()).or_else(|| ansi_mapping(character))
}

// -- current layout ---------------------------------------------------------------

static CACHE: Mutex<Option<(String, Arc<ReverseMap>)>> = Mutex::new(None);

fn lookup_char(character: char) -> Option<KeyMapping> {
    let map = current_map();
    resolve(map.as_deref(), character)
}

/// Reverse map for the current layout, rebuilt only when the layout id changes.
/// `None` when the layout cannot be read (callers then fall back to ANSI).
fn current_map() -> Option<Arc<ReverseMap>> {
    let known = CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref().map(|(id, _)| id.clone());
    let read = layout::read_on_main(known)?;
    let mut cache = CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match read.data {
        None => cache.as_ref().filter(|(id, _)| *id == read.id).map(|(_, map)| map.clone()),
        Some(data) => {
            let map = Arc::new(build_reverse_map(|code, shift, option| {
                layout::translate(&data, read.keyboard_type, code, shift, option)
            }));
            *cache = Some((read.id, map.clone()));
            Some(map)
        }
    }
}

mod layout {
    use super::*;

    /// What the main thread hands back: the layout id, plus the `uchr` bytes when
    /// the id differs from the cached one.
    pub struct LayoutRead {
        pub id: String,
        pub data: Option<Vec<u8>>,
        pub keyboard_type: u32,
    }

    #[link(name = "Carbon", kind = "framework")]
    unsafe extern "C" {
        fn TISCopyCurrentKeyboardLayoutInputSource() -> *mut c_void;
        fn TISGetInputSourceProperty(source: *mut c_void, key: *const CFString) -> *const c_void;
        static kTISPropertyUnicodeKeyLayoutData: *const CFString;
        static kTISPropertyInputSourceID: *const CFString;
        fn LMGetKbdType() -> u8;
        fn UCKeyTranslate(
            layout: *const c_void,
            virtual_key_code: u16,
            key_action: u16,
            modifier_key_state: u32,
            keyboard_type: u32,
            key_translate_options: u32,
            dead_key_state: *mut u32,
            max_string_length: usize,
            actual_string_length: *mut usize,
            unicode_string: *mut u16,
        ) -> i32;
    }

    #[repr(C)]
    struct DispatchQueue {
        _private: [u8; 0],
    }

    unsafe extern "C" {
        static _dispatch_main_q: DispatchQueue;
        fn dispatch_async_f(queue: *const DispatchQueue, context: *mut c_void, work: extern "C" fn(*mut c_void));
        fn pthread_main_np() -> i32;
    }

    const KEY_ACTION_DOWN: u16 = 0;
    // Carbon `shiftKey >> 8` and `optionKey >> 8`, as UCKeyTranslate expects.
    const SHIFT_STATE: u32 = 0x02;
    const OPTION_STATE: u32 = 0x08;
    /// How long to wait for the main thread before using the ANSI fallback.
    const MAIN_WAIT: Duration = Duration::from_millis(250);

    type Job = (Option<String>, mpsc::SyncSender<Option<LayoutRead>>);

    /// Text Input Source calls must run on the main thread. Runs there directly when
    /// already on it, else hops through the main dispatch queue with a short wait.
    /// `None` if the main thread does not service its queue in time or the layout
    /// is unreadable.
    pub fn read_on_main(known: Option<String>) -> Option<LayoutRead> {
        // SAFETY: plain query of the calling thread.
        if unsafe { pthread_main_np() } == 1 {
            return read_current(known.as_deref());
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        let job: Box<Job> = Box::new((known, sender));
        // SAFETY: the main queue is a process-lifetime static; `run_job` reclaims the
        // boxed job exactly once.
        unsafe { dispatch_async_f(&raw const _dispatch_main_q, Box::into_raw(job).cast(), run_job) };
        receiver.recv_timeout(MAIN_WAIT).ok().flatten()
    }

    extern "C" fn run_job(context: *mut c_void) {
        // SAFETY: `context` is the `Box<Job>` leaked in `read_on_main`.
        let job = unsafe { Box::from_raw(context.cast::<Job>()) };
        let (known, sender) = *job;
        // The waiter may have timed out; a failed send is fine.
        let _ = sender.send(read_current(known.as_deref()));
    }

    /// Main thread only.
    fn read_current(known: Option<&str>) -> Option<LayoutRead> {
        // SAFETY: called on the main thread; returns a +1 TISInputSourceRef or null.
        let source = NonNull::new(unsafe { TISCopyCurrentKeyboardLayoutInputSource() })?;
        // SAFETY: TISInputSourceRef is a CF object handed over at +1; dropping releases it.
        let source: CFRetained<CFType> = unsafe { CFRetained::from_raw(source.cast()) };
        let raw = CFRetained::as_ptr(&source).as_ptr().cast::<c_void>();

        // SAFETY: valid source and key; the get-rule result is a CFString (or null)
        // owned by `source`, which outlives this borrow.
        let id = unsafe { (TISGetInputSourceProperty(raw, kTISPropertyInputSourceID) as *const CFString).as_ref() }
            .map(|id| id.to_string())
            .unwrap_or_default();
        // SAFETY: plain query.
        let keyboard_type = u32::from(unsafe { LMGetKbdType() });
        if !id.is_empty() && known == Some(id.as_str()) {
            return Some(LayoutRead { id, data: None, keyboard_type });
        }
        // SAFETY: valid source and key; the get-rule result is a CFData (or null)
        // owned by `source`, which stays alive until the bytes are copied.
        let data =
            unsafe { (TISGetInputSourceProperty(raw, kTISPropertyUnicodeKeyLayoutData) as *const CFData).as_ref() }
                .map(|data| data.to_vec())
                .filter(|bytes| !bytes.is_empty())?;
        Some(LayoutRead { id, data: Some(data), keyboard_type })
    }

    /// One key translation on a copied `uchr` layout. Pure; any thread.
    pub fn translate(layout: &[u8], keyboard_type: u32, code: u16, shift: bool, option: bool) -> Option<char> {
        let mut modifiers = 0;
        if shift {
            modifiers |= SHIFT_STATE;
        }
        if option {
            modifiers |= OPTION_STATE;
        }
        let mut dead_key_state = 0u32;
        let mut length = 0usize;
        let mut buffer = [0u16; 4];
        // SAFETY: `layout` is a full copy of the layout's `uchr` data; every out
        // pointer is valid and the buffer length is passed.
        let status = unsafe {
            UCKeyTranslate(
                layout.as_ptr().cast(),
                code,
                KEY_ACTION_DOWN,
                modifiers,
                keyboard_type,
                0,
                &mut dead_key_state,
                buffer.len(),
                &mut length,
                buffer.as_mut_ptr(),
            )
        };
        accepted(status, dead_key_state, buffer.get(..length)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_keys_use_fixed_codes() {
        let expected = [
            (NamedKey::Return, 36),
            (NamedKey::Enter, 76),
            (NamedKey::Tab, 48),
            (NamedKey::Space, 49),
            (NamedKey::Delete, 51),
            (NamedKey::Escape, 53),
            (NamedKey::ForwardDelete, 117),
            (NamedKey::Home, 115),
            (NamedKey::End, 119),
            (NamedKey::PageUp, 116),
            (NamedKey::PageDown, 121),
            (NamedKey::Left, 123),
            (NamedKey::Right, 124),
            (NamedKey::Down, 125),
            (NamedKey::Up, 126),
            (NamedKey::F(1), 122),
            (NamedKey::F(5), 96),
            (NamedKey::F(12), 111),
        ];
        for (key, code) in expected {
            assert_eq!(named_key_code(key), code, "{key:?}");
        }
    }

    #[test]
    fn chord_modifiers_map_to_flags() {
        assert_eq!(modifier_flags(&Modifiers::default()), CGEventFlags::empty());
        let all = Modifiers { cmd: true, shift: true, alt: true, ctrl: true, function: true };
        assert_eq!(
            modifier_flags(&all),
            CGEventFlags::MaskCommand
                | CGEventFlags::MaskShift
                | CGEventFlags::MaskAlternate
                | CGEventFlags::MaskControl
                | CGEventFlags::MaskSecondaryFn
        );
        assert_eq!(modifier_flags(&Modifiers { cmd: true, ..Modifiers::default() }), CGEventFlags::MaskCommand);
        assert!(implicit_flags(NamedKey::Up).contains(CGEventFlags::MaskNumericPad));
        assert_eq!(implicit_flags(NamedKey::Return), CGEventFlags::empty());
    }

    /// A tiny fake layout: AZERTY-like letters, a shifted number row, a keypad digit,
    /// a shifted symbol, an option symbol, and a dead key.
    fn fake(code: u16, shift: bool, option: bool) -> Option<char> {
        match (code, shift, option) {
            (12, false, false) => Some('a'),
            (12, true, false) => Some('A'),
            (0, false, false) => Some('q'),
            (18, false, false) => Some('&'),
            (18, true, false) => Some('1'),
            (83, false, false) => Some('1'),
            (24, true, false) => Some('+'),
            (13, false, true) => Some('∑'),
            _ => None, // code 50 stands for a dead key: never typable
        }
    }

    #[test]
    fn reverse_map_prefers_the_plainest_key() {
        let map = build_reverse_map(fake);
        assert_eq!(map[&'a'], KeyMapping { code: 12, shift: false, option: false });
        assert_eq!(map[&'A'], KeyMapping { code: 12, shift: true, option: false });
        assert_eq!(map[&'q'], KeyMapping { code: 0, shift: false, option: false });
        // An unshifted keypad key beats a shifted number-row key.
        assert_eq!(map[&'1'], KeyMapping { code: 83, shift: false, option: false });
        assert_eq!(map[&'+'], KeyMapping { code: 24, shift: true, option: false });
        assert_eq!(map[&'∑'], KeyMapping { code: 13, shift: false, option: true });
        assert!(!map.contains_key(&'`'));
    }

    #[test]
    fn main_block_beats_keypad_at_the_same_modifiers() {
        let map = build_reverse_map(|code, shift, option| match (code, shift, option) {
            (18, false, false) | (83, false, false) => Some('1'),
            _ => None,
        });
        assert_eq!(map[&'1'].code, 18);
    }

    #[test]
    fn resolves_through_layout_then_ansi() {
        let map = build_reverse_map(fake);
        assert_eq!(resolve(Some(&map), 'a').unwrap().code, 12);
        // Not on the fake layout: ASCII falls back to ANSI.
        assert_eq!(resolve(Some(&map), 'c'), Some(KeyMapping { code: 8, shift: false, option: false }));
        assert_eq!(resolve(None, '?'), Some(KeyMapping { code: 44, shift: true, option: false }));
        // Neither the layout nor ANSI types it.
        assert_eq!(resolve(Some(&map), 'ж'), None);
    }

    #[test]
    fn rejects_dead_keys_and_multi_unit_results() {
        assert_eq!(accepted(0, 0, &[0x61]), Some('a'));
        assert_eq!(accepted(0, 3, &[0x60]), None);
        assert_eq!(accepted(-1, 0, &[0x61]), None);
        assert_eq!(accepted(0, 0, &[0x61, 0x62]), None);
        assert_eq!(accepted(0, 0, &[]), None);
        assert_eq!(accepted(0, 0, &[0x0d]), None);
    }

    #[test]
    fn text_chunks_never_exceed_the_limit_or_split_pairs() {
        let text = format!("{}{}", "a".repeat(19), "😀".repeat(12));
        let chunks = text_chunks(&text);
        assert!(chunks.iter().all(|units| !units.is_empty() && units.len() <= MAX_TEXT_UNITS));
        let rebuilt: String = chunks.iter().map(|units| String::from_utf16(units).unwrap()).collect();
        assert_eq!(rebuilt, text);
        assert!(text_chunks("").is_empty());
    }

    // Live: posts real key events to TextEdit. Not run in CI; needs Accessibility and a
    // running TextEdit with a focused document.
    #[test]
    #[ignore]
    fn live_posts_cmd_a_to_textedit() {
        let output = std::process::Command::new("pgrep").arg("-x").arg("TextEdit").output().unwrap();
        let pid: i32 = String::from_utf8_lossy(&output.stdout).trim().parse().unwrap();
        let app = RunningApp {
            name: "TextEdit".into(),
            bundle_id: "com.apple.TextEdit".into(),
            process: cu_core::platform::ProcessRef { pid, start_time: 0 },
        };
        post_text(&app, "hello").unwrap();
        post_key(&app, &cu_core::keys::parse_chord("cmd+a").unwrap()).unwrap();
    }
}
