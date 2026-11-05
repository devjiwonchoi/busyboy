// Portions adapted from cua (https://github.com/trycua/cua, MIT) at d685580. Copyright (c) 2025 Cua AI, Inc.

//! Screen lock state and lock/unlock change notifications.
//!
//! Read-only: nothing here wakes the display, unlocks, or holds power assertions.

use std::ffi::c_void;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use cu_core::platform::PlatformEvent;
use objc2_core_foundation::{
    CFBoolean, CFDictionary, CFNotificationCenter, CFNotificationName, CFNotificationSuspensionBehavior, CFNumber,
    CFRunLoop, CFRunLoopRunResult, CFString, CFType, kCFRunLoopDefaultMode,
};
use objc2_core_graphics::CGSessionCopyCurrentDictionary;

use crate::{SharedSink, emit};

/// Session-dictionary key that is true while the login session shows the lock screen.
const LOCK_KEY: &str = "CGSSessionScreenIsLocked";
const LOCKED_NOTIFICATION: &str = "com.apple.screenIsLocked";
const UNLOCKED_NOTIFICATION: &str = "com.apple.screenIsUnlocked";
/// Fallback poll interval, in case notifications are not delivered to this thread.
const POLL: Duration = Duration::from_secs(1);

/// Whether the session reports its screen as locked. Read fresh on every call.
/// `false` when the session dictionary is unavailable or the key is absent.
pub fn is_locked() -> bool {
    let Some(dictionary) = CGSessionCopyCurrentDictionary() else {
        return false;
    };
    // SAFETY: the session dictionary has CFString keys and CF values.
    let dictionary: &CFDictionary<CFString, CFType> = unsafe { dictionary.cast_unchecked() };
    let Some(value) = dictionary.get(&CFString::from_str(LOCK_KEY)) else {
        return false;
    };
    if let Some(flag) = value.downcast_ref::<CFBoolean>() {
        return flag.as_bool();
    }
    value.downcast_ref::<CFNumber>().and_then(|number| number.as_i64()).is_some_and(|number| number != 0)
}

/// Last reported state: 0 unknown, 1 unlocked, 2 locked. Used to report changes once.
static LAST: AtomicU8 = AtomicU8::new(0);

fn report(sink: &SharedSink, locked: bool) {
    let state = if locked { 2 } else { 1 };
    if LAST.swap(state, Ordering::SeqCst) != state {
        emit(sink, PlatformEvent::LockChanged { locked });
    }
}

/// Starts watching lock changes and reports `PlatformEvent::LockChanged` to the sink.
/// Runs one long-lived thread with its own run loop for the process lifetime.
pub fn start_lock_watcher(sink: SharedSink) {
    LAST.store(if is_locked() { 2 } else { 1 }, Ordering::SeqCst);
    let spawned = std::thread::Builder::new().name("cu-lock-watcher".into()).spawn(move || watch(sink));
    if let Err(error) = spawned {
        eprintln!("computer-use: lock watcher did not start: {error}");
    }
}

fn watch(sink: SharedSink) {
    // The observer context lives for the rest of the process.
    let context: &'static SharedSink = Box::leak(Box::new(sink));
    if let Some(center) = CFNotificationCenter::distributed_center() {
        for name in [LOCKED_NOTIFICATION, UNLOCKED_NOTIFICATION] {
            let name = CFString::from_str(name);
            // SAFETY: `context` is a 'static SharedSink, the callback matches the CF signature,
            // and the observer is never removed.
            unsafe {
                center.add_observer(
                    (context as *const SharedSink).cast(),
                    Some(on_notification),
                    Some(&name),
                    std::ptr::null(),
                    CFNotificationSuspensionBehavior::DeliverImmediately,
                );
            }
        }
    }
    // SAFETY: reading an immutable CF constant.
    let mode = unsafe { kCFRunLoopDefaultMode };
    loop {
        // Runs the loop for notifications, then polls as a fallback (≤ 1 s latency).
        let result = CFRunLoop::run_in_mode(mode, POLL.as_secs_f64(), false);
        if result == CFRunLoopRunResult::Finished {
            // No sources on this run loop: notifications go elsewhere; just poll.
            std::thread::sleep(POLL);
        }
        report(context, is_locked());
    }
}

unsafe extern "C-unwind" fn on_notification(
    _center: *mut CFNotificationCenter,
    observer: *mut c_void,
    name: *const CFNotificationName,
    _object: *const c_void,
    _info: *const CFDictionary,
) {
    if observer.is_null() || name.is_null() {
        return;
    }
    // SAFETY: `observer` is the leaked SharedSink registered in `watch`.
    let sink = unsafe { &*(observer as *const SharedSink) };
    // SAFETY: CF passes a valid notification name for the duration of the call.
    let name = unsafe { &*name }.to_string();
    match name.as_str() {
        LOCKED_NOTIFICATION => report(sink, true),
        UNLOCKED_NOTIFICATION => report(sink, false),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads the session dictionary without crashing, with or without a window-server session.
    #[test]
    fn lock_probe_does_not_abort() {
        let _ = is_locked();
    }
}
