//! Accessibility, Screen Recording, and input-monitoring status and prompts.
//!
//! `status()` only uses preflight checks, so it never shows a prompt and is cheap
//! enough for the settings UI to poll every 2 s.

use cu_core::CuResult;
use cu_protocol::{GrantStatus, PermissionKind, PermissionsStatus, StopMonitorStatus};
use objc2_application_services::{AXIsProcessTrusted, AXIsProcessTrustedWithOptions, kAXTrustedCheckOptionPrompt};
use objc2_core_foundation::{CFBoolean, CFDictionary, CFString, CFType};
use objc2_core_graphics::{CGPreflightScreenCaptureAccess, CGRequestListenEventAccess, CGRequestScreenCaptureAccess};

use crate::monitor;

fn grant(granted: bool) -> GrantStatus {
    if granted { GrantStatus::Granted } else { GrantStatus::NotGranted }
}

pub fn accessibility_granted() -> bool {
    // SAFETY: plain trust check without options; never prompts.
    unsafe { AXIsProcessTrusted() }
}

pub fn status() -> PermissionsStatus {
    PermissionsStatus {
        accessibility: grant(accessibility_granted()),
        screen_recording: grant(CGPreflightScreenCaptureAccess()),
        stop_monitor: if monitor::available() { StopMonitorStatus::Available } else { StopMonitorStatus::Unavailable },
    }
}

/// Shows the system prompt for one grant. Only reached from the settings UI.
pub fn request(kind: PermissionKind) -> CuResult<()> {
    match kind {
        PermissionKind::Accessibility => {
            // SAFETY: the static key is a valid CFString provided by HIServices.
            let key: &CFString = unsafe { kAXTrustedCheckOptionPrompt };
            let value = CFBoolean::new(true);
            let options = CFDictionary::<CFString, CFType>::from_slices(&[key], &[value.as_ref()]);
            // SAFETY: a dictionary with the documented prompt key and a CFBoolean value.
            let _ = unsafe { AXIsProcessTrustedWithOptions(Some(options.as_opaque())) };
        }
        PermissionKind::ScreenRecording => {
            let _ = CGRequestScreenCaptureAccess();
        }
        PermissionKind::InputMonitoring => {
            let _ = CGRequestListenEventAccess();
        }
    }
    Ok(())
}
