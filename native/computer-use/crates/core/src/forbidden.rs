//! Apps and windows computer use refuses. The server and the helper share this list.

use std::sync::OnceLock;

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
    (
        ForbiddenReason::Automation,
        &[
            Exact("com.apple.ScriptEditor2"),
            Exact("com.apple.AppleScriptUtility"),
            Exact("com.apple.ScriptMenuApp"),
            Exact("com.apple.ScriptMonitor"),
            Exact("com.apple.Automator"),
            Prefix("com.apple.Automator."),
            Exact("com.apple.AutomatorRunner"),
            Exact("com.apple.AutomatorInstaller"),
            Exact("com.apple.shortcuts"),
            Prefix("com.apple.shortcuts."),
            Exact("com.apple.ShortcutsActions"),
            Prefix("com.latenightsw.ScriptDebugger"),
        ],
    ),
    (ForbiddenReason::FileManager, &[Exact("com.apple.finder")]),
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

/// Bundle IDs of the System Settings pane extensions where actions are refused.
/// Backends read each pane's localized names from these bundles.
pub const SECURITY_PANE_EXTENSION_IDS: &[&str] = &[
    "com.apple.settings.PrivacySecurity.extension",
    "com.apple.Passwords-Settings.extension",
    "com.apple.Sharing-Settings.extension",
    "com.apple.Users-Groups-Settings.extension",
    "com.apple.Touch-ID-Settings.extension",
    "com.apple.LoginItems-Settings.extension",
    "com.apple.Network-Settings.extension",
    "com.apple.NetworkExtensionSettingsUI.NESettingsUIExtension",
    "com.apple.Profiles-Settings.extension",
    "com.apple.Internet-Accounts-Settings.extension",
];

/// English names of those panes. Used when the localized names cannot be read.
const FALLBACK_SECURITY_PANE_NAMES: &[&str] = &[
    "Privacy & Security",
    "Security & Privacy",
    "Passwords",
    "AutoFill & Passwords",
    "Sharing",
    "Users & Groups",
    "Touch ID & Password",
    "Login Password",
    "Login Items",
    "Login Items & Extensions",
    "Network",
    "VPN",
    "Device Management",
    "Profiles",
    "Internet Accounts",
];

/// The built-in English pane names.
pub fn fallback_security_pane_names() -> &'static [String] {
    static NAMES: OnceLock<Vec<String>> = OnceLock::new();
    NAMES.get_or_init(|| FALLBACK_SECURITY_PANE_NAMES.iter().map(|name| normalize_title(name)).collect())
}

/// Lowercased and trimmed, without bidi marks, so names and titles compare as text.
pub fn normalize_title(title: &str) -> String {
    let stripped: String = title
        .chars()
        .filter(|c| !matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
        .collect();
    stripped.trim().to_lowercase()
}

/// True when an action in this System Settings window must be refused. `pane_names`
/// are the risky panes' names in any language.
pub fn is_security_pane(bundle_id: &str, window_title: &str, pane_names: &[String]) -> bool {
    if !SYSTEM_SETTINGS_BUNDLE_IDS.iter().any(|id| id.eq_ignore_ascii_case(bundle_id)) {
        return false;
    }
    let title = normalize_title(window_title);
    if title.is_empty() {
        return false;
    }
    let matches = |name: &str| {
        title == name
            || title.starts_with(&format!("{name} "))
            || [" – ", " - ", " — "].iter().any(|separator| title.ends_with(&format!("{separator}{name}")))
    };
    fallback_security_pane_names().iter().chain(pane_names).any(|name| {
        let name = normalize_title(name);
        !name.is_empty() && matches(&name)
    })
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
    fn forbids_script_and_automation_apps() {
        for id in [
            "com.apple.ScriptEditor2",
            "com.apple.Automator",
            "com.apple.Automator.Automator-Application-Stub",
            "com.apple.AutomatorRunner",
            "com.apple.shortcuts",
            "com.apple.shortcuts.droplet",
            "com.apple.shortcuts.events",
            "com.apple.ScriptMenuApp",
            "com.latenightsw.ScriptDebugger8",
            "COM.APPLE.SCRIPTEDITOR2",
        ] {
            assert_eq!(forbidden_reason(Some(id)), Some(ForbiddenReason::Automation), "{id}");
        }
        assert_eq!(forbidden_reason(Some("com.apple.finder")), Some(ForbiddenReason::FileManager));
        assert_eq!(forbidden_reason(Some("com.apple.Finder")), Some(ForbiddenReason::FileManager));
        assert_eq!(ForbiddenReason::Automation.as_str(), "automation");
        assert_eq!(ForbiddenReason::FileManager.as_str(), "file_manager");
    }

    #[test]
    fn leaves_automation_lookalikes_alone() {
        assert_eq!(forbidden_reason(Some("com.apple.shortcutsx")), None);
        assert_eq!(forbidden_reason(Some("com.apple.AutomatorX")), None);
        assert_eq!(forbidden_reason(Some("com.apple.finder.SyncExtension2")), None);
        assert_eq!(forbidden_reason(Some("com.apple.findmy")), None);
        assert_eq!(forbidden_reason(Some("com.example.ScriptEditor2")), None);
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn detects_security_panes_only_in_system_settings() {
        assert!(is_security_pane("com.apple.systempreferences", "Privacy & Security", &[]));
        assert!(is_security_pane("com.apple.Settings", "Users & Groups", &[]));
        assert!(is_security_pane("com.apple.systempreferences", "Sharing", &[]));
        assert!(is_security_pane("com.apple.systempreferences", "  login items  ", &[]));
        assert!(!is_security_pane("com.apple.systempreferences", "Displays", &[]));
        assert!(!is_security_pane("com.apple.systempreferences", "", &[]));
        assert!(!is_security_pane("com.apple.TextEdit", "Passwords", &[]));
    }

    #[test]
    fn detects_localized_security_panes() {
        let panes = names(&["공유", "개인정보 보호 및 보안", "共有", "プライバシーとセキュリティ", "\u{200f}بصمة الإصبع وكلمة السر"]);
        assert!(is_security_pane("com.apple.systempreferences", "공유", &panes));
        assert!(is_security_pane("com.apple.systempreferences", "개인정보 보호 및 보안", &panes));
        assert!(is_security_pane("com.apple.systempreferences", "共有", &panes));
        assert!(is_security_pane("com.apple.systempreferences", "プライバシーとセキュリティ", &panes));
        assert!(is_security_pane("com.apple.systempreferences", "بصمة الإصبع وكلمة السر", &panes));
        // Separators before or after the pane name.
        assert!(is_security_pane("com.apple.systempreferences", "공유 – 화면 공유", &panes));
        assert!(is_security_pane("com.apple.systempreferences", "시스템 설정 - 공유", &panes));
        // English names apply whatever the scan found.
        assert!(is_security_pane("com.apple.systempreferences", "Privacy & Security", &panes));
        // Other panes, and words that only contain a pane name, stay allowed.
        assert!(!is_security_pane("com.apple.systempreferences", "디스플레이", &panes));
        assert!(!is_security_pane("com.apple.systempreferences", "공유된 항목", &panes));
        // Same titles in other apps are not panes.
        assert!(!is_security_pane("com.apple.Notes", "공유", &panes));
        assert!(!is_security_pane("com.apple.finder", "共有", &panes));
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
