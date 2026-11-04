use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Every error code the helper can return. The names are part of the public contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    ComputerUseUnavailable,
    PermissionRequired,
    AppNotFound,
    AppLaunchFailed,
    AppForbidden,
    AppDenied,
    WindowNotFound,
    StaleElement,
    ElementNotFound,
    ActionUnsupported,
    SecureField,
    KeyRefused,
    ScreenLocked,
    Stopped,
    TurnInactive,
    Timeout,
    InvalidArgument,
    /// Protocol level: a frame could not be decoded.
    InvalidFrame,
    /// Protocol level: `hello` carried another protocol version.
    VersionMismatch,
    /// Unexpected helper failure that fits no other code.
    InternalError,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::ComputerUseUnavailable => "computer_use_unavailable",
            ErrorCode::PermissionRequired => "permission_required",
            ErrorCode::AppNotFound => "app_not_found",
            ErrorCode::AppLaunchFailed => "app_launch_failed",
            ErrorCode::AppForbidden => "app_forbidden",
            ErrorCode::AppDenied => "app_denied",
            ErrorCode::WindowNotFound => "window_not_found",
            ErrorCode::StaleElement => "stale_element",
            ErrorCode::ElementNotFound => "element_not_found",
            ErrorCode::ActionUnsupported => "action_unsupported",
            ErrorCode::SecureField => "secure_field",
            ErrorCode::KeyRefused => "key_refused",
            ErrorCode::ScreenLocked => "screen_locked",
            ErrorCode::Stopped => "stopped",
            ErrorCode::TurnInactive => "turn_inactive",
            ErrorCode::Timeout => "timeout",
            ErrorCode::InvalidArgument => "invalid_argument",
            ErrorCode::InvalidFrame => "invalid_frame",
            ErrorCode::VersionMismatch => "version_mismatch",
            ErrorCode::InternalError => "internal_error",
        }
    }

    /// Default retryability. `computer_use_unavailable` depends on the reason, so callers may override.
    pub fn default_retryable(self) -> bool {
        matches!(
            self,
            ErrorCode::AppLaunchFailed
                | ErrorCode::WindowNotFound
                | ErrorCode::StaleElement
                | ErrorCode::ScreenLocked
                | ErrorCode::Timeout
        )
    }

    /// Short next-step hint for the model.
    pub fn default_hint(self) -> Option<&'static str> {
        Some(match self {
            ErrorCode::PermissionRequired => {
                "ask the user to open BusyBoy Settings → Computer Use and grant Accessibility"
            }
            ErrorCode::StaleElement => "the element changed; call computer_snapshot again",
            ErrorCode::ElementNotFound => "call computer_snapshot to get current refs",
            ErrorCode::ActionUnsupported => {
                "try computer_select, computer_fill, or computer_invoke_menu"
            }
            ErrorCode::ScreenLocked => "the user must unlock the Mac; do not ask for the password",
            ErrorCode::Stopped => "stop and tell the user; do not retry this turn",
            ErrorCode::WindowNotFound => "call computer_snapshot to list the app's windows",
            ErrorCode::AppNotFound => "call computer_apps to list available apps",
            _ => return None,
        })
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Error body carried in a response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorObject {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    pub retryable: bool,
}

impl ErrorObject {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        ErrorObject {
            code,
            message: message.into(),
            hint: code.default_hint().map(str::to_owned),
            details: None,
            retryable: code.default_retryable(),
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn with_retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    /// `{code, message, details: {reason}}` shorthand used for most policy errors.
    pub fn with_reason(code: ErrorCode, reason: &str, message: impl Into<String>) -> Self {
        ErrorObject::new(code, message).with_details(serde_json::json!({ "reason": reason }))
    }
}

impl std::fmt::Display for ErrorObject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ErrorObject {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_codes_as_snake_case_strings() {
        let error = ErrorObject::with_reason(ErrorCode::AppForbidden, "terminal", "Terminal apps are off limits");
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["code"], "app_forbidden");
        assert_eq!(json["details"]["reason"], "terminal");
        assert_eq!(json["retryable"], false);
        assert_eq!(serde_json::to_value(ErrorCode::ComputerUseUnavailable).unwrap(), "computer_use_unavailable");
    }

    #[test]
    fn stale_element_hint_points_at_snapshot() {
        let error = ErrorObject::new(ErrorCode::StaleElement, "gone");
        assert!(error.retryable);
        assert!(error.hint.unwrap().contains("call computer_snapshot again"));
    }
}
