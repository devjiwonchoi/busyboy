//! Thin, safe-ish layer over the macOS Accessibility C API (`AXUIElement`).
//!
//! Every call sets the element's messaging timeout from the request deadline first,
//! so one hung app can never block longer than the deadline (capped at 250 ms a call).

use std::ffi::c_void;
use std::ptr::NonNull;

use cu_core::tree::{ElementAction, Rect};
use cu_core::Deadline;
use cu_protocol::{ErrorCode, ErrorObject};
use objc2_application_services::{AXError, AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{
    CFArray, CFBoolean, CFNumber, CFRange, CFRetained, CFString, CFType, CGPoint, CGRect, CGSize, Type,
};

/// Retained accessibility element. AX elements are CF objects that are safe to use
/// from any thread; the API serializes messaging internally.
#[derive(Clone)]
pub struct AxElement(pub CFRetained<AXUIElement>);

// SAFETY: AXUIElementRef is an immutable CF object; AX calls may be made from any thread.
unsafe impl Send for AxElement {}
// SAFETY: as above, shared references only issue AX IPC calls.
unsafe impl Sync for AxElement {}

impl std::fmt::Debug for AxElement {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "AxElement({:p})", CFRetained::as_ptr(&self.0))
    }
}

/// Error from one AX call, kept close to the raw code so callers can decide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AxFailure {
    /// The element no longer exists.
    Invalid,
    /// The app did not answer in time (or is hung).
    Timeout,
    /// The attribute or action is not supported.
    Unsupported,
    /// The attribute exists but has no value.
    NoValue,
    /// Accessibility is not enabled for this process.
    ApiDisabled,
    /// Anything else, with the raw code.
    Other(i32),
}

impl AxFailure {
    pub fn from_code(code: AXError) -> Option<AxFailure> {
        Some(match code {
            AXError::Success => return None,
            AXError::InvalidUIElement | AXError::InvalidUIElementObserver => AxFailure::Invalid,
            AXError::CannotComplete => AxFailure::Timeout,
            AXError::AttributeUnsupported
            | AXError::ActionUnsupported
            | AXError::NotificationUnsupported
            | AXError::ParameterizedAttributeUnsupported
            | AXError::NotImplemented => AxFailure::Unsupported,
            AXError::NoValue => AxFailure::NoValue,
            AXError::APIDisabled => AxFailure::ApiDisabled,
            other => AxFailure::Other(other.0),
        })
    }

    /// Maps to the protocol error for `phase` (e.g. `"press"`).
    pub fn to_error(self, phase: &str) -> ErrorObject {
        match self {
            AxFailure::Invalid => ErrorObject::new(ErrorCode::StaleElement, "the element no longer exists"),
            AxFailure::Timeout => ErrorObject::new(ErrorCode::Timeout, format!("the app did not respond during {phase}"))
                .with_details(serde_json::json!({ "phase": phase })),
            AxFailure::ApiDisabled => {
                ErrorObject::new(ErrorCode::PermissionRequired, "Accessibility is not granted to BusyBoy Computer Use")
                    .with_details(serde_json::json!({ "missing": ["accessibility"] }))
            }
            AxFailure::Unsupported | AxFailure::NoValue => {
                ErrorObject::with_reason(ErrorCode::ActionUnsupported, "ax_unsupported", format!("the app does not support {phase}"))
            }
            AxFailure::Other(code) => ErrorObject::with_reason(
                ErrorCode::ActionUnsupported,
                "ax_error",
                format!("the app rejected {phase} (AX error {code})"),
            ),
        }
    }
}

pub type AxResult<T> = Result<T, AxFailure>;

fn check(code: AXError) -> AxResult<()> {
    match AxFailure::from_code(code) {
        None => Ok(()),
        Some(failure) => Err(failure),
    }
}

pub fn cfstr(text: &str) -> CFRetained<CFString> {
    CFString::from_str(text)
}

impl AxElement {
    pub fn application(pid: i32) -> AxElement {
        // SAFETY: creating an application element for any pid is always valid.
        AxElement(unsafe { AXUIElement::new_application(pid) })
    }

    pub fn system_wide() -> AxElement {
        // SAFETY: always valid.
        AxElement(unsafe { AXUIElement::new_system_wide() })
    }

    /// Applies the deadline to the next call on this element.
    pub fn arm(&self, deadline: Deadline) -> AxResult<()> {
        let seconds = deadline.call_timeout().as_secs_f32();
        if seconds <= 0.0 {
            return Err(AxFailure::Timeout);
        }
        // SAFETY: valid element; the timeout is a plain float.
        let _ = unsafe { self.0.set_messaging_timeout(seconds.max(0.001)) };
        Ok(())
    }

    pub fn pid(&self) -> AxResult<i32> {
        let mut pid: libc::pid_t = 0;
        // SAFETY: valid out pointer.
        check(unsafe { self.0.pid(NonNull::from(&mut pid)) })?;
        Ok(pid)
    }

    /// Reads one attribute. `Ok(None)` when the attribute has no value.
    pub fn attr(&self, name: &str, deadline: Deadline) -> AxResult<Option<CFRetained<CFType>>> {
        self.arm(deadline)?;
        let name = cfstr(name);
        let mut value: *const CFType = std::ptr::null();
        // SAFETY: valid element, attribute string, and out pointer.
        let code = unsafe { self.0.copy_attribute_value(&name, NonNull::from(&mut value)) };
        match AxFailure::from_code(code) {
            None => Ok(NonNull::new(value as *mut CFType).map(|value| unsafe { CFRetained::from_raw(value) })),
            Some(AxFailure::NoValue) => Ok(None),
            Some(failure) => Err(failure),
        }
    }

    /// Reads several attributes in one IPC round trip
    /// (`AXUIElementCopyMultipleAttributeValues`). Missing or failed attributes are `None`.
    /// An invalid element or a timeout fails the whole call.
    pub fn attrs(&self, names: &[&str], deadline: Deadline) -> AxResult<Vec<Option<CFRetained<CFType>>>> {
        self.arm(deadline)?;
        let names: Vec<CFRetained<CFString>> = names.iter().map(|name| cfstr(name)).collect();
        let array = CFArray::from_retained_objects(&names);
        let mut values: *const CFArray = std::ptr::null();
        // SAFETY: valid element, CFArray of CFStrings, and out pointer. Options 0 means
        // per-attribute errors come back as AXValue error entries.
        let code = unsafe {
            self.0.copy_multiple_attribute_values(
                array.as_opaque(),
                objc2_application_services::AXCopyMultipleAttributeOptions(0),
                NonNull::from(&mut values),
            )
        };
        check(code)?;
        let Some(values) = NonNull::new(values as *mut CFArray) else {
            return Ok(vec![None; names.len()]);
        };
        // SAFETY: the copy rule hands us a +1 reference.
        let values: CFRetained<CFArray<CFType>> = unsafe { CFRetained::from_raw(values.cast()) };
        let mut out = Vec::with_capacity(names.len());
        for index in 0..names.len() {
            let value = values.get(index).filter(|value| !is_ax_error_value(value));
            out.push(value);
        }
        Ok(out)
    }

    pub fn set_attr(&self, name: &str, value: &CFType, deadline: Deadline) -> AxResult<()> {
        self.arm(deadline)?;
        let name = cfstr(name);
        // SAFETY: valid element, attribute, and value.
        check(unsafe { self.0.set_attribute_value(&name, value) })
    }

    pub fn is_settable(&self, name: &str, deadline: Deadline) -> AxResult<bool> {
        self.arm(deadline)?;
        let name = cfstr(name);
        let mut settable: u8 = 0;
        // SAFETY: valid element, attribute, and out pointer.
        check(unsafe { self.0.is_attribute_settable(&name, NonNull::from(&mut settable).cast()) })?;
        Ok(settable != 0)
    }

    pub fn perform(&self, action: &str, deadline: Deadline) -> AxResult<()> {
        self.arm(deadline)?;
        let action = cfstr(action);
        // SAFETY: valid element and action string.
        check(unsafe { self.0.perform_action(&action) })
    }

    pub fn action_names(&self, deadline: Deadline) -> AxResult<Vec<String>> {
        self.arm(deadline)?;
        let mut names: *const CFArray = std::ptr::null();
        // SAFETY: valid element and out pointer.
        check(unsafe { self.0.copy_action_names(NonNull::from(&mut names)) })?;
        let Some(names) = NonNull::new(names as *mut CFArray) else {
            return Ok(Vec::new());
        };
        // SAFETY: +1 reference from the copy rule.
        let names: CFRetained<CFArray<CFType>> = unsafe { CFRetained::from_raw(names.cast()) };
        Ok(names.iter().filter_map(|name| as_string(&name)).collect())
    }

    /// Hit test at a screen point (top-left origin, points). Call on an application
    /// element to restrict the search to that app.
    pub fn element_at(&self, x: f64, y: f64, deadline: Deadline) -> AxResult<Option<AxElement>> {
        self.arm(deadline)?;
        let mut element: *const AXUIElement = std::ptr::null();
        // SAFETY: valid element and out pointer.
        check(unsafe { self.0.copy_element_at_position(x as f32, y as f32, NonNull::from(&mut element)) })?;
        Ok(NonNull::new(element as *mut AXUIElement).map(|element| AxElement(unsafe { CFRetained::from_raw(element) })))
    }

    pub fn string(&self, name: &str, deadline: Deadline) -> AxResult<Option<String>> {
        Ok(self.attr(name, deadline)?.as_deref().and_then(as_string))
    }

    pub fn element(&self, name: &str, deadline: Deadline) -> AxResult<Option<AxElement>> {
        Ok(self.attr(name, deadline)?.as_deref().and_then(as_element))
    }

    pub fn elements(&self, name: &str, deadline: Deadline) -> AxResult<Vec<AxElement>> {
        Ok(self.attr(name, deadline)?.as_deref().map(as_elements).unwrap_or_default())
    }

    pub fn bool(&self, name: &str, deadline: Deadline) -> AxResult<Option<bool>> {
        Ok(self.attr(name, deadline)?.as_deref().and_then(as_bool))
    }

    /// `AXPosition` + `AXSize` as one rect, in screen points.
    pub fn frame(&self, deadline: Deadline) -> AxResult<Option<Rect>> {
        let values = self.attrs(&["AXPosition", "AXSize"], deadline)?;
        Ok(rect_from(values[0].as_deref(), values[1].as_deref()))
    }
}

impl PartialEq for AxElement {
    fn eq(&self, other: &Self) -> bool {
        let a: &CFType = self.0.as_ref();
        let b: &CFType = other.0.as_ref();
        a == b
    }
}

/// Hash of the element's identity (`CFHash`), stable while the element lives.
pub fn element_hash(element: &AxElement) -> u64 {
    let cf: &CFType = element.0.as_ref();
    objc2_core_foundation::CFHash(Some(cf)) as u64
}

fn is_ax_error_value(value: &CFType) -> bool {
    value
        .downcast_ref::<AXValue>()
        // SAFETY: valid AXValue.
        .is_some_and(|value| unsafe { value.r#type() } == AXValueType::AXError)
}

// -- conversions --------------------------------------------------------------

pub fn as_string(value: &CFType) -> Option<String> {
    if let Some(string) = value.downcast_ref::<CFString>() {
        return Some(string.to_string());
    }
    // Some apps return numbers as values; render them as text.
    value.downcast_ref::<CFNumber>().and_then(|number| number.as_f64()).map(|number| {
        if number.fract() == 0.0 && number.abs() < 1e15 { format!("{}", number as i64) } else { format!("{number}") }
    })
}

pub fn as_bool(value: &CFType) -> Option<bool> {
    if let Some(flag) = value.downcast_ref::<CFBoolean>() {
        return Some(flag.as_bool());
    }
    value.downcast_ref::<CFNumber>().and_then(|number| number.as_i64()).map(|number| number != 0)
}

pub fn as_f64(value: &CFType) -> Option<f64> {
    value.downcast_ref::<CFNumber>().and_then(|number| number.as_f64())
}

pub fn as_element(value: &CFType) -> Option<AxElement> {
    let element = value.downcast_ref::<AXUIElement>()?;
    Some(AxElement(element.retain()))
}

pub fn as_elements(value: &CFType) -> Vec<AxElement> {
    let Some(array) = value.downcast_ref::<CFArray>() else {
        return Vec::new();
    };
    // SAFETY: we only read entries and check each one's type.
    let array: &CFArray<CFType> = unsafe { array.cast_unchecked() };
    array.iter().filter_map(|item| as_element(&item)).collect()
}

fn ax_value<T: Default>(value: &CFType, kind: AXValueType) -> Option<T> {
    let value = value.downcast_ref::<AXValue>()?;
    let mut out = T::default();
    // SAFETY: `kind` matches `T`'s layout (CGPoint, CGSize, CGRect, or CFRange).
    let ok = unsafe { value.value(kind, NonNull::from(&mut out).cast::<c_void>()) };
    ok.then_some(out)
}

pub fn as_point(value: &CFType) -> Option<CGPoint> {
    ax_value(value, AXValueType::CGPoint)
}

pub fn as_size(value: &CFType) -> Option<CGSize> {
    ax_value(value, AXValueType::CGSize)
}

pub fn as_range(value: &CFType) -> Option<CFRange> {
    let value = value.downcast_ref::<AXValue>()?;
    let mut out = CFRange { location: 0, length: 0 };
    // SAFETY: CFRange matches AXValueType::CFRange.
    let ok = unsafe { value.value(AXValueType::CFRange, NonNull::from(&mut out).cast::<c_void>()) };
    ok.then_some(out)
}

pub fn rect_from(position: Option<&CFType>, size: Option<&CFType>) -> Option<Rect> {
    let position = as_point(position?)?;
    let size = as_size(size?)?;
    Some(Rect { x: position.x, y: position.y, width: size.width, height: size.height })
}

pub fn range_value(start: usize, length: usize) -> CFRetained<AXValue> {
    let range = CFRange { location: start as isize, length: length as isize };
    // SAFETY: CFRange matches AXValueType::CFRange.
    unsafe { AXValue::new(AXValueType::CFRange, NonNull::from(&range).cast()) }.expect("AXValueCreate(CFRange)")
}

pub fn point_value(x: f64, y: f64) -> CFRetained<AXValue> {
    let point = CGPoint { x, y };
    // SAFETY: CGPoint matches AXValueType::CGPoint.
    unsafe { AXValue::new(AXValueType::CGPoint, NonNull::from(&point).cast()) }.expect("AXValueCreate(CGPoint)")
}

pub fn rect_of(rect: CGRect) -> Rect {
    Rect { x: rect.origin.x, y: rect.origin.y, width: rect.size.width, height: rect.size.height }
}

pub fn cf_bool(flag: bool) -> CFRetained<CFBoolean> {
    CFBoolean::new(flag).retain()
}

// -- names ----------------------------------------------------------------------

/// Native AX action name for a core action.
pub fn action_name(action: ElementAction) -> &'static str {
    match action {
        ElementAction::Press => "AXPress",
        ElementAction::ShowMenu => "AXShowMenu",
        ElementAction::Confirm => "AXConfirm",
        ElementAction::Open => "AXOpen",
        ElementAction::Pick => "AXPick",
        ElementAction::Cancel => "AXCancel",
        ElementAction::Increment => "AXIncrement",
        ElementAction::Decrement => "AXDecrement",
        ElementAction::ScrollToVisible => "AXScrollToVisible",
    }
}

/// Core actions from native action names. Unknown names are dropped.
pub fn core_actions(names: &[String]) -> Vec<ElementAction> {
    names
        .iter()
        .filter_map(|name| {
            Some(match name.as_str() {
                "AXPress" => ElementAction::Press,
                "AXShowMenu" => ElementAction::ShowMenu,
                "AXConfirm" => ElementAction::Confirm,
                "AXOpen" => ElementAction::Open,
                "AXPick" => ElementAction::Pick,
                "AXCancel" => ElementAction::Cancel,
                "AXIncrement" => ElementAction::Increment,
                "AXDecrement" => ElementAction::Decrement,
                "AXScrollToVisible" => ElementAction::ScrollToVisible,
                _ => return None,
            })
        })
        .collect()
}

/// Lowercase role words from an AX role and subrole, e.g. `AXPopUpButton` → `popup button`.
/// Uses the exact words in [`cu_core::tree::roles`] for roles the core treats specially.
pub fn role_words(role: &str, subrole: Option<&str>) -> String {
    match subrole {
        Some("AXSecureTextField") => return "secure text field".to_owned(),
        Some("AXSwitch") => return "switch".to_owned(),
        Some("AXSearchField") => return "search field".to_owned(),
        Some("AXTabButton") => return "tab".to_owned(),
        Some("AXCloseButton") => return "close button".to_owned(),
        Some("AXMinimizeButton") => return "minimize button".to_owned(),
        Some("AXZoomButton") => return "zoom button".to_owned(),
        Some("AXFullScreenButton") => return "full screen button".to_owned(),
        Some("AXToggle") => return "toggle button".to_owned(),
        _ => {}
    }
    let fixed = match role {
        "AXPopUpButton" => "popup button",
        "AXCheckBox" => "checkbox",
        "AXStaticText" => "text",
        "AXTextField" => "text field",
        "AXTextArea" => "text area",
        "AXComboBox" => "combo box",
        "AXMenuButton" => "menu button",
        "AXMenuBarItem" => "menu bar item",
        "AXScrollArea" => "scroll area",
        "AXScrollBar" => "scroll bar",
        "AXWebArea" => "web area",
        "AXTabGroup" => "tab group",
        "AXRadioButton" => "radio button",
        "AXRadioGroup" => "radio group",
        "AXSplitGroup" => "split group",
        "AXDisclosureTriangle" => "disclosure triangle",
        "AXIncrementor" => "stepper",
        "AXLevelIndicator" => "level indicator",
        "AXProgressIndicator" => "progress indicator",
        "AXBusyIndicator" => "busy indicator",
        "AXValueIndicator" => "value indicator",
        "AXColorWell" => "color well",
        "AXDateField" => "date field",
        "AXTimeField" => "time field",
        "AXLink" => "link",
        _ => "",
    };
    if !fixed.is_empty() {
        return fixed.to_owned();
    }
    // Generic: drop the AX prefix and split camel case.
    let bare = role.strip_prefix("AX").unwrap_or(role);
    let mut words = String::new();
    for (index, character) in bare.chars().enumerate() {
        if character.is_uppercase() && index > 0 {
            words.push(' ');
        }
        words.extend(character.to_lowercase());
    }
    if words.is_empty() { "unknown".to_owned() } else { words }
}

/// Converts a mapped `CFRetained<T>` into a generic `&CFType`.
pub fn as_cf<T: AsRef<CFType>>(value: &T) -> &CFType {
    value.as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_roles_to_words() {
        assert_eq!(role_words("AXPopUpButton", None), "popup button");
        assert_eq!(role_words("AXTextField", Some("AXSecureTextField")), "secure text field");
        assert_eq!(role_words("AXOutline", None), "outline");
        assert_eq!(role_words("AXRow", Some("AXOutlineRow")), "row");
        assert_eq!(role_words("AXSomethingNew", None), "something new");
        assert_eq!(role_words("AXStaticText", None), cu_core::tree::roles::STATIC_TEXT);
        assert_eq!(role_words("AXIncrementor", None), cu_core::tree::roles::STEPPER);
    }

    #[test]
    fn maps_action_names_both_ways() {
        let names = vec!["AXPress".to_owned(), "AXRaise".to_owned(), "AXShowMenu".to_owned()];
        let actions = core_actions(&names);
        assert_eq!(actions, vec![ElementAction::Press, ElementAction::ShowMenu]);
        assert_eq!(action_name(ElementAction::ScrollToVisible), "AXScrollToVisible");
    }
}
