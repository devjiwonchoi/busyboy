// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
import * as NodeHttp from "node:http";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { RelayClient, type RemoteProcess } from "./RelayClient.ts";
import { startRelayServer, type RelayServer } from "./relay/server.ts";

const TOKEN = "t".repeat(48);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const startRelay = async (): Promise<RelayServer> => {
  const relay = await startRelayServer({ token: TOKEN, port: 0, mcpPort: 0, host: "127.0.0.1" });
  cleanups.push(() => relay.close());
  return relay;
};

const connect = (relay: RelayServer, options: { token?: string; mcpOrigin?: string } = {}) => {
  const client = new RelayClient({
    url: `ws://127.0.0.1:${relay.port()}`,
    token: options.token ?? TOKEN,
    mcpOrigin: options.mcpOrigin ?? "http://127.0.0.1:1",
    reconnectDelayMs: () => 20,
  });
  cleanups.push(() => client.close());
  return client;
};

const collect = (child: RemoteProcess) => {
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  return () => output;
};

const waitFor = async (check: () => boolean, timeoutMs = 5_000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const exited = (child: RemoteProcess) =>
  new Promise<number | null>((resolve) => child.once("exit", (code: number | null) => resolve(code)));

describe("RelayClient", () => {
  it("runs a remote process over stdin and stdout", async () => {
    const relay = await startRelay();
    const client = connect(relay);
    await client.waitUntilConnected(5_000);
    const child = client.spawnRemote({
      command: "cat",
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    const output = collect(child);
    const done = exited(child);
    child.stdin.write("hello\n");
    child.stdin.end();
    expect(await done).toBe(0);
    expect(output()).toBe("hello\n");
  });

  it("keeps a running turn going across dropped connections", async () => {
    const relay = await startRelay();
    const client = connect(relay);
    await client.waitUntilConnected(5_000);
    // A turn: the process answers each stdin line, keeps running between them.
    const child = client.spawnRemote({
      command: "node",
      args: [
        "-e",
        "process.stdin.on('data', d => { for (const l of String(d).split('\\n').filter(Boolean)) process.stdout.write('ack ' + l + '\\n') }); process.stdin.on('end', () => process.exit(0))",
      ],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    const output = collect(child);
    const done = exited(child);

    child.stdin.write("1\n");
    await waitFor(() => output().includes("ack 1"));

    // The sandbox side drops the socket; lines sent while it is down are kept.
    relay.dropConnection();
    child.stdin.write("2\n");
    child.stdin.write("3\n");
    await waitFor(() => output().includes("ack 3"));

    // The Mac side drops it too.
    client.dropConnection();
    child.stdin.write("4\n");
    await waitFor(() => output().includes("ack 4"));

    child.stdin.end();
    expect(await done).toBe(0);
    expect(output()).toBe("ack 1\nack 2\nack 3\nack 4\n");
    expect(client.connections).toBeGreaterThanOrEqual(3);
  });

  it("refuses a connection with the wrong bearer", async () => {
    const relay = await startRelay();
    const client = connect(relay, { token: "x".repeat(48) });
    await expect(client.waitUntilConnected(300)).rejects.toThrow("did not answer");
  });

  it("forwards sandbox HTTP to the Mac MCP endpoint and streams the answer", async () => {
    const mac = NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "mcp-session-id": "s1",
        });
        response.write(`data: ${request.headers.authorization} ${request.url}\n\n`);
        setTimeout(() => response.end(`data: ${body}\n\n`), 20);
      });
    });
    await new Promise<void>((resolve) => mac.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => mac.close(() => resolve())));
    const address = mac.address() as { port: number };

    const relay = await startRelay();
    const client = connect(relay, { mcpOrigin: `http://127.0.0.1:${address.port}` });
    await client.waitUntilConnected(5_000);

    const response = await fetch(`http://127.0.0.1:${relay.mcpPort()}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer mcp-cred", "content-type": "application/json" },
      body: '{"jsonrpc":"2.0"}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBe("s1");
    expect(await response.text()).toBe(
      'data: Bearer mcp-cred /mcp\n\ndata: {"jsonrpc":"2.0"}\n\n',
    );
  });
});
