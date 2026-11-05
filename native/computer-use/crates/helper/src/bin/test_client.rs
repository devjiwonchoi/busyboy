//! Minimal helper client for the caller-verification test. Never bundled.
//!
//! Usage: `busyboy-cu-test-client <socket> [protocolVersion]`. Sends `hello` and prints
//! one line: `response <json>` for a reply, `closed` if the helper closed without a
//! byte, or `error <why>`.

use std::io::Read;
use std::os::unix::net::UnixStream;
use std::time::Duration;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(socket) = args.next() else {
        eprintln!("usage: busyboy-cu-test-client <socket> [protocolVersion]");
        std::process::exit(2);
    };
    let version: u32 = args.next().and_then(|value| value.parse().ok()).unwrap_or(cu_protocol::PROTOCOL_VERSION);

    let mut stream = match UnixStream::connect(&socket) {
        Ok(stream) => stream,
        Err(error) => {
            println!("error connect: {error}");
            std::process::exit(1);
        }
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let hello = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "hello",
        "params": { "protocolVersion": version, "client": cu_protocol::DESKTOP_CLIENT, "clientVersion": "test" },
    });
    // A rejected peer may see EPIPE here; what matters is what we read back.
    let _ = cu_protocol::write_frame(&mut stream, hello.to_string().as_bytes());

    let mut header = [0u8; 4];
    let mut filled = 0;
    while filled < header.len() {
        match stream.read(&mut header[filled..]) {
            Ok(0) if filled == 0 => {
                println!("closed");
                return;
            }
            Ok(0) => {
                println!("error truncated after {filled} bytes");
                std::process::exit(1);
            }
            Ok(read) => filled += read,
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset && filled == 0 => {
                println!("closed");
                return;
            }
            Err(error) => {
                println!("error read: {error}");
                std::process::exit(1);
            }
        }
    }
    let mut body = vec![0u8; u32::from_be_bytes(header) as usize];
    match stream.read_exact(&mut body) {
        Ok(()) => println!("response {}", String::from_utf8_lossy(&body)),
        Err(error) => {
            println!("error body: {error}");
            std::process::exit(1);
        }
    }
}
