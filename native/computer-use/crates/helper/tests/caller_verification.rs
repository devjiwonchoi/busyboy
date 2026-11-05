//! Criterion 4: with the real verifier (no `dev-callers`), only a process signed as
//! `dev.jiwon.busyboy` by team 5PA4R2B5FF completes `hello`. Everything else is closed
//! without a single response byte.
#![cfg(target_os = "macos")]

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cu_core::Engine;
use cu_core::fake::FakePlatform;
use cu_helper::server::{self, Hub};
use cu_helper::socket;

const IDENTITY: &str = "Developer ID Application: Jiwon Choi (5PA4R2B5FF)";
const CLIENT: &str = env!("CARGO_BIN_EXE_busyboy-cu-test-client");

fn hello_frame() -> Vec<u8> {
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "hello",
        "params": { "protocolVersion": 1, "client": "busyboy-desktop", "clientVersion": "test" },
    })
    .to_string();
    cu_protocol::encode_frame(body.as_bytes()).unwrap()
}

/// Socket under `target/tmp`, or under `$TMPDIR` if that path is too long for `sun_path`.
fn socket_path(work: &Path) -> PathBuf {
    let primary = work.join("run").join(socket::SOCKET_NAME);
    if primary.as_os_str().len() <= socket::MAX_SOCKET_PATH {
        return primary;
    }
    std::env::temp_dir().join(format!("bbcu-cv-{}", std::process::id())).join(socket::SOCKET_NAME)
}

fn start_server(path: &Path) {
    let bound = socket::bind(path).expect("bind test socket");
    let hub = Hub::new();
    let engine = Engine::new(Arc::new(FakePlatform::new()), "0.0.0-test", hub.notifier());
    // The verifier that ships, built without `dev-callers` for this test.
    server::spawn(bound.listener, engine, hub, server::production_verifier(None));
}

fn run_with_timeout(mut command: Command, stdin: Option<&[u8]>) -> String {
    command.stdout(Stdio::piped()).stderr(Stdio::inherit());
    command.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    let mut child = command.spawn().expect("spawn client");
    if let Some(bytes) = stdin {
        let mut pipe = child.stdin.take().unwrap();
        pipe.write_all(bytes).unwrap();
    }
    let started = Instant::now();
    while child.try_wait().unwrap().is_none() {
        if started.elapsed() > Duration::from_secs(20) {
            child.kill().unwrap();
            panic!("client did not finish in time");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut out = String::new();
    child.stdout.take().unwrap().read_to_string(&mut out).unwrap();
    out
}

fn run_client(binary: &Path, socket: &Path) -> String {
    let mut command = Command::new(binary);
    command.arg(socket);
    run_with_timeout(command, None).trim().to_owned()
}

fn identity_available() -> bool {
    let output = Command::new("/usr/bin/security").args(["find-identity", "-v", "-p", "codesigning"]).output();
    output.is_ok_and(|output| String::from_utf8_lossy(&output.stdout).contains(IDENTITY))
}

/// Copies the client and signs the copy with `identifier`.
fn signed_client(work: &Path, identifier: &str) -> PathBuf {
    let copy = work.join(format!("client-{identifier}"));
    std::fs::copy(CLIENT, &copy).unwrap();
    let sign = |timestamp: &str| {
        Command::new("/usr/bin/codesign")
            .args(["--force", "--options", "runtime", timestamp, "--identifier", identifier, "--sign", IDENTITY])
            .arg(&copy)
            .output()
            .unwrap()
    };
    let mut output = sign("--timestamp");
    if !output.status.success() {
        // The secure timestamp needs Apple's server; the requirement does not depend on it.
        eprintln!("codesign --timestamp failed ({}); retrying without a timestamp", String::from_utf8_lossy(&output.stderr).trim());
        output = sign("--timestamp=none");
    }
    assert!(output.status.success(), "codesign failed: {}", String::from_utf8_lossy(&output.stderr));
    copy
}

#[test]
fn only_the_busyboy_identity_completes_hello() {
    let work = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("cv-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();
    let path = socket_path(&work);
    start_server(&path);

    // (1a) This test process: linker ad-hoc signed.
    let mut stream = UnixStream::connect(&path).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let _ = stream.write_all(&hello_frame());
    let mut reply = Vec::new();
    let _ = stream.read_to_end(&mut reply);
    assert!(reply.is_empty(), "ad-hoc test process got {} bytes", reply.len());
    println!("(1a) ad-hoc signed test process: closed with 0 bytes");

    // (1b) The client as built: also only ad-hoc signed.
    assert_eq!(run_client(Path::new(CLIENT), &path), "closed");
    println!("(1b) unsigned/ad-hoc client binary: closed");

    // (2a) Apple-signed /usr/bin/nc: another anchor, team, and identifier.
    let mut nc = Command::new("/usr/bin/nc");
    nc.arg("-U").arg(&path);
    let out = run_with_timeout(nc, Some(&hello_frame()));
    assert!(out.is_empty(), "nc got a response: {out:?}");
    println!("(2a) Apple-signed /usr/bin/nc: closed with 0 bytes");

    assert!(
        identity_available(),
        "the signing identity {IDENTITY:?} is missing from the keychain; cases (2b) and (3) need it"
    );

    // (2b) Same team, wrong identifier.
    let other = signed_client(&work, "dev.jiwon.other");
    assert_eq!(run_client(&other, &path), "closed");
    println!("(2b) team 5PA4R2B5FF, identifier dev.jiwon.other: closed");

    // (3) The allowed identity completes hello.
    let allowed = signed_client(&work, "dev.jiwon.busyboy");
    let out = run_client(&allowed, &path);
    let body = out.strip_prefix("response ").unwrap_or_else(|| panic!("allowed client was not answered: {out:?}"));
    let reply: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(reply["id"], 1);
    assert_eq!(reply["result"]["protocolVersion"], 1, "{reply}");
    println!("(3) team 5PA4R2B5FF, identifier dev.jiwon.busyboy: hello ok, protocolVersion 1");

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_dir_all(&work);
}
