// @effect-diagnostics nodeBuiltinImport:off - A stand-in helper process for supervisor tests.
// @effect-diagnostics globalTimers:off - Watches stage 1 like the real helper does.
/**
 * Speaks the helper's framing and JSON-RPC on `$BUSYBOY_CU_SOCKET_DIR/helper.sock`.
 *
 * - `FAKE_HELPER_EXIT=<code>`: exit right away with that code.
 * - `FAKE_HELPER_PROTOCOL=<n>`: answer `hello` with `version_mismatch` unless n is 1.
 * - `FAKE_HELPER_IGNORE_SIGTERM=1`: survive SIGTERM, so only SIGKILL stops it.
 * - `FAKE_HELPER_REJECT=1`: close every connection without answering, like a
 *   helper that refuses this caller.
 * - `FAKE_HELPER_TWO_STAGE=1`: run like the real helper's two stages. This
 *   process (stage 1) spawns a copy that serves the socket (stage 2), forwards
 *   SIGTERM to it (unless `FAKE_HELPER_STAGE1_IGNORE_SIGTERM=1`), and exits with
 *   it; stage 2 stops itself when stage 1 dies.
 * - Method `test.crash`: exit with code 70.
 * `hello` reports the serving pid. Other methods echo `{method, params}`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

const env = process.env;
if (env.FAKE_HELPER_EXIT !== undefined) process.exit(Number(env.FAKE_HELPER_EXIT));

if (env.FAKE_HELPER_TWO_STAGE === "1") {
  const stage2 = NodeChildProcess.spawn(process.execPath, [process.argv[1]!], {
    env: {
      ...env,
      FAKE_HELPER_TWO_STAGE: "",
      FAKE_HELPER_STAGE1_PID: String(process.pid),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  process.on("SIGTERM", () => {
    if (env.FAKE_HELPER_STAGE1_IGNORE_SIGTERM === "1") return;
    stage2.kill("SIGTERM");
  });
  stage2.once("exit", (code) => process.exit(code ?? 0));
} else {
  serve();
}

function serve() {
  const dir = env.BUSYBOY_CU_SOCKET_DIR;
  if (!dir) process.exit(65);
  const socketPath = NodePath.join(dir, "helper.sock");
  NodeFS.rmSync(socketPath, { force: true });

  const frame = (body: unknown) => {
    const json = Buffer.from(JSON.stringify(body));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(json.length, 0);
    return Buffer.concat([header, json]);
  };

  const answer = (message: Record<string, unknown>): Record<string, unknown> => {
    const id = message.id;
    switch (message.method) {
      case "hello":
        if ((env.FAKE_HELPER_PROTOCOL ?? "1") !== "1") {
          return {
            id,
            error: { code: "version_mismatch", message: "protocol 2", retryable: false },
          };
        }
        return {
          id,
          result: {
            protocolVersion: 1,
            helperVersion: "0.0.0-fake",
            platform: "macos",
            capabilities: [],
            pid: process.pid,
          },
        };
      case "permissions.status":
        return {
          id,
          result: {
            accessibility: "not_granted",
            screenRecording: "granted",
            stopMonitor: "available",
          },
        };
      case "test.crash":
        process.exit(70);
      default:
        return { id, result: { method: message.method, params: message.params } };
    }
  };

  const server = NodeNet.createServer((socket) => {
    if (env.FAKE_HELPER_REJECT === "1") {
      socket.destroy();
      return;
    }
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) break;
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
        buffer = buffer.subarray(4 + length);
        socket.write(frame({ jsonrpc: "2.0", ...answer(message) }));
      }
    });
    socket.on("error", () => {});
  });

  server.listen(socketPath);
  const shutdown = () => {
    server.close();
    NodeFS.rmSync(socketPath, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    if (env.FAKE_HELPER_IGNORE_SIGTERM === "1") return;
    shutdown();
  });
  const stage1 = Number(env.FAKE_HELPER_STAGE1_PID);
  if (stage1 > 0) {
    // Like the helper's kqueue watch on stage 1.
    setInterval(() => {
      try {
        process.kill(stage1, 0);
      } catch {
        shutdown();
      }
    }, 25);
  }
}
