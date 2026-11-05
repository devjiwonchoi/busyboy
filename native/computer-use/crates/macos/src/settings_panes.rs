//! Localized names of the System Settings panes where actions are refused. Read once
//! from the pane extension bundles, in every language they ship, so the check works
//! whatever language System Settings runs in.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use cu_core::forbidden::{SECURITY_PANE_EXTENSION_IDS, normalize_title};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_foundation::{NSDictionary, NSMutableDictionary, NSString};

const EXTENSIONS_DIR: &str = "/System/Library/ExtensionKit/Extensions";

/// Info keys that hold a pane's visible name.
const NAME_KEYS: &[&str] = &["CFBundleDisplayName", "CFBundleName"];

type Dict = NSDictionary<AnyObject, AnyObject>;

/// Cached names, lowercased. Empty when the scan finds nothing; the core then uses
/// its English names.
pub fn security_pane_names() -> &'static [String] {
    static NAMES: OnceLock<Vec<String>> = OnceLock::new();
    NAMES.get_or_init(|| scan(Path::new(EXTENSIONS_DIR)))
}

fn scan(dir: &Path) -> Vec<String> {
    let mut names = BTreeSet::new();
    for bundle in extension_bundles(dir) {
        collect_names(&bundle, &mut names);
    }
    names.into_iter().collect()
}

/// `.appex` bundles in `dir`, plus those an `.appexlist` points to elsewhere.
fn extension_bundles(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut bundles = Vec::new();
    for path in entries.flatten().map(|entry| entry.path()) {
        match path.extension().and_then(|ext| ext.to_str()) {
            Some("appex") => bundles.push(path),
            Some("appexlist") => {
                let listed = load_dict(&path)
                    .and_then(|list| dict_value(&list, "AppExtensions"))
                    .and_then(|value| value.downcast::<Dict>().ok());
                if let Some(listed) = listed {
                    bundles.extend(listed.allKeys().iter().filter_map(as_string).map(PathBuf::from));
                }
            }
            _ => {}
        }
    }
    bundles
}

fn collect_names(bundle: &Path, names: &mut BTreeSet<String>) {
    let contents = bundle.join("Contents");
    let Some(info) = load_dict(&contents.join("Info.plist")) else { return };
    let Some(id) = dict_string(&info, "CFBundleIdentifier") else { return };
    if !SECURITY_PANE_EXTENSION_IDS.iter().any(|risky| risky.eq_ignore_ascii_case(&id)) {
        return;
    }

    // Some panes have a longer alternate title, e.g. "AutoFill & Passwords".
    let alt_name = dict_value(&info, "EXAppExtensionAttributes")
        .and_then(|value| value.downcast::<Dict>().ok())
        .and_then(|attributes| dict_value(&attributes, "SettingsExtensionAttributes"))
        .and_then(|value| value.downcast::<Dict>().ok())
        .and_then(|settings| dict_string(&settings, "alt_name"));
    let mut keys: Vec<&str> = NAME_KEYS.to_vec();
    if let Some(alt_name) = &alt_name {
        keys.push(alt_name);
        names.insert(normalize_title(alt_name));
    }

    let mut add = |dict: &Dict| {
        for key in &keys {
            if let Some(name) = dict_string(dict, key).map(|name| normalize_title(&name))
                && !name.is_empty()
            {
                names.insert(name);
            }
        }
    };
    add(&info);

    let resources = contents.join("Resources");
    // Newer bundles keep every language in one table.
    if let Some(table) = load_dict(&resources.join("InfoPlist.loctable")) {
        for language in table.allValues().iter() {
            if let Ok(strings) = language.downcast::<Dict>() {
                add(&strings);
            }
        }
    }
    // Older ones keep one strings file per language.
    if let Ok(entries) = std::fs::read_dir(&resources) {
        for path in entries.flatten().map(|entry| entry.path()) {
            if path.extension().and_then(|ext| ext.to_str()) == Some("lproj")
                && let Some(strings) = load_dict(&path.join("InfoPlist.strings"))
            {
                add(&strings);
            }
        }
    }
}

/// Reads a property list or strings file whose root is a dictionary.
fn load_dict(path: &Path) -> Option<Retained<Dict>> {
    if !path.is_file() {
        return None;
    }
    let path = NSString::from_str(path.to_str()?);
    // SAFETY: keys and values are typed as `AnyObject` and checked before use.
    let dict: Retained<NSMutableDictionary<AnyObject, AnyObject>> =
        unsafe { NSMutableDictionary::dictionaryWithContentsOfFile(&path) }?;
    Some(Retained::into_super(dict))
}

fn dict_value(dict: &Dict, key: &str) -> Option<Retained<AnyObject>> {
    dict.objectForKey(&NSString::from_str(key))
}

fn dict_string(dict: &Dict, key: &str) -> Option<String> {
    as_string(dict_value(dict, key)?)
}

fn as_string(value: Retained<AnyObject>) -> Option<String> {
    value.downcast::<NSString>().ok().map(|string| string.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_localized_pane_names_from_this_mac() {
        let names = security_pane_names();
        for expected in ["sharing", "공유", "共有", "개인정보 보호 및 보안", "プライバシーとセキュリティ", "privacy & security"] {
            assert!(names.iter().any(|name| name == expected), "{expected} missing from {} names", names.len());
        }
        // Passwords lives in a cryptex, reached through an .appexlist.
        assert!(names.iter().any(|name| name == "암호"), "Korean Passwords pane name missing");
        // Panes off the list stay out.
        assert!(!names.iter().any(|name| name == "displays"));
    }

    #[test]
    fn localized_names_refuse_settings_windows() {
        use cu_core::forbidden::is_security_pane;
        let names = security_pane_names();
        assert!(is_security_pane("com.apple.systempreferences", "공유", names));
        assert!(is_security_pane("com.apple.systempreferences", "사용자 및 그룹", names));
        assert!(!is_security_pane("com.apple.systempreferences", "디스플레이", names));
        assert!(!is_security_pane("com.apple.TextEdit", "공유", names));
    }
}
