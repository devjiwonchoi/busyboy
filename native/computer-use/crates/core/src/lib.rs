//! Platform-agnostic core of BusyBoy Computer Use.
//!
//! Holds session and turn state, the element-ref table, tree budgets, the outline
//! renderer, the action ordering policy, the forbidden-app list, key parsing, and the
//! [`Platform`] trait every OS backend implements. Nothing here touches OS APIs, so it
//! builds for Windows as well as macOS.

pub mod deadline;
pub mod engine;
pub mod forbidden;
pub mod keys;
pub mod outline;
pub mod platform;
pub mod refs;
pub mod text;
pub mod tree;

#[cfg(any(test, feature = "fake"))]
pub mod fake;

pub use deadline::{CancelReason, CancelToken, Deadline};
pub use engine::Engine;
pub use platform::*;
pub use tree::*;

/// Every fallible operation returns the protocol's error object directly.
pub type CuResult<T> = Result<T, cu_protocol::ErrorObject>;
