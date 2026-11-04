// @effect-diagnostics nodeBuiltinImport:off - A stand-in helper process for supervisor tests.
/**
 * Speaks the helper's framing and JSON-RPC on `$BUSYBOY_CU_SOCKET_DIR/helper.sock`.
 *
 * - `FAKE_HELPER_EXIT=<code>`: exit right away with that code.
 * - `FAKE_HELPER_PROTOCOL=<n>`: answer `hello` with `version_mismatch` unless n is 1.
 * - `FAKE_HELPER_IGNORE_SIGTERM=1`: survive SIGTERM, so only SIGKILL stops it.
 * - Method `test.crash`: exit with code 70.
 * Other methods echo `{method, params}`.
 */
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

const env = process.env;
if (env.FAKE_HELPER_EXIT !== undefined) process.exit(Number(env.FAKE_HELPER_EXIT));

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
process.on("SIGTERM", () => {
  if (env.FAKE_HELPER_IGNORE_SIGTERM === "1") return;
  server.close();
  NodeFS.rmSync(socketPath, { force: true });
  process.exit(0);
});
