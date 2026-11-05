//! Apps and windows computer use refuses. The server and the helper share this list.

use cu_protocol::ForbiddenReason;

/// One match rule.
enum Rule {
    Exact(&'static str),
    Prefix(&'static str),
}

use Rule::{Exact, Prefix};

const RULES: &[(ForbiddenReason, &[Rule])] = &[
    (
        ForbiddenReason::PasswordManager,
        &[
            Exact("com.apple.keychainaccess"),
            Exact("com.apple.Passwords"),
            Exact("com.1password.1password"),
            Exact("com.agilebits.onepassword7"),
            Prefix("com.agilebits.onepassword"),
            Exact("com.bitwarden.desktop"),
            Exact("com.lastpass.LastPass"),
            Prefix("com.dashlane."),
            Prefix("com.nordpass."),
            Exact("me.proton.pass.electron"),
            Exact("com.keepassxc.keepassxc"),
            Exact("org.keepassxc.keepassxc"),
            Exact("com.enpass.Enpass"),
            Exact("com.roboform.app"),
            Exact("com.sinew.Enpass-Desktop"),
        ],
    ),
    (
        ForbiddenReason::Terminal,
        &[
            Exact("com.apple.Terminal"),
            Exact("com.googlecode.iterm2"),
            Prefix("dev.warp.Warp"),
            Exact("net.kovidgoyal.kitty"),
            Exact("com.github.wez.wezterm"),
            Exact("com.mitchellh.ghostty"),
            Exact("org.alacritty"),
            Exact("io.alacritty"),
            Exact("co.zeit.hyper"),
            Exact("com.raphaelamorim.rio"),
            Exact("dev.commandline.waveterm"),
            Exact("com.panic.Prompt3"),
            Exact("org.tabby"),
        ],
    ),
    (ForbiddenReason::Busyboy, &[Exact("dev.jiwon.busyboy"), Prefix("dev.jiwon.busyboy.")]),
    (
        ForbiddenReason::SystemSecurity,
        &[
            Exact("com.apple.SecurityAgent"),
            Exact("com.apple.loginwindow"),
            Exact("com.apple.LocalAuthentication.UIAgent"),
            Exact("com.apple.coreservices.uiagent"),
            Exact("com.apple.UserNotificationCenter"),
            Exact("com.apple.ScreenTimeAgent"),
            Exact("com.apple.screensaver"),
            Exact("com.apple.ScreenSaver.Engine"),
        ],
    ),
];

/// Returns why an app is forbidden, if it is. `None` bundle IDs are unidentified apps.
pub fn forbidden_reason(bundle_id: Option<&str>) -> Option<ForbiddenReason> {
    let Some(bundle_id) = bundle_id.filter(|id| !id.is_empty()) else {
        return Some(ForbiddenReason::UnidentifiedApp);
    };
    // Bundle IDs are case-insensitive on macOS.
    let bundle_id = bundle_id.to_lowercase();

    RULES.iter().find_map(|(reason, rules)| {
        let matched = rules.iter().any(|rule| match rule {
            Exact(id) => id.to_lowercase() == bundle_id,
            Prefix(prefix) => bundle_id.starts_with(&prefix.to_lowercase()),
        });
        matched.then_some(*reason)
    })
}

/// System Settings bundle IDs. Reads are allowed; actions are refused on security panes,
/// and "Always allow" is never offered.
pub const SYSTEM_SETTINGS_BUNDLE_IDS: &[&str] = &["com.apple.systempreferences", "com.apple.Settings"];

/// Window titles (lowercased, English) of System Settings panes where actions are refused.
const SECURITY_PANE_TITLES: &[&str] = &[
    "privacy & security",
    "security & privacy",
    "passwords",
    "users & groups",
    "touch id & password",
    "login password",
];

/// True when an action in this System Settings window must be refused.
pub fn is_security_pane(bundle_id: &str, window_title: &str) -> bool {
    if !SYSTEM_SETTINGS_BUNDLE_IDS.contains(&bundle_id) {
        return false;
    }
    let title = window_title.trim().to_lowercase();
    SECURITY_PANE_TITLES.iter().any(|pane| title == *pane || title.starts_with(&format!("{pane} ")))
}

/// Browser bundle IDs whose windows get the private-window check.
const BROWSER_PREFIXES: &[&str] = &[
    "com.google.Chrome",
    "com.microsoft.edgemac",
    "com.brave.Browser",
    "company.thebrowser.Browser",
    "org.mozilla.firefox",
    "org.mozilla.nightly",
    "com.apple.Safari",
    "com.operasoftware.Opera",
    "com.vivaldi.Vivaldi",
    "org.chromium.Chromium",
    "app.zen-browser.zen",
    "com.kagi.kagimacOS",
];

/// True for browsers, whose windows may be private.
pub fn is_browser(bundle_id: &str) -> bool {
    BROWSER_PREFIXES.iter().any(|prefix| bundle_id == *prefix || bundle_id.starts_with(&format!("{prefix}.")))
}

/// Title markers browsers use for private windows. Matched case-insensitively as a
/// whole word anywhere in the title. Our own list, extended per locale as needed.
const PRIVATE_WINDOW_MARKERS: &[&str] = &[
    "private browsing",
    "private",
    "incognito",
    "inprivate",
    "privat",
    "privé",
    "privado",
    "privato",
    "inkognito",
    "incógnito",
    "プライベート",
    "シークレット",
    "시크릿",
    "개인 정보 보호",
    "无痕",
    "隐私浏览",
];

/// Heuristic: does this window title look like a private or incognito browser window?
pub fn title_marks_private_window(title: &str) -> bool {
    let lowered = title.to_lowercase();
    PRIVATE_WINDOW_MARKERS.iter().any(|marker| contains_word(&lowered, marker))
}

fn contains_word(haystack: &str, needle: &str) -> bool {
    haystack.match_indices(needle).any(|(start, matched)| {
        let before = haystack[..start].chars().next_back();
        let after = haystack[start + matched.len()..].chars().next();
        let is_boundary = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric());
        is_boundary(before) && is_boundary(after)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_exact_and_prefix_rules() {
        assert_eq!(forbidden_reason(Some("com.apple.Terminal")), Some(ForbiddenReason::Terminal));
        assert_eq!(forbidden_reason(Some("dev.warp.Warp-Stable")), Some(ForbiddenReason::Terminal));
        assert_eq!(forbidden_reason(Some("com.dashlane.dashlanephonefinal")), Some(ForbiddenReason::PasswordManager));
        assert_eq!(forbidden_reason(Some("dev.jiwon.busyboy")), Some(ForbiddenReason::Busyboy));
        assert_eq!(forbidden_reason(Some("dev.jiwon.busyboy.computer-use")), Some(ForbiddenReason::Busyboy));
        assert_eq!(forbidden_reason(Some("com.apple.loginwindow")), Some(ForbiddenReason::SystemSecurity));
        assert_eq!(forbidden_reason(None), Some(ForbiddenReason::UnidentifiedApp));
        assert_eq!(forbidden_reason(Some("")), Some(ForbiddenReason::UnidentifiedApp));
        assert_eq!(forbidden_reason(Some("COM.APPLE.terminal")), Some(ForbiddenReason::Terminal));
    }

    #[test]
    fn leaves_ordinary_and_lookalike_apps_alone() {
        assert_eq!(forbidden_reason(Some("com.apple.TextEdit")), None);
        assert_eq!(forbidden_reason(Some("dev.jiwon.busyboyish")), None);
        assert_eq!(forbidden_reason(Some("com.apple.Terminal2")), None);
        assert_eq!(forbidden_reason(Some("com.google.Chrome")), None);
    }

    #[test]
    fn detects_security_panes_only_in_system_settings() {
        assert!(is_security_pane("com.apple.systempreferences", "Privacy & Security"));
        assert!(is_security_pane("com.apple.Settings", "Users & Groups"));
        assert!(!is_security_pane("com.apple.systempreferences", "Displays"));
        assert!(!is_security_pane("com.apple.TextEdit", "Passwords"));
    }

    #[test]
    fn recognizes_browsers() {
        assert!(is_browser("com.google.Chrome"));
        assert!(is_browser("com.google.Chrome.canary"));
        assert!(is_browser("com.apple.Safari"));
        assert!(!is_browser("com.apple.TextEdit"));
        assert!(!is_browser("com.google.Chromecast"));
    }

    #[test]
    fn detects_private_window_titles_by_word() {
        assert!(title_marks_private_window("New Tab - Google Chrome (Incognito)"));
        assert!(title_marks_private_window("Start Page — Private Browsing"));
        assert!(title_marks_private_window("Bing - InPrivate - Microsoft Edge"));
        assert!(!title_marks_private_window("Privacy policy - Example"));
        assert!(!title_marks_private_window("Untitled"));
    }
}
