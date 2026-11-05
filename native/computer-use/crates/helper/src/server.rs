//! Socket server: caller verification, the `hello` handshake, per-request worker
//! threads, and notification fan-out (SPEC §2.6, §2.7).

use std::collections::HashMap;
use std::io::BufReader;
use std::net::Shutdown;
use std::os::fd::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use cu_core::engine::Notifier;
use cu_core::{CancelReason, Engine, Platform};
use cu_macos::caller::{self, Caller, LauncherIdentity, Rejection};
use cu_protocol::{
    ErrorCode, ErrorObject, FrameError, Message, Notification, Request, Response, method, read_frame,
    write_frame,
};
use serde_json::json;

use crate::log;

/// A stuck reader must not stall notifications or other responses for long.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The real verifier. With the `dev-callers` feature it also accepts `launcher`.
pub fn production_verifier(
    launcher: Option<LauncherIdentity>,
) -> impl Fn(&UnixStream) -> Result<Caller, Rejection> + Send + Sync + 'static {
    move |stream: &UnixStream| {
        let fd = stream.as_raw_fd();
        let rejection = match caller::verify_peer(fd) {
            Ok(caller) => return Ok(caller),
            Err(rejection) => rejection,
        };
        #[cfg(feature = "dev-callers")]
        if let Some(launcher) = launcher
            && let Ok(caller) = caller::verify_launcher(fd, launcher)
        {
            log(format!("accepted dev launcher pid={}", caller.pid));
            return Ok(caller);
        }
        #[cfg(not(feature = "dev-callers"))]
        let _ = launcher;
        Err(rejection)
    }
}

/// One verified connection's write side.
struct Conn {
    writer: Mutex<UnixStream>,
    /// Scopes this connection's request ids inside the engine.
    client: u64,
}

/// Distinct id per accepted connection.
static NEXT_CLIENT: AtomicU64 = AtomicU64::new(1);

impl Conn {
    fn write_body(&self, body: &[u8]) -> bool {
        write_frame(&mut *lock(&self.writer), body).is_ok()
    }

    fn write_response(&self, response: Response) {
        let id = response.id.clone();
        let body = serde_json::to_vec(&response).unwrap_or_default();
        if let Err(FrameError::TooLarge(size)) = cu_protocol::encode_frame(&body) {
            let error = ErrorObject::new(ErrorCode::InternalError, format!("response of {size} bytes is too large"));
            let body = serde_json::to_vec(&Response::err(id, error)).unwrap_or_default();
            self.write_body(&body);
            return;
        }
        self.write_body(&body);
    }

    /// An error that belongs to no request: JSON-RPC `id: null`.
    fn write_unattributed(&self, error: ErrorObject) {
        let body = json!({ "jsonrpc": "2.0", "id": null, "error": error });
        self.write_body(body.to_string().as_bytes());
    }

    fn close(&self) {
        let _ = lock(&self.writer).shutdown(Shutdown::Both);
    }
}

/// Method plus turn and reason, for the log. Notifications carry no private data,
/// but only these fields are logged.
fn describe(notification: &Notification) -> String {
    let field = |name: &str| notification.params.get(name).and_then(|value| value.as_str()).map(str::to_owned);
    let mut summary = notification.method.clone();
    if let Some(turn) = field("turnId") {
        summary.push_str(&format!(" turn {turn}"));
    }
    if let Some(reason) = field("reason") {
        summary.push_str(&format!(" reason {reason}"));
    }
    summary
}

/// Every verified, handshaken connection, for notifications.
#[derive(Default)]
pub struct Hub {
    conns: Mutex<HashMap<u64, Arc<Conn>>>,
    next: AtomicU64,
}

impl Hub {
    pub fn new() -> Arc<Self> {
        Arc::new(Hub::default())
    }

    /// The engine's notifier: sends each notification to every handshaken connection.
    /// Writes happen on a dedicated thread, in order, so a slow reader never blocks the
    /// caller (the stop path runs on the event-monitor dispatcher).
    pub fn notifier(self: &Arc<Self>) -> Notifier {
        let hub = Arc::downgrade(self);
        let (sender, receiver) = std::sync::mpsc::channel::<Notification>();
        let _ = thread::Builder::new().name("cu-notify".to_owned()).spawn(move || {
            for notification in receiver {
                let Some(hub) = hub.upgrade() else {
                    return;
                };
                hub.broadcast(&notification);
            }
        });
        let sender = Mutex::new(sender);
        Arc::new(move |notification: Notification| {
            let summary = describe(&notification);
            match lock(&sender).send(notification) {
                Ok(()) => log(format!("notification queued: {summary}")),
                Err(_) => log(format!("notification dropped, the writer thread is gone: {summary}")),
            }
        })
    }

    fn broadcast(&self, notification: &Notification) {
        let summary = describe(notification);
        let Ok(body) = serde_json::to_vec(notification) else {
            log(format!("notification not encodable: {summary}"));
            return;
        };
        let conns: Vec<Arc<Conn>> = lock(&self.conns).values().cloned().collect();
        let written = conns.iter().filter(|conn| conn.write_body(&body)).count();
        log(format!("notification written to {written} of {} connections: {summary}", conns.len()));
    }

    fn add(&self, conn: Arc<Conn>) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        lock(&self.conns).insert(id, conn);
        id
    }

    fn remove(&self, id: u64) {
        lock(&self.conns).remove(&id);
    }

    /// Number of handshaken connections.
    pub fn len(&self) -> usize {
        lock(&self.conns).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Starts the accept loop. Each connection gets its own thread, verified before any read.
pub fn spawn<P, V>(listener: UnixListener, engine: Arc<Engine<P>>, hub: Arc<Hub>, verify: V) -> JoinHandle<()>
where
    P: Platform + 'static,
    V: Fn(&UnixStream) -> Result<Caller, Rejection> + Send + Sync + 'static,
{
    let verify = Arc::new(verify);
    thread::Builder::new()
        .name("cu-accept".to_owned())
        .spawn(move || {
            for stream in listener.incoming() {
                let stream = match stream {
                    Ok(stream) => stream,
                    Err(error) => {
                        log(format!("accept failed: {error}"));
                        thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                };
                let (engine, hub, verify) = (engine.clone(), hub.clone(), verify.clone());
                let spawned = thread::Builder::new()
                    .name("cu-conn".to_owned())
                    .spawn(move || serve_connection(stream, &engine, &hub, &*verify));
                if let Err(error) = spawned {
                    log(format!("could not start a connection thread: {error}"));
                }
            }
        })
        .expect("spawn accept thread")
}

fn invalid_argument(message: &str) -> ErrorObject {
    ErrorObject::new(ErrorCode::InvalidArgument, message)
}

fn serve_connection<P, V>(stream: UnixStream, engine: &Arc<Engine<P>>, hub: &Arc<Hub>, verify: &V)
where
    P: Platform + 'static,
    V: Fn(&UnixStream) -> Result<Caller, Rejection>,
{
    // Verification runs before a single byte is read, and a rejected peer gets none.
    let caller = match verify(&stream) {
        Ok(caller) => caller,
        Err(rejection) => {
            log(format!("rejected caller {rejection}"));
            let _ = stream.shutdown(Shutdown::Both);
            return;
        }
    };
    log(format!(
        "accepted caller pid={} identifier={} team={}",
        caller.pid,
        caller.identifier.as_deref().unwrap_or("-"),
        caller.team.as_deref().unwrap_or("-"),
    ));

    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let Ok(reader) = stream.try_clone() else {
        let _ = stream.shutdown(Shutdown::Both);
        return;
    };
    let conn = Arc::new(Conn { writer: Mutex::new(stream), client: NEXT_CLIENT.fetch_add(1, Ordering::Relaxed) });
    let mut reader = BufReader::new(reader);
    let mut hub_id = None;

    loop {
        let body = match read_frame(&mut reader) {
            Ok(Some(body)) => body,
            Ok(None) => break,
            Err(error @ (FrameError::TooLarge(_) | FrameError::InvalidUtf8)) => {
                conn.write_unattributed(ErrorObject::new(ErrorCode::InvalidFrame, error.to_string()));
                break;
            }
            Err(_) => break,
        };
        let Ok(message) = serde_json::from_str::<Message>(&body) else {
            conn.write_unattributed(ErrorObject::new(ErrorCode::InvalidFrame, "frame is not a JSON-RPC message"));
            break;
        };

        if hub_id.is_none() {
            match message {
                Message::Request(request) if request.method == method::HELLO => match engine.hello(request.params) {
                    Ok(result) => {
                        conn.write_response(Response::ok(request.id, result));
                        hub_id = Some(hub.add(conn.clone()));
                    }
                    // Version mismatch or bad params: answer, then close.
                    Err(error) => {
                        conn.write_response(Response::err(request.id, error));
                        break;
                    }
                },
                Message::Request(request) => {
                    conn.write_response(Response::err(request.id, invalid_argument("the first message must be hello")));
                    break;
                }
                _ => {
                    conn.write_unattributed(invalid_argument("the first message must be a hello request"));
                    break;
                }
            }
            continue;
        }

        match message {
            Message::Request(request) if request.method == method::HELLO => {
                conn.write_response(Response::err(request.id, invalid_argument("hello was already received")));
            }
            Message::Request(request) => dispatch(engine, &conn, request),
            // The desktop sends no notifications or responses today; ignore them.
            Message::Notification(_) | Message::Response(_) => {}
        }
    }

    if let Some(id) = hub_id {
        hub.remove(id);
    }
    // Work for a client that went away is wasted; stop it.
    engine.cancel_client(conn.client, None, CancelReason::ClientStop);
    conn.close();
}

/// Runs one request on its own thread so `cancel` and stops work while it is in flight.
fn dispatch<P: Platform + 'static>(engine: &Arc<Engine<P>>, conn: &Arc<Conn>, request: Request) {
    let (engine, conn) = (engine.clone(), conn.clone());
    let worker_conn = conn.clone();
    let id = request.id.clone();
    let spawned = thread::Builder::new().name("cu-request".to_owned()).spawn(move || {
        let Request { id, method, params, .. } = request;
        let response = match engine.handle(worker_conn.client, &id, &method, params) {
            Ok(result) => Response::ok(id.clone(), result),
            Err(error) => Response::err(id.clone(), error),
        };
        worker_conn.write_response(response);
    });
    if spawned.is_err() {
        conn.write_response(Response::err(id, ErrorObject::new(ErrorCode::InternalError, "could not start a worker")));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cu_core::PlatformEvent;
    use cu_core::fake::FakePlatform;
    use serde_json::Value;
    use std::io::{Read, Write};
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU32;

    struct Harness {
        path: PathBuf,
        engine: Arc<Engine<FakePlatform>>,
        hub: Arc<Hub>,
        dir: PathBuf,
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn start(accept: bool) -> Harness {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!("bbcu-srv-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("run").join(crate::socket::SOCKET_NAME);
        let socket = crate::socket::bind(&path).unwrap();
        let hub = Hub::new();
        let engine = Engine::new(Arc::new(FakePlatform::new()), "9.9.9", hub.notifier());
        spawn(socket.listener, engine.clone(), hub.clone(), move |_stream: &UnixStream| {
            if accept {
                Ok(Caller { pid: 1, identifier: Some("test".into()), team: None })
            } else {
                Err(Rejection { pid: None, identifier: None, team: None, reason: caller::RejectReason::NotLauncher })
            }
        });
        Harness { path, engine, hub, dir }
    }

    fn connect(harness: &Harness) -> UnixStream {
        let stream = UnixStream::connect(&harness.path).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        stream
    }

    fn send(stream: &mut UnixStream, value: Value) {
        write_frame(stream, value.to_string().as_bytes()).unwrap();
    }

    fn recv(stream: &mut UnixStream) -> Option<Value> {
        read_frame(stream).unwrap().map(|body| serde_json::from_str(&body).unwrap())
    }

    fn hello(version: u32) -> Value {
        json!({ "jsonrpc": "2.0", "id": 1, "method": "hello", "params": {
            "protocolVersion": version, "client": "busyboy-desktop", "clientVersion": "test" } })
    }

    fn assert_closed(stream: &mut UnixStream) {
        let mut rest = Vec::new();
        stream.read_to_end(&mut rest).unwrap();
        assert!(rest.is_empty(), "expected the helper to close, got {} more bytes", rest.len());
    }

    #[test]
    fn rejected_peer_gets_no_bytes() {
        let harness = start(false);
        let mut stream = connect(&harness);
        let _ = write_frame(&mut stream, hello(1).to_string().as_bytes());
        assert_closed(&mut stream);
    }

    #[test]
    fn handshake_then_requests_and_notifications() {
        let harness = start(true);
        let mut stream = connect(&harness);
        send(&mut stream, hello(1));
        let reply = recv(&mut stream).unwrap();
        assert_eq!(reply["id"], 1);
        assert_eq!(reply["result"]["protocolVersion"], 1);
        assert_eq!(reply["result"]["helperVersion"], "9.9.9");

        send(&mut stream, json!({ "jsonrpc": "2.0", "id": 2, "method": "permissions.status" }));
        let reply = recv(&mut stream).unwrap();
        assert_eq!(reply["id"], 2);
        assert!(reply["result"].is_object(), "{reply}");

        send(&mut stream, json!({ "jsonrpc": "2.0", "id": 3, "method": "hello", "params": {} }));
        assert_eq!(recv(&mut stream).unwrap()["error"]["code"], "invalid_argument");

        harness.engine.platform().emit(PlatformEvent::LockChanged { locked: true });
        let notification = recv(&mut stream).unwrap();
        assert_eq!(notification["method"], "lock_changed");
        assert_eq!(notification["params"]["locked"], true);
        assert!(notification.get("id").is_none());
        assert_eq!(harness.hub.len(), 1);
    }

    #[test]
    fn first_message_must_be_hello() {
        let harness = start(true);
        let mut stream = connect(&harness);
        send(&mut stream, json!({ "jsonrpc": "2.0", "id": 7, "method": "permissions.status" }));
        let reply = recv(&mut stream).unwrap();
        assert_eq!(reply["id"], 7);
        assert_eq!(reply["error"]["code"], "invalid_argument");
        assert_closed(&mut stream);

        let mut stream = connect(&harness);
        send(&mut stream, json!({ "jsonrpc": "2.0", "method": "stopped", "params": {} }));
        let reply = recv(&mut stream).unwrap();
        assert_eq!(reply["id"], Value::Null);
        assert_eq!(reply["error"]["code"], "invalid_argument");
        assert_closed(&mut stream);
    }

    #[test]
    fn version_mismatch_replies_then_closes() {
        let harness = start(true);
        let mut stream = connect(&harness);
        send(&mut stream, hello(2));
        let reply = recv(&mut stream).unwrap();
        assert_eq!(reply["id"], 1);
        assert_eq!(reply["error"]["code"], "version_mismatch");
        assert_closed(&mut stream);
        assert!(harness.hub.is_empty());
    }

    #[test]
    fn oversized_frame_closes_with_invalid_frame() {
        let harness = start(true);
        let mut stream = connect(&harness);
        send(&mut stream, hello(1));
        recv(&mut stream).unwrap();
        let length = (cu_protocol::MAX_FRAME_BYTES as u32) + 1;
        stream.write_all(&length.to_be_bytes()).unwrap();
        let reply = recv(&mut stream).unwrap();
        assert_eq!(reply["id"], Value::Null);
        assert_eq!(reply["error"]["code"], "invalid_frame");
        assert_closed(&mut stream);
    }

    #[test]
    fn non_json_frame_closes_with_invalid_frame() {
        let harness = start(true);
        let mut stream = connect(&harness);
        write_frame(&mut stream, b"not json").unwrap();
        assert_eq!(recv(&mut stream).unwrap()["error"]["code"], "invalid_frame");
        assert_closed(&mut stream);
    }

    #[cfg(not(feature = "dev-callers"))]
    #[test]
    fn release_verifier_rejects_the_launcher() {
        // This test process stands in for the launcher; release builds must not accept it.
        let me = LauncherIdentity { pid: std::process::id() as i32, start_time: caller::process_start_time(std::process::id() as i32).unwrap() };
        let (a, _b) = UnixStream::pair().unwrap();
        assert!(production_verifier(Some(me))(&a).is_err());
    }

    #[cfg(feature = "dev-callers")]
    #[test]
    fn dev_verifier_accepts_only_the_launcher() {
        let pid = std::process::id() as i32;
        let me = LauncherIdentity { pid, start_time: caller::process_start_time(pid).unwrap() };
        let (a, _b) = UnixStream::pair().unwrap();
        assert_eq!(production_verifier(Some(me))(&a).unwrap().pid, pid);

        let stale = LauncherIdentity { start_time: me.start_time + 1, ..me };
        assert!(production_verifier(Some(stale))(&a).is_err());
        let other = LauncherIdentity { pid: 1, ..me };
        assert!(production_verifier(Some(other))(&a).is_err());
        assert!(production_verifier(None)(&a).is_err());
    }
}
