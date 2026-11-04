// @effect-diagnostics nodeBuiltinImport:off - Runs a fake helper on a Unix socket.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { encodeHelperFrame, HelperFrameDecoder } from "./HelperFraming.ts";
import { HelperClient, type HelperNotification } from "./HelperClient.ts";

type Handler = (message: Record<string, unknown>, reply: (body: unknown) => void) => void;

const servers: Array<NodeNet.Server> = [];
const dirs: Array<string> = [];

async function fakeHelper(handler: Handler): Promise<string> {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cu-"));
  dirs.push(dir);
  const socketPath = NodePath.join(dir, "h.sock");
  const server = NodeNet.createServer((socket) => {
    const decoder = new HelperFrameDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        handler(message as Record<string, unknown>, (body) =>
          socket.write(encodeHelperFrame(body)),
        );
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return socketPath;
}

const helloResult = {
  protocolVersion: 1,
  helperVersion: "0.1.0",
  platform: "macos",
  capabilities: [],
};

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("HelperClient", () => {
  it("handshakes, matches responses, and delivers notifications", async () => {
    const socketPath = await fakeHelper((message, reply) => {
      if (message.method === "hello") {
        reply({ jsonrpc: "2.0", id: message.id, result: helloResult });
        reply({ jsonrpc: "2.0", method: "lock_changed", params: { locked: false } });
        return;
      }
      reply({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: "turn_inactive", message: "no session", retryable: false },
      });
    });
    const notifications: Array<HelperNotification> = [];
    const { client, hello } = await HelperClient.connect({
      socketPath,
      clientVersion: "test",
      onNotification: (notification) => notifications.push(notification),
      onClose: () => {},
    });
    expect(hello.platform).toBe("macos");
    await expect(client.request("app.state", {})).rejects.toMatchObject({
      error: { code: "turn_inactive" },
    });
    expect(notifications).toEqual([{ method: "lock_changed", params: { locked: false } }]);
    client.close();
  });

  it("fails pending requests when the helper disconnects", async () => {
    const socketPath = await fakeHelper((message, reply) => {
      if (message.method === "hello") {
        reply({ jsonrpc: "2.0", id: message.id, result: helloResult });
      }
    });
    let closed: unknown = null;
    const { client } = await HelperClient.connect({
      socketPath,
      clientVersion: "test",
      onNotification: () => {},
      onClose: (error) => {
        closed = error;
      },
    });
    const pending = client.request("apps.list", {});
    for (const server of servers) server.close();
    client.close();
    await expect(pending).rejects.toMatchObject({ error: { code: "computer_use_unavailable" } });
    expect(closed).not.toBeNull();
  });

  it("surfaces version mismatches from the handshake", async () => {
    const socketPath = await fakeHelper((message, reply) => {
      reply({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: "version_mismatch", message: "protocol 2", retryable: false },
      });
    });
    await expect(
      HelperClient.connect({
        socketPath,
        clientVersion: "test",
        onNotification: () => {},
        onClose: () => {},
      }),
    ).rejects.toMatchObject({ error: { code: "version_mismatch" } });
  });

  it("treats an error without an id as fatal for the connection", async () => {
    const socketPath = await fakeHelper((message, reply) => {
      if (message.method === "hello") {
        reply({ jsonrpc: "2.0", id: message.id, result: helloResult });
        return;
      }
      reply({
        jsonrpc: "2.0",
        id: null,
        error: { code: "invalid_frame", message: "bad frame", retryable: false },
      });
    });
    let closed: unknown = null;
    const { client } = await HelperClient.connect({
      socketPath,
      clientVersion: "test",
      onNotification: () => {},
      onClose: (error) => {
        closed = error;
      },
    });
    await expect(client.request("apps.list", {})).rejects.toMatchObject({
      error: { code: "computer_use_unavailable", details: { reason: "invalid_frame" } },
    });
    expect(closed).toMatchObject({ error: { details: { reason: "invalid_frame" } } });
    expect(client.closed).toBe(true);
    await expect(client.request("apps.list", {})).rejects.toMatchObject({
      error: { code: "computer_use_unavailable" },
    });
  });

  it("gives up on a helper that accepts but never answers hello", async () => {
    const socketPath = await fakeHelper(() => {});
    await expect(
      HelperClient.connect({
        socketPath,
        clientVersion: "test",
        onNotification: () => {},
        onClose: () => {},
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({
      error: { code: "computer_use_unavailable", details: { reason: "helper_unreachable" } },
    });
  });

  it("reports a connection closed before hello as helper_disconnected", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cu-"));
    dirs.push(dir);
    const socketPath = NodePath.join(dir, "h.sock");
    const server = NodeNet.createServer((socket) => socket.destroy());
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    await expect(
      HelperClient.connect({
        socketPath,
        clientVersion: "test",
        onNotification: () => {},
        onClose: () => {},
      }),
    ).rejects.toMatchObject({ error: { details: { reason: "helper_disconnected" } } });
  });

  it("drops malformed messages and types malformed errors as internal_error", async () => {
    const socketPath = await fakeHelper((message, reply) => {
      if (message.method === "hello") {
        reply({ jsonrpc: "2.0", id: message.id, result: { ...helloResult, pid: 1234 } });
        return;
      }
      reply(null);
      reply(7);
      reply({ jsonrpc: "2.0", id: "x", result: 1 });
      reply({ jsonrpc: "2.0", id: message.id, error: { code: "turn_inactive" } });
    });
    const { client, hello } = await HelperClient.connect({
      socketPath,
      clientVersion: "test",
      onNotification: () => {},
      onClose: () => {},
    });
    expect(hello.pid).toBe(1234);
    await expect(client.request("app.state", {})).rejects.toMatchObject({
      error: { code: "internal_error", retryable: false },
    });
    expect(client.closed).toBe(false);
    client.close();
  });

  it("refuses a request too large to frame without leaving it pending", async () => {
    const socketPath = await fakeHelper((message, reply) => {
      if (message.method === "hello") {
        reply({ jsonrpc: "2.0", id: message.id, result: helloResult });
      }
    });
    const { client } = await HelperClient.connect({
      socketPath,
      clientVersion: "test",
      onNotification: () => {},
      onClose: () => {},
    });
    await expect(
      client.request("type", { text: "x".repeat(17 * 1024 * 1024) }),
    ).rejects.toMatchObject({ error: { code: "invalid_argument" } });
    expect((client as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
    client.close();
  });
});
