//! Wire protocol between the BusyBoy desktop app and the BusyBoy Computer Use helper.
//!
//! Frames are a 4-byte big-endian length followed by a UTF-8 JSON body shaped like
//! JSON-RPC 2.0. This crate has no platform dependencies so it builds for Windows too.

mod error;
mod frame;
mod methods;
mod rpc;

pub use error::*;
pub use frame::*;
pub use methods::*;
pub use rpc::*;

/// Integer protocol version exchanged in `hello`. Bump on any incompatible change.
pub const PROTOCOL_VERSION: u32 = 1;

/// The `client` value the desktop app sends in `hello`.
pub const DESKTOP_CLIENT: &str = "busyboy-desktop";
