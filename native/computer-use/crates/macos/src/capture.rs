//! Optional single-window capture through ScreenCaptureKit.
//!
//! Captures one window even when it is covered (so BusyBoy's own overlay never shows),
//! scaled to point resolution with the long edge at most 1,600 px. Never prompts: when
//! Screen Recording is not granted the screenshot is omitted with a reason.

use std::ptr::NonNull;
use std::sync::mpsc;

use block2::RcBlock;
use cu_core::Deadline;
use cu_core::platform::RunningApp;
use cu_core::tree::WindowInfo;
use cu_protocol::{Screenshot, ScreenshotOmitted};
use objc2::AnyThread;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImageCompressionFactor};
use objc2_core_foundation::CFRetained;
use objc2_core_graphics::{CGImage, CGPreflightScreenCaptureAccess};
use objc2_foundation::{NSDictionary, NSError, NSNumber};
use objc2_screen_capture_kit::{
    SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCWindow,
};

/// Longest image edge in pixels.
pub const MAX_EDGE: f64 = 1_280.0;

/// Parses `w<cg_window_id>` window ids.
pub(crate) fn parse_window_id(id: &str) -> Option<u32> {
    id.strip_prefix('w')?.parse().ok()
}

/// Output size in pixels: point size, scaled down so the long edge fits.
pub(crate) fn output_size(width: f64, height: f64) -> (usize, usize) {
    let long = width.max(height).max(1.0);
    let scale = (MAX_EDGE / long).min(1.0);
    (((width * scale).round() as usize).max(1), ((height * scale).round() as usize).max(1))
}

pub(crate) fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(TABLE[(triple >> (18 - index * 6) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Moves an Objective-C object across the completion-handler thread boundary.
struct SendBox<T>(T);
// SAFETY: the boxed objects are immutable results handed from one thread to another once.
unsafe impl<T> Send for SendBox<T> {}

fn shareable_window(app: &RunningApp, window_id: u32, deadline: Deadline) -> Option<Retained<SCWindow>> {
    let (sender, receiver) = mpsc::channel::<SendBox<Option<Retained<SCShareableContent>>>>();
    let handler = RcBlock::new(move |content: *mut SCShareableContent, _error: *mut NSError| {
        // SAFETY: a non-null content pointer is a valid object for the duration of the handler.
        let content = unsafe { Retained::retain(content) };
        let _ = sender.send(SendBox(content));
    });
    // SAFETY: valid block; ScreenCaptureKit calls it once on its own queue.
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            true, false, &handler,
        );
    }
    let content = receiver.recv_timeout(deadline.remaining()).ok()?.0?;
    // SAFETY: reading immutable properties of the returned content.
    unsafe {
        content.windows().iter().find(|window| {
            window.windowID() == window_id
                && window.owningApplication().is_some_and(|owner| owner.processID() == app.process.pid)
        })
    }
}

fn encode(image: &CGImage) -> Option<(String, Vec<u8>)> {
    let representation = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), image);
    let quality = NSNumber::new_f64(0.8);
    // SAFETY: the key is a valid static string; the dictionary holds one NSNumber.
    let jpeg_properties = unsafe {
        NSDictionary::<objc2_foundation::NSString, AnyObject>::from_slices(&[NSImageCompressionFactor], &[quality.as_ref()])
    };
    let empty = NSDictionary::<objc2_foundation::NSString, AnyObject>::new();
    // SAFETY: valid bitmap representation and property dictionaries.
    let jpeg = unsafe { representation.representationUsingType_properties(NSBitmapImageFileType::JPEG, &jpeg_properties) };
    // SAFETY: as above.
    let png = unsafe { representation.representationUsingType_properties(NSBitmapImageFileType::PNG, &empty) };
    let candidates = [("image/jpeg", jpeg), ("image/png", png)];
    candidates
        .into_iter()
        .filter_map(|(mime, data)| data.map(|data| (mime.to_owned(), data.to_vec())))
        .min_by_key(|(_, bytes)| bytes.len())
}

pub fn capture_window(app: &RunningApp, window: &WindowInfo, deadline: Deadline) -> Result<Screenshot, ScreenshotOmitted> {
    if !CGPreflightScreenCaptureAccess() {
        return Err(ScreenshotOmitted::ScreenRecordingNotGranted);
    }
    if window.minimized {
        return Err(ScreenshotOmitted::WindowMinimized);
    }
    let window_id = parse_window_id(&window.id).ok_or(ScreenshotOmitted::CaptureFailed)?;
    let shareable = shareable_window(app, window_id, deadline).ok_or(ScreenshotOmitted::CaptureFailed)?;

    // SAFETY: valid SCWindow; the filter and configuration are plain value objects.
    let (filter, configuration) = unsafe {
        let filter = SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &shareable);
        let configuration = SCStreamConfiguration::new();
        let (width, height) = output_size(window.bounds.width, window.bounds.height);
        configuration.setWidth(width);
        configuration.setHeight(height);
        configuration.setScalesToFit(true);
        configuration.setShowsCursor(false);
        configuration.setIgnoreShadowsSingleWindow(true);
        (filter, configuration)
    };

    let (sender, receiver) = mpsc::channel::<SendBox<Option<CFRetained<CGImage>>>>();
    let handler = RcBlock::new(move |image: *mut CGImage, _error: *mut NSError| {
        // SAFETY: a non-null image is valid for the handler's duration; retaining keeps it alive.
        let image = NonNull::new(image).map(|image| unsafe { CFRetained::retain(image) });
        let _ = sender.send(SendBox(image));
    });
    // SAFETY: valid filter, configuration, and block.
    unsafe {
        SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(&filter, &configuration, Some(&handler));
    }
    let image = receiver
        .recv_timeout(deadline.remaining())
        .ok()
        .and_then(|boxed| boxed.0)
        .ok_or(ScreenshotOmitted::CaptureFailed)?;
    let image: &CGImage = &image;

    let pixel_width = CGImage::width(Some(image)) as u32;
    let pixel_height = CGImage::height(Some(image)) as u32;
    let (mime_type, bytes) = encode(image).ok_or(ScreenshotOmitted::CaptureFailed)?;
    Ok(Screenshot { mime_type, data: base64(&bytes), width: pixel_width, height: pixel_height })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_window_ids() {
        assert_eq!(parse_window_id("w1234"), Some(1234));
        assert_eq!(parse_window_id("a99"), None);
        assert_eq!(parse_window_id("w"), None);
    }

    #[test]
    fn scales_the_long_edge_to_1280() {
        assert_eq!(output_size(3200.0, 1600.0), (1280, 640));
        assert_eq!(output_size(800.0, 600.0), (800, 600));
        assert_eq!(output_size(1000.0, 4000.0), (320, 1280));
    }

    #[test]
    fn encodes_base64() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
