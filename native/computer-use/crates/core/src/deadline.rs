use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};

use cu_protocol::{ErrorCode, ErrorObject, MAX_DEADLINE_MS, DEFAULT_DEADLINE_MS};

/// Longest single accessibility call before it counts as hung.
pub const MAX_CALL_TIMEOUT: Duration = Duration::from_millis(250);

/// Absolute end time of one request.
#[derive(Debug, Clone, Copy)]
pub struct Deadline {
    at: Instant,
    /// Longest single call; [`MAX_CALL_TIMEOUT`] unless raised for a retry.
    call_cap: Duration,
}

impl Deadline {
    /// Builds a deadline from an optional client value, clamped to the protocol maximum.
    pub fn from_ms(deadline_ms: Option<u64>) -> Self {
        let millis = deadline_ms.unwrap_or(DEFAULT_DEADLINE_MS).clamp(1, MAX_DEADLINE_MS);
        Deadline::after(Duration::from_millis(millis))
    }

    pub fn after(duration: Duration) -> Self {
        Deadline { at: Instant::now() + duration, call_cap: MAX_CALL_TIMEOUT }
    }

    pub fn remaining(&self) -> Duration {
        self.at.saturating_duration_since(Instant::now())
    }

    pub fn expired(&self) -> bool {
        Instant::now() >= self.at
    }

    /// Timeout for the next single platform call: the smaller of the remaining time
    /// and the call cap (250 ms unless raised with [`Deadline::with_call_cap`]).
    pub fn call_timeout(&self) -> Duration {
        self.remaining().min(self.call_cap)
    }

    /// The same deadline, but single calls may take up to `call_cap`. Used to give
    /// a slow app a second chance, still within the request deadline.
    pub fn with_call_cap(&self, call_cap: Duration) -> Deadline {
        Deadline { at: self.at, call_cap }
    }

    /// The earlier of this deadline and `duration` from now.
    pub fn capped(&self, duration: Duration) -> Deadline {
        Deadline { at: self.at.min(Instant::now() + duration), call_cap: self.call_cap }
    }

    pub fn check(&self, phase: &str) -> Result<(), ErrorObject> {
        if self.expired() {
            return Err(timeout_error(phase));
        }
        Ok(())
    }
}

pub fn timeout_error(phase: &str) -> ErrorObject {
    ErrorObject::new(ErrorCode::Timeout, format!("deadline exceeded during {phase}"))
        .with_details(serde_json::json!({ "phase": phase }))
}

/// Why a request was cancelled. The value decides the error the request returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum CancelReason {
    UserEscape = 1,
    UserInput = 2,
    ScreenLocked = 3,
    ClientStop = 4,
}

/// Shared cancellation flag, checked between platform calls and posted events.
#[derive(Debug, Clone, Default)]
pub struct CancelToken {
    state: Arc<AtomicU8>,
}

impl CancelToken {
    pub fn new() -> Self {
        CancelToken::default()
    }

    /// Records the first cancellation reason. Later calls keep the first one.
    pub fn cancel(&self, reason: CancelReason) {
        let _ = self.state.compare_exchange(0, reason as u8, Ordering::SeqCst, Ordering::SeqCst);
    }

    pub fn reason(&self) -> Option<CancelReason> {
        match self.state.load(Ordering::SeqCst) {
            1 => Some(CancelReason::UserEscape),
            2 => Some(CancelReason::UserInput),
            3 => Some(CancelReason::ScreenLocked),
            4 => Some(CancelReason::ClientStop),
            _ => None,
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.reason().is_some()
    }

    /// Returns the error a cancelled request reports, if cancelled.
    pub fn check(&self) -> Result<(), ErrorObject> {
        match self.reason() {
            None => Ok(()),
            Some(reason) => Err(cancel_error(reason)),
        }
    }
}

pub fn cancel_error(reason: CancelReason) -> ErrorObject {
    let stop_reason = match reason {
        CancelReason::ScreenLocked => return screen_locked_error(),
        CancelReason::UserEscape => "user_escape",
        CancelReason::UserInput => "user_input",
        CancelReason::ClientStop => "client_stop",
    };
    ErrorObject::with_reason(ErrorCode::Stopped, stop_reason, "the user stopped computer use")
}

pub fn screen_locked_error() -> ErrorObject {
    ErrorObject::new(ErrorCode::ScreenLocked, "the screen is locked")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_deadlines_and_caps_call_timeouts() {
        let deadline = Deadline::from_ms(Some(10 * MAX_DEADLINE_MS));
        assert!(deadline.remaining() <= Duration::from_millis(MAX_DEADLINE_MS));
        assert_eq!(deadline.call_timeout(), MAX_CALL_TIMEOUT);

        let short = Deadline::after(Duration::from_millis(5));
        assert!(short.call_timeout() <= Duration::from_millis(5));
        std::thread::sleep(Duration::from_millis(6));
        assert_eq!(short.check("tree").unwrap_err().code, ErrorCode::Timeout);
    }

    #[test]
    fn keeps_first_cancel_reason() {
        let token = CancelToken::new();
        assert!(token.check().is_ok());
        token.cancel(CancelReason::UserEscape);
        token.cancel(CancelReason::ClientStop);
        let error = token.check().unwrap_err();
        assert_eq!(error.code, ErrorCode::Stopped);
        assert_eq!(error.details.unwrap()["reason"], "user_escape");

        let locked = CancelToken::new();
        locked.cancel(CancelReason::ScreenLocked);
        assert_eq!(locked.check().unwrap_err().code, ErrorCode::ScreenLocked);
    }
}
