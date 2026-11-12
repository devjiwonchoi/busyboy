// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
import * as NodeHttp from "node:http";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  globalWebSocketFactory,
  RelayClient,
  type RelaySocket,
  type RelaySocketFactory,
  type RemoteProcess,
} from "./RelayClient.ts";
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

const connect = (
  relay: RelayServer,
  options: {
    token?: string;
    mcpEndpoint?: string;
    giveUpAfterMs?: number;
    onGiveUp?: () => void;
  } = {},
) => {
  const client = new RelayClient({
    url: `ws://127.0.0.1:${relay.port()}`,
    token: options.token ?? TOKEN,
    mcpEndpoint: options.mcpEndpoint ?? "http://127.0.0.1:1/mcp",
    ...(options.giveUpAfterMs === undefined ? {} : { giveUpAfterMs: options.giveUpAfterMs }),
    ...(options.onGiveUp === undefined ? {} : { onGiveUp: options.onGiveUp }),
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
  new Promise<number | null>((resolve) =>
    child.once("exit", (code: number | null) => resolve(code)),
  );

describe("RelayClient", () => {
  it("matches concurrent control responses by request id", async () => {
    const relay = await startRelay();
    const client = connect(relay);
    await client.waitUntilConnected(5_000);
    const [first, second] = await Promise.all([
      client.requestControl({ op: "journal-read", after: 0 }),
      client.requestControl({ op: "journal-read", after: 10 }),
    ]);
    expect(first.op).toBe("journal");
    expect(second.op).toBe("journal");
    expect(first.entries).toEqual([]);
    expect(second.entries).toEqual([]);
    expect(first.rid === second.rid).toBe(false);
  });

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
    const client = connect(relay, { mcpEndpoint: `http://127.0.0.1:${address.port}/mcp` });
    await client.waitUntilConnected(5_000);

    const response = await fetch(`http://127.0.0.1:${relay.mcpPort()}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer mcp-cred", "content-type": "application/json" },
      body: '{"jsonrpc":"2.0"}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBe("s1");
    expect(await response.text()).toBe('data: Bearer mcp-cred /mcp\n\ndata: {"jsonrpc":"2.0"}\n\n');
  });

  it("refuses sandbox requests to Mac routes other than the MCP endpoint", async () => {
    const seen: string[] = [];
    const mac = NodeHttp.createServer((request, response) => {
      seen.push(request.url ?? "");
      response.writeHead(200).end("ok");
    });
    await new Promise<void>((resolve) => mac.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => mac.close(() => resolve())));
    const address = mac.address() as { port: number };
    const relay = await startRelay();
    const client = connect(relay, { mcpEndpoint: `http://127.0.0.1:${address.port}/mcp` });
    await client.waitUntilConnected(5_000);

    for (const path of ["/api/orchestration/shell", "/mcpx", "/mcp/../api/auth/session"]) {
      const response = await fetch(`http://127.0.0.1:${relay.mcpPort()}${path}`);
      expect(response.status).toBe(403);
    }
    expect((await fetch(`http://127.0.0.1:${relay.mcpPort()}/mcp`)).status).toBe(200);
    expect(seen).toEqual(["/mcp"]);
  });

  it("ends a remote process that could not start", async () => {
    const relay = await startRelay();
    const client = connect(relay);
    await client.waitUntilConnected(5_000);
    const child = client.spawnRemote({
      command: "definitely-not-a-command",
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(await exited(child)).toBe(1);
  });

  it("gives up on a relay that stays unreachable, ending its processes", async () => {
    const relay = await startRelay();
    let gaveUp = false;
    const client = connect(relay, { giveUpAfterMs: 200, onGiveUp: () => (gaveUp = true) });
    await client.waitUntilConnected(5_000);
    const child = client.spawnRemote({
      command: "sleep",
      args: ["30"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    const done = exited(child);
    await relay.close();
    expect(await done).toBe(1);
    expect(gaveUp).toBe(true);
  });
});

/** A WebSocket factory whose network can be cut: while down, every connect fails. */
const cuttableNetwork = () => {
  const state = { down: false };
  const factory: RelaySocketFactory = (url) => {
    if (!state.down) return globalWebSocketFactory(url);
    const socket: RelaySocket = {
      send: () => {},
      close: () => {},
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    setTimeout(() => socket.onerror?.(new Error("network is down")), 5);
    return socket;
  };
  return { state, factory };
};

describe("RelayClient across a long outage", () => {
  it("keeps retrying a live sandbox for more than 2 minutes and catches up output and MCP requests in order", async () => {
    const mac = NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => response.writeHead(200).end(`answer ${body}`));
    });
    await new Promise<void>((resolve) => mac.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => mac.close(() => resolve())));
    const address = mac.address() as { port: number };

    const relay = await startRelay();
    const network = cuttableNetwork();
    let clock = 0;
    let aliveChecks = 0;
    let gaveUp = false;
    const client = new RelayClient({
      url: `ws://127.0.0.1:${relay.port()}`,
      token: TOKEN,
      mcpEndpoint: `http://127.0.0.1:${address.port}/mcp`,
      socketFactory: network.factory,
      reconnectDelayMs: () => 20,
      now: () => clock,
      isAlive: async () => {
        aliveChecks += 1;
        return true;
      },
      onGiveUp: () => (gaveUp = true),
    });
    cleanups.push(() => client.close());
    await client.waitUntilConnected(5_000);

    // claude's stream: 200 numbered lines, written while the Mac is away.
    const child = client.spawnRemote({
      command: "node",
      args: [
        "-e",
        "process.stdin.once('data', () => { for (let i = 1; i <= 200; i++) process.stdout.write('line ' + i + '\\n') }); process.stdin.on('end', () => process.exit(0))",
      ],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    const output = collect(child);
    const done = exited(child);
    child.stdin.write("go\n");
    await waitFor(() => output().includes("line 1\n"));

    // The Mac sleeps: the network is cut for three minutes.
    network.state.down = true;
    relay.dropConnection();
    client.dropConnection();
    await waitFor(() => !client.connected);
    await new Promise((resolve) => setTimeout(resolve, 50));
    clock += 3 * 60 * 1000;
    // A tool call from the sandbox to the Mac MCP endpoint, made during the outage.
    const mcpAnswer = fetch(`http://127.0.0.1:${relay.mcpPort()}/mcp`, {
      method: "POST",
      body: "tool-call",
    }).then((response) => response.text());
    await waitFor(() => aliveChecks > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(gaveUp).toBe(false);
    expect(client.connected).toBe(false);

    // The Mac wakes: everything buffered arrives, complete and in order.
    network.state.down = false;
    await waitFor(() => output().includes("line 200\n"));
    expect(output()).toBe(
      Array.from({ length: 200 }, (_, index) => `line ${index + 1}\n`).join(""),
    );
    expect(await mcpAnswer).toBe("answer tool-call");
    child.stdin.end();
    expect(await done).toBe(0);
    expect(gaveUp).toBe(false);
  });

  it("gives up once the sandbox is no longer running", async () => {
    const relay = await startRelay();
    const network = cuttableNetwork();
    let clock = 0;
    let gaveUp = false;
    const client = new RelayClient({
      url: `ws://127.0.0.1:${relay.port()}`,
      token: TOKEN,
      mcpEndpoint: "http://127.0.0.1:1/mcp",
      socketFactory: network.factory,
      reconnectDelayMs: () => 20,
      now: () => clock,
      isAlive: async () => false,
      onGiveUp: () => (gaveUp = true),
    });
    cleanups.push(() => client.close());
    await client.waitUntilConnected(5_000);
    const child = client.spawnRemote({
      command: "sleep",
      args: ["30"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    const done = exited(child);
    network.state.down = true;
    client.dropConnection();
    await waitFor(() => !client.connected);
    await new Promise((resolve) => setTimeout(resolve, 50));
    clock += 3 * 60 * 1000;
    expect(await done).toBe(1);
    expect(gaveUp).toBe(true);
  });
});

describe("relay after a Mac restart", () => {
  it("tells a new Mac session which processes are still running and lets it finish them", async () => {
    const relay = await startRelay();
    const before = connect(relay);
    await before.waitUntilConnected(5_000);
    const child = before.spawnRemote({
      command: "node",
      args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(7))"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    const id = before.lastProcessId;
    expect(child.exitCode).toBeNull();
    // The Mac server stops without ending its processes.
    before.close();

    const lists: Array<ReadonlyArray<{ id: string }>> = [];
    const after = new RelayClient({
      url: `ws://127.0.0.1:${relay.port()}`,
      token: TOKEN,
      mcpEndpoint: "http://127.0.0.1:1/mcp",
      reconnectDelayMs: () => 20,
      onControl: (message) => {
        if (message.op === "procs") lists.push(message.list as Array<{ id: string }>);
      },
    });
    cleanups.push(() => after.close());
    await after.waitUntilConnected(5_000);
    await waitFor(() => lists.length > 0);
    expect(lists[0]!.map((entry) => entry.id)).toEqual([id]);
    expect(id.startsWith(`${after.sid}:`)).toBe(false);

    const adopted = after.adopt(id);
    const done = exited(adopted);
    adopted.stdin.end();
    expect(await done).toBe(7);
  });
});

describe("relay leftovers that end early", () => {
  it("keeps the exit of a leftover process that ends before anyone takes it over", async () => {
    const relay = await startRelay();
    const before = connect(relay);
    await before.waitUntilConnected(5_000);
    before.spawnRemote({
      command: "node",
      args: ["-e", "setTimeout(() => process.exit(3), 400)"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    const id = before.lastProcessId;
    before.close();

    let listed = false;
    const after = new RelayClient({
      url: `ws://127.0.0.1:${relay.port()}`,
      token: TOKEN,
      mcpEndpoint: "http://127.0.0.1:1/mcp",
      reconnectDelayMs: () => 20,
      onControl: (message) => {
        if (message.op === "procs")
          listed = (message.list as Array<{ id: string }>).some((entry) => entry.id === id);
      },
    });
    cleanups.push(() => after.close());
    await waitFor(() => listed);
    // Its exit arrives before the runtime takes it over.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(after.adopt(id).exitCode).not.toBeNull();
  });
});

describe("relay keeping its own sandbox", () => {
  it("extends its sandbox while work runs with no Mac connected, then stops it once idle", async () => {
    const calls: Array<{ url: string; auth: string | null; body: string | null }> = [];
    let clock = 1_000_000;
    const relay = await startRelayServer({
      token: TOKEN,
      port: 0,
      mcpPort: 0,
      host: "127.0.0.1",
      now: () => clock,
      tickMs: 60 * 60 * 1000,
      idleStopMs: 30 * 60 * 1000,
      extendMarginMs: 15 * 60 * 1000,
      extendByMs: 30 * 60 * 1000,
      log: () => {},
      fetch: (async (input: string | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          auth: new Headers(init?.headers).get("authorization"),
          body: typeof init?.body === "string" ? init.body : null,
        });
        return new Response(
          JSON.stringify({ session: { startedAt: clock, timeout: 30 * 60 * 1000 } }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    cleanups.push(() => relay.close());
    const client = connect(relay);
    await client.waitUntilConnected(5_000);
    client.sendControl({
      op: "credential",
      token: "oidc-project-token",
      sessionId: "sess_1",
      teamId: "team_jiwonchoi",
      projectId: "prj_busyboy",
      apiBase: "https://vercel.test/api",
      expiresAt: clock + 10 * 60 * 1000,
    });
    // A claude turn that runs on after the Mac goes away; it prints its env first.
    const child = client.spawnRemote({
      command: "node",
      args: [
        "-e",
        "process.stdout.write(JSON.stringify(process.env) + '\\n'); setTimeout(() => {}, 1500)",
      ],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    const output = collect(child);
    await waitFor(() => output().includes("\n"));
    expect(output()).not.toContain("oidc-project-token");
    expect(output()).not.toContain(TOKEN);
    client.close();

    // Mac gone, work running, 10 minutes left: the relay extends on its own.
    await relay.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://vercel.test/api/v2/sandboxes/sessions/sess_1/extend-timeout?teamId=team_jiwonchoi&projectId=prj_busyboy",
    );
    expect(calls[0]!.auth).toBe("Bearer oidc-project-token");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ duration: 30 * 60 * 1000 });

    // Twenty minutes later the work still runs and time runs short again.
    clock += 20 * 60 * 1000;
    await relay.tick();
    expect(calls.map((call) => call.url.split("/").at(-1)!.split("?")[0])).toEqual([
      "extend-timeout",
      "extend-timeout",
    ]);

    // The work ends; nothing runs for the idle window, so the relay stops its sandbox.
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    clock += 29 * 60 * 1000;
    await relay.tick();
    expect(calls.at(-1)!.url).toContain("extend-timeout");
    clock += 2 * 60 * 1000;
    await relay.tick();
    expect(calls.at(-1)!.url).toBe(
      "https://vercel.test/api/v2/sandboxes/sessions/sess_1/stop?teamId=team_jiwonchoi&projectId=prj_busyboy",
    );
    const count = calls.length;
    clock += 60 * 60 * 1000;
    await relay.tick();
    expect(calls).toHaveLength(count);
  });
});
