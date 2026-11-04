//! Running and installed apps, resolution, process start times, background launch.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use block2::RcBlock;
use cu_core::platform::{AppTarget, LaunchOutcome, ProcessRef, RunningApp};
use cu_core::{CuResult, Deadline};
use cu_protocol::{AppEntry, ErrorCode, ErrorObject};
use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSApplicationActivationPolicy, NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
use objc2_foundation::{NSBundle, NSError, NSString};

use crate::ax::{AxElement, AxFailure};

/// Most entries `list_apps` returns.
const MAX_APPS: usize = 300;
/// Most candidates reported with `app_not_found`.
const MAX_CANDIDATES: usize = 5;
/// How long a scan of the application folders is reused.
const INSTALLED_TTL: Duration = Duration::from_secs(30);
/// Poll interval while waiting for a launched app's first window.
const WINDOW_POLL: Duration = Duration::from_millis(50);

/// One app known by name, running or installed.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Candidate {
    name: String,
    bundle_id: Option<String>,
    pid: Option<i32>,
    regular: bool,
    /// Other names the app answers to (e.g. the bundle file name).
    aliases: Vec<String>,
}

impl Candidate {
    fn names(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.name.as_str()).chain(self.aliases.iter().map(String::as_str))
    }

    fn entry(&self) -> AppEntry {
        AppEntry {
            name: self.name.clone(),
            bundle_id: self.bundle_id.clone(),
            running: self.pid.is_some(),
            pid: self.pid,
            regular: self.regular,
            forbidden: None,
        }
    }
}

// -- listing --------------------------------------------------------------------

pub fn list_apps(include_installed: bool) -> CuResult<Vec<AppEntry>> {
    let running = running_apps();
    let installed = if include_installed { installed_apps() } else { Vec::new() };
    Ok(merge(running, installed, MAX_APPS).iter().map(Candidate::entry).collect())
}

/// Running GUI apps: regular apps first, then accessory apps, each sorted by name.
fn running_apps() -> Vec<Candidate> {
    let own_pid = std::process::id() as i32;
    autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let mut apps: Vec<Candidate> = workspace
            .runningApplications()
            .iter()
            .filter_map(|app| {
                let policy = app.activationPolicy();
                let regular = policy == NSApplicationActivationPolicy::Regular;
                if !regular && policy != NSApplicationActivationPolicy::Accessory {
                    return None;
                }
                let pid = app.processIdentifier();
                if pid == own_pid || app.isTerminated() {
                    return None;
                }
                let bundle_id = app.bundleIdentifier().map(|id| id.to_string());
                let name = app.localizedName().map(|name| name.to_string()).or_else(|| bundle_id.clone())?;
                let aliases = app
                    .bundleURL()
                    .and_then(|url| url.path())
                    .and_then(|path| bundle_stem(Path::new(&path.to_string())))
                    .filter(|stem| stem != &name)
                    .into_iter()
                    .collect();
                Some(Candidate { name, bundle_id, pid: Some(pid), regular, aliases })
            })
            .collect();
        apps.sort_by(|a, b| b.regular.cmp(&a.regular).then_with(|| sort_key(&a.name).cmp(&sort_key(&b.name))));
        apps
    })
}

/// Running apps first, then installed apps not already running, deduplicated by
/// bundle id and capped at `cap` entries.
fn merge(running: Vec<Candidate>, installed: Vec<Candidate>, cap: usize) -> Vec<Candidate> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for app in running.into_iter().chain(installed) {
        if out.len() >= cap {
            break;
        }
        if let Some(id) = &app.bundle_id
            && !seen.insert(id.to_ascii_lowercase())
        {
            continue;
        }
        out.push(app);
    }
    out
}

fn sort_key(name: &str) -> String {
    name.to_lowercase()
}

fn bundle_stem(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    Some(name.strip_suffix(".app").unwrap_or(name).to_owned())
}

// -- installed apps ---------------------------------------------------------------

static INSTALLED: Mutex<Option<(Instant, Vec<Candidate>)>> = Mutex::new(None);

/// Installed apps from the standard folders, sorted by name, deduplicated by bundle id.
/// Cached for a short time because resolution and listing both use it.
fn installed_apps() -> Vec<Candidate> {
    let mut cache = INSTALLED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((at, apps)) = cache.as_ref()
        && at.elapsed() < INSTALLED_TTL
    {
        return apps.clone();
    }
    let apps = scan_installed();
    *cache = Some((Instant::now(), apps.clone()));
    apps
}

fn app_folders() -> Vec<PathBuf> {
    let mut folders = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/Applications/Utilities"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        folders.push(Path::new(&home).join("Applications"));
    }
    folders
}

fn scan_installed() -> Vec<Candidate> {
    let mut paths = Vec::new();
    for folder in app_folders() {
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "app") {
                paths.push(path);
            }
        }
    }
    let apps = paths.iter().filter_map(|path| read_bundle(path)).collect();
    dedupe_installed(apps)
}

/// Sorts by name and keeps the first app per bundle id.
fn dedupe_installed(mut apps: Vec<Candidate>) -> Vec<Candidate> {
    apps.sort_by_key(|app| sort_key(&app.name));
    merge(Vec::new(), apps, usize::MAX)
}

/// Bundle id and display name of one `.app`. Bundles without an id are skipped,
/// since they cannot be launched by id.
fn read_bundle(path: &Path) -> Option<Candidate> {
    let stem = bundle_stem(path)?;
    autoreleasepool(|_| {
        let bundle = NSBundle::bundleWithPath(&NSString::from_str(path.to_str()?))?;
        let bundle_id = bundle.bundleIdentifier()?.to_string();
        let name = info_string(&bundle, "CFBundleDisplayName")
            .or_else(|| info_string(&bundle, "CFBundleName"))
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| stem.clone());
        let aliases = if stem != name { vec![stem] } else { Vec::new() };
        Some(Candidate { name, bundle_id: Some(bundle_id), pid: None, regular: true, aliases })
    })
}

fn info_string(bundle: &NSBundle, key: &str) -> Option<String> {
    let value = bundle.objectForInfoDictionaryKey(&NSString::from_str(key))?;
    value.downcast_ref::<NSString>().map(|value| value.to_string())
}

// -- resolution ---------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
enum Match {
    One(Candidate),
    Ambiguous(Vec<Candidate>),
    None,
}

pub fn resolve_app(query: &str) -> CuResult<AppTarget> {
    let query = query.trim();
    if query.is_empty() {
        return Err(ErrorObject::new(ErrorCode::AppNotFound, "no app name or bundle id was given"));
    }
    let running = running_apps();

    // 1. Exact bundle id, running first.
    if let Some(app) = running.iter().find(|app| bundle_matches(app, query)) {
        return Ok(target(app));
    }
    if let Some(app) = installed_by_bundle_id(query) {
        return Ok(target(&app));
    }

    // 2. Exact display name, running then installed.
    let installed = installed_apps();
    for pool in [&running, &installed] {
        match match_name(query, pool) {
            Match::One(app) => return Ok(target(&app)),
            Match::Ambiguous(apps) => {
                return Err(not_found(format!("\"{query}\" matches more than one app; use a bundle id"), &apps));
            }
            Match::None => {}
        }
    }

    // 3. Nothing exact: suggest close names.
    let all = merge(running, installed, usize::MAX);
    Err(not_found(format!("no app named \"{query}\" was found"), &close_candidates(query, &all)))
}

fn bundle_matches(app: &Candidate, query: &str) -> bool {
    app.bundle_id.as_deref().is_some_and(|id| id.eq_ignore_ascii_case(query))
}

fn target(app: &Candidate) -> AppTarget {
    let process = app.pid.and_then(|pid| process_start_time(pid).map(|start_time| ProcessRef { pid, start_time }));
    AppTarget { name: app.name.clone(), bundle_id: app.bundle_id.clone(), process }
}

fn not_found(message: String, candidates: &[Candidate]) -> ErrorObject {
    let candidates: Vec<_> = candidates
        .iter()
        .take(MAX_CANDIDATES)
        .map(|app| serde_json::json!({ "name": app.name, "bundleId": app.bundle_id }))
        .collect();
    ErrorObject::new(ErrorCode::AppNotFound, message).with_details(serde_json::json!({ "candidates": candidates }))
}

/// Case-insensitive exact name match. Several matches with one bundle id count as
/// one app (e.g. two instances); different bundle ids are ambiguous.
fn match_name(query: &str, pool: &[Candidate]) -> Match {
    let wanted = normalize(query);
    let mut hits: Vec<&Candidate> = Vec::new();
    for app in pool {
        if !app.names().any(|name| normalize(name) == wanted) {
            continue;
        }
        let duplicate = hits.iter().any(|hit| hit.bundle_id.is_some() && hit.bundle_id == app.bundle_id);
        if !duplicate {
            hits.push(app);
        }
    }
    match hits.len() {
        0 => Match::None,
        1 => Match::One(hits[0].clone()),
        _ => Match::Ambiguous(hits.into_iter().cloned().collect()),
    }
}

/// Up to five apps whose name starts with (ranked first) or contains the query.
fn close_candidates(query: &str, pool: &[Candidate]) -> Vec<Candidate> {
    let wanted = normalize(query);
    let mut ranked: Vec<(u8, usize, &Candidate)> = pool
        .iter()
        .filter_map(|app| {
            let rank = app
                .names()
                .filter_map(|name| {
                    let name = normalize(name);
                    if name.starts_with(&wanted) {
                        Some(0)
                    } else if name.contains(&wanted) {
                        Some(1)
                    } else {
                        None
                    }
                })
                .min()?;
            Some((rank, app.name.len(), app))
        })
        .collect();
    ranked.sort_by(|a, b| {
        a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then_with(|| sort_key(&a.2.name).cmp(&sort_key(&b.2.name)))
    });
    ranked.into_iter().take(MAX_CANDIDATES).map(|(_, _, app)| app.clone()).collect()
}

fn normalize(name: &str) -> String {
    let name = name.trim().to_lowercase();
    name.strip_suffix(".app").map(str::to_owned).unwrap_or(name)
}

fn installed_by_bundle_id(bundle_id: &str) -> Option<Candidate> {
    // Bundle ids contain a dot; skip the LaunchServices lookup for plain names.
    if !bundle_id.contains('.') {
        return None;
    }
    let path = autoreleasepool(|_| {
        let url = NSWorkspace::sharedWorkspace().URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id))?;
        url.path().map(|path| path.to_string())
    })?;
    read_bundle(Path::new(&path))
}

// -- processes ------------------------------------------------------------------------

/// Start time in microseconds since the epoch, or `None` when the process is gone.
pub fn process_start_time(pid: i32) -> Option<u64> {
    if pid <= 0 {
        return None;
    }
    // SAFETY: proc_bsdinfo is plain old data; all-zero is a valid value.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: the buffer is a proc_bsdinfo of exactly `size` bytes.
    let written = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size) };
    if written != size {
        return None;
    }
    Some(info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
}

fn frontmost_pid() -> Option<i32> {
    autoreleasepool(|_| NSWorkspace::sharedWorkspace().frontmostApplication().map(|app| app.processIdentifier()))
}

// -- launch ---------------------------------------------------------------------------

fn launch_failed(reason: &str, message: impl Into<String>) -> ErrorObject {
    ErrorObject::with_reason(ErrorCode::AppLaunchFailed, reason, message)
}

/// Opens the app without activating it, then waits for its first window.
pub fn launch_app(bundle_id: &str, deadline: Deadline) -> CuResult<LaunchOutcome> {
    let front_before = frontmost_pid();
    let (sender, receiver) = mpsc::channel::<Result<i32, String>>();

    autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        let Some(url) = workspace.URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id)) else {
            return Err(launch_failed("not_installed", format!("no installed app has the bundle id {bundle_id}")));
        };
        let configuration = NSWorkspaceOpenConfiguration::configuration();
        configuration.setActivates(false);
        configuration.setAddsToRecentItems(false);
        let handler = RcBlock::new(move |app: *mut NSRunningApplication, error: *mut NSError| {
            // SAFETY: AppKit passes either null or a valid object for the duration of the call.
            let (app, error) = unsafe { (app.as_ref(), error.as_ref()) };
            let result = match (app, error) {
                (Some(app), _) => Ok(app.processIdentifier()),
                (None, Some(error)) => Err(error.localizedDescription().to_string()),
                (None, None) => Err("the app did not start".to_owned()),
            };
            let _ = sender.send(result);
        });
        workspace.openApplicationAtURL_configuration_completionHandler(&url, &configuration, Some(&handler));
        Ok(())
    })?;

    let pid = match receiver.recv_timeout(deadline.remaining()) {
        Ok(Ok(pid)) => pid,
        Ok(Err(message)) => return Err(launch_failed("open_failed", message)),
        Err(_) => return Err(launch_failed("timeout", format!("{bundle_id} did not finish launching in time"))),
    };
    let start_time =
        process_start_time(pid).ok_or_else(|| launch_failed("exited", format!("{bundle_id} exited during launch")))?;

    wait_for_window(pid, deadline)?;

    let name = autoreleasepool(|_| {
        NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
            .and_then(|app| app.localizedName())
            .map(|name| name.to_string())
    })
    .unwrap_or_else(|| bundle_id.to_owned());
    let focus_changed = front_before != Some(pid) && frontmost_pid() == Some(pid);
    Ok(LaunchOutcome {
        app: RunningApp { name, bundle_id: bundle_id.to_owned(), process: ProcessRef { pid, start_time } },
        focus_changed,
    })
}

/// Polls `AXWindows` until the app has at least one window or the deadline passes.
fn wait_for_window(pid: i32, deadline: Deadline) -> CuResult<()> {
    let app = AxElement::application(pid);
    loop {
        if deadline.expired() {
            return Err(launch_failed("no_window", "the app opened no window in time"));
        }
        match app.elements("AXWindows", deadline) {
            Ok(windows) if !windows.is_empty() => return Ok(()),
            Err(AxFailure::ApiDisabled) => return Err(AxFailure::ApiDisabled.to_error("launch")),
            _ => {}
        }
        if process_start_time(pid).is_none() {
            return Err(launch_failed("exited", "the app exited during launch"));
        }
        std::thread::sleep(WINDOW_POLL.min(deadline.remaining()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str, bundle_id: Option<&str>, pid: Option<i32>) -> Candidate {
        Candidate { name: name.to_owned(), bundle_id: bundle_id.map(str::to_owned), pid, regular: true, aliases: vec![] }
    }

    #[test]
    fn merge_dedupes_by_bundle_id_and_caps() {
        let running = vec![app("Safari", Some("com.apple.Safari"), Some(10))];
        let installed = vec![
            app("Safari", Some("com.apple.safari"), None),
            app("Notes", Some("com.apple.Notes"), None),
            app("Maps", Some("com.apple.Maps"), None),
        ];
        let merged = merge(running, installed, 2);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].pid, Some(10));
        assert_eq!(merged[1].name, "Notes");
    }

    #[test]
    fn dedupe_installed_sorts_and_keeps_first_per_bundle_id() {
        let apps = vec![
            app("zeta", Some("a.z"), None),
            app("Alpha", Some("a.a"), None),
            app("Alpha copy", Some("a.a"), None),
            app("NoId", None, None),
        ];
        let names: Vec<_> = dedupe_installed(apps).into_iter().map(|app| app.name).collect();
        assert_eq!(names, ["Alpha", "NoId", "zeta"]);
    }

    #[test]
    fn exact_name_match_is_case_insensitive_and_detects_ambiguity() {
        let pool = vec![
            app("TextEdit", Some("com.apple.TextEdit"), Some(1)),
            app("Mail", Some("com.apple.mail"), Some(2)),
            app("Mail", Some("com.other.mail"), Some(3)),
        ];
        assert!(matches!(match_name("textedit", &pool), Match::One(found) if found.pid == Some(1)));
        assert!(matches!(match_name("TextEdit.app", &pool), Match::One(_)));
        assert!(matches!(match_name("mail", &pool), Match::Ambiguous(found) if found.len() == 2));
        assert_eq!(match_name("Notes", &pool), Match::None);
    }

    #[test]
    fn same_bundle_twice_is_not_ambiguous() {
        let pool =
            vec![app("Preview", Some("com.apple.Preview"), Some(1)), app("Preview", Some("com.apple.Preview"), Some(2))];
        assert!(matches!(match_name("preview", &pool), Match::One(found) if found.pid == Some(1)));
    }

    #[test]
    fn aliases_match_bundle_file_names() {
        let mut code = app("Code", Some("com.microsoft.VSCode"), None);
        code.aliases.push("Visual Studio Code".to_owned());
        assert!(matches!(match_name("visual studio code", &[code]), Match::One(_)));
    }

    #[test]
    fn close_candidates_rank_prefix_before_contains_and_cap_at_five() {
        let pool = vec![
            app("Photo Booth", Some("a.1"), None),
            app("Photos", Some("a.2"), None),
            app("Adobe Photoshop", Some("a.3"), None),
            app("Calculator", Some("a.4"), None),
        ];
        let names: Vec<_> = close_candidates("photo", &pool).into_iter().map(|app| app.name).collect();
        assert_eq!(names, ["Photos", "Photo Booth", "Adobe Photoshop"]);

        let many: Vec<_> = (0..9).map(|index| app(&format!("Note {index}"), None, None)).collect();
        assert_eq!(close_candidates("note", &many).len(), MAX_CANDIDATES);
    }

    #[test]
    fn not_found_lists_candidates_with_bundle_ids() {
        let error = not_found("nope".to_owned(), &[app("Photos", Some("com.apple.Photos"), None)]);
        assert_eq!(error.code, ErrorCode::AppNotFound);
        let details = error.details.unwrap();
        assert_eq!(details["candidates"][0]["name"], "Photos");
        assert_eq!(details["candidates"][0]["bundleId"], "com.apple.Photos");
    }

    #[test]
    fn bundle_stem_strips_app_suffix() {
        assert_eq!(bundle_stem(Path::new("/Applications/Visual Studio Code.app")).as_deref(), Some("Visual Studio Code"));
    }

    #[test]
    fn start_time_of_this_process_is_stable() {
        let pid = std::process::id() as i32;
        let first = process_start_time(pid).expect("own process");
        assert_eq!(process_start_time(pid), Some(first));
        assert_eq!(process_start_time(-1), None);
    }
}
