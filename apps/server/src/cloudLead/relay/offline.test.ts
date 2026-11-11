// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Http from "node:http";
import * as Os from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  globalWebSocketFactory,
  RelayClient,
  type RelaySocket,
  type RelaySocketFactory,
} from "../RelayClient.ts";
import { startRelayServer, type RelayServerOptions } from "./server.ts";
import { OfflineRelay } from "./offline.ts";

/** The parts of a JSON-RPC answer these tests read. */
type RpcBody = {
  readonly result: {
    readonly isError: boolean;
    readonly content: ReadonlyArray<{ readonly text: string }>;
    readonly structuredContent: {
      readonly journalSeq: number;
      readonly childThreadId: string;
      readonly current: {
        readonly spec: {
          readonly todos: ReadonlyArray<{ readonly done: boolean }>;
          readonly criteria: ReadonlyArray<{ readonly evidence: unknown }>;
        };
      };
    };
    readonly protocolVersion: string;
    readonly tools: unknown;
  };
};

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
const waitFor = async (check: () => boolean) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 5_000) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const cuttableNetwork = () => {
  const state = { down: false, silent: false };
  const factory: RelaySocketFactory = (url) => {
    if (!state.down) {
      const socket = globalWebSocketFactory(url);
      const send = socket.send.bind(socket);
      Object.defineProperty(socket, "send", {
        value: (line: string) => {
          if (!state.silent) {
            send(line);
          }
        },
      });
      return socket;
    }
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
const setup = async (extra: Partial<RelayServerOptions> | undefined) => {
  const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), "offline-journey-"));
  cleanups.push(() => {
    Fs.rmSync(directory, { recursive: true, force: true });
  });
  let clock = 1_000;
  const calls: string[] = [];
  const options = {
    token: "t".repeat(48),
    port: 0,
    mcpPort: 0,
    host: "127.0.0.1",
    journalDir: directory,
    now: () => clock,
    offlineGraceMs: 100,
    askIdleStopMs: 100,
    tickMs: 60_000,
    log: () => {},
    fetch: (async (input: string | URL | Request) => {
      calls.push(String(input));
      return Response.json({ session: { startedAt: clock, timeout: 3_600_000 } });
    }) as typeof fetch,
    ...extra,
  };
  const relay = await startRelayServer(options);
  cleanups.push(() => relay.close());
  const network = cuttableNetwork();
  const control: Array<Record<string, unknown>> = [];
  const client = new RelayClient({
    url: `ws://127.0.0.1:${relay.port()}`,
    token: options.token,
    mcpEndpoint: "http://127.0.0.1:1/mcp",
    socketFactory: network.factory,
    reconnectDelayMs: () => 20,
    onControl: (message) => {
      control.push(message);
    },
  });
  cleanups.push(() => client.close());
  await client.waitUntilConnected(5_000);
  client.sendControl({
    op: "offline-kit",
    threads: [
      {
        tokenSha256: Crypto.createHash("sha256").update("lead-bearer").digest("hex"),
        threadId: "lead",
        taskId: "task",
        role: "lead",
      },
    ],
    processes: [],
    specs: {
      task: {
        key: "BU-136",
        current: {
          spec: {
            todos: [{ id: "todo", done: false }],
            criteria: [{ id: "criterion", evidence: null }],
          },
        },
      },
    },
    models: {
      task: {
        plan: { model: "fake", providerInstanceId: "claude" },
        review: { model: "review-model", providerInstanceId: "claude-review" },
      },
    },
    tools: [{ name: "task_spec_read" }],
  });
  client.sendControl({
    op: "credential",
    token: "project-token",
    sessionId: "sandbox",
    teamId: "team",
    projectId: "project",
    expiresAt: clock + 3_600_000,
  });
  await waitFor(() => Fs.existsSync(Path.join(directory, "kit.json")));
  const cut = async () => {
    network.state.down = true;
    client.dropConnection();
    relay.dropConnection();
    await waitFor(() => !client.connected);
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${relay.mcpPort()}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer lead-bearer" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    return ((await response.json()) as RpcBody).result;
  };
  const entries = () =>
    Fs.existsSync(Path.join(directory, "journal.jsonl"))
      ? Fs.readFileSync(Path.join(directory, "journal.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  return {
    relay,
    client,
    network,
    control,
    directory,
    options,
    calls,
    cut,
    call,
    entries,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

describe("sandbox keeps the lead working while the Mac sleeps", () => {
  it("keeps serving child bearers locally after the Mac reconnects", async () => {
    const f = await setup(undefined);
    const kit = JSON.parse(Fs.readFileSync(Path.join(f.directory, "kit.json"), "utf8"));
    f.client.sendControl({
      op: "offline-kit",
      ...kit,
      threads: [
        ...kit.threads,
        {
          tokenSha256: Crypto.createHash("sha256").update("child-token").digest("hex"),
          threadId: "offline-child:running",
          taskId: "task",
          role: "reviewer",
        },
      ],
    });
    await waitFor(
      () =>
        JSON.parse(Fs.readFileSync(Path.join(f.directory, "kit.json"), "utf8")).threads.length ===
        2,
    );
    await f.cut();
    f.network.state.down = false;
    await f.client.waitUntilConnected(5_000);
    const response = await fetch(`http://127.0.0.1:${f.relay.mcpPort()}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer child-token" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "task_review_set", arguments: { verdict: "pass" } },
      }),
    });
    expect(((await response.json()) as RpcBody).result.isError).toBe(false);
    expect(f.entries()[0].threadId).toBe("offline-child:running");
    // The Mac is connected, so it hears about the new entry now, not at the next reconnect.
    await waitFor(() =>
      f.control.some((message) => message.op === "journal-pending" && message.lastSeq === 1),
    );
  });

  it("refuses an offline task_delegate without a known role or a brief", async () => {
    const f = await setup(undefined);
    await f.cut();
    f.advance(101);
    const noRole = await f.call("task_delegate", { task: "Review it." });
    expect(noRole.isError).toBe(true);
    expect(noRole.content[0]!.text).toContain("role review, implement or fix");
    const noBrief = await f.call("task_delegate", { role: "review", task: " " });
    expect(noBrief.isError).toBe(true);
    expect(f.entries()).toEqual([]);
  });
  it("persists child credentials across kits and restarts, then removes them on completion", async () => {
    const f = await setup(undefined);
    const offline = new OfflineRelay(f.directory, () => 1_000);
    const macKit = structuredClone(offline.kit);
    offline.setKit({
      ...macKit,
      threads: [
        ...macKit.threads,
        {
          tokenSha256: Crypto.createHash("sha256").update("child-token").digest("hex"),
          threadId: "offline-child:test",
          taskId: "task",
          role: "reviewer",
        },
      ],
    });
    offline.setKit(macKit);
    const restarted = new OfflineRelay(f.directory, () => 1_000);
    expect(restarted.isOfflineChild("Bearer child-token")).toBe(true);
    restarted.removeChild("offline-child:test");
    expect(new OfflineRelay(f.directory, () => 1_000).isOfflineChild("Bearer child-token")).toBe(
      false,
    );
  });

  it("logs incomplete journal lines and preserves subsequent appends across restart", async () => {
    const f = await setup(undefined);
    Fs.writeFileSync(Path.join(f.directory, "journal.jsonl"), '{"seq":');
    const log = vi.fn<(line: string) => void>();
    const offline = new OfflineRelay(f.directory, () => 1_000, log);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Skipping invalid offline journal line"),
    );
    offline.append({ kind: "call", threadId: "lead", taskId: "task", tool: "ask_user" });
    expect(new OfflineRelay(f.directory, () => 1_000, log).entries).toHaveLength(1);
  });

  it("does not overlay applied mutations on a fresh spec snapshot", async () => {
    const f = await setup(undefined);
    await f.cut();
    f.advance(101);
    await f.call("task_todo_set", { todoId: "todo", done: true });
    f.network.state.down = false;
    await f.client.waitUntilConnected(5_000);
    f.client.sendControl({ op: "journal-applied", seq: 1 });
    await waitFor(() => Fs.existsSync(Path.join(f.directory, "applied.json")));
    f.client.sendControl({
      op: "offline-kit",
      ...JSON.parse(Fs.readFileSync(Path.join(f.directory, "kit.json"), "utf8")),
    });
    await f.cut();
    f.advance(101);
    expect((await f.call("task_spec_read", {})).structuredContent.current.spec.todos[0]!.done).toBe(
      false,
    );
  });

  it("ignores held MCP requests as activity while disconnected", async () => {
    const f = await setup(undefined);
    await f.cut();
    f.advance(101);
    const abort = new AbortController();
    const held = fetch(`http://127.0.0.1:${f.relay.mcpPort()}/mcp`, {
      method: "POST",
      signal: abort.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "unsupported" }),
    }).catch(() => undefined);
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await f.call("ask_user", { question: "Continue?" });
      f.advance(101);
      await f.relay.tick();
      expect(f.calls.filter((url) => url.includes("/stop?"))).toHaveLength(1);
    } finally {
      abort.abort();
      await held;
    }
  });

  it("times out offline children and removes their persisted credentials", async () => {
    const bin = Fs.mkdtempSync(Path.join(Os.tmpdir(), "offline-timeout-"));
    cleanups.push(() => Fs.rmSync(bin, { recursive: true, force: true }));
    const command = Path.join(bin, "claude");
    Fs.writeFileSync(
      command,
      `#!${process.execPath}\nprocess.stdin.resume();setInterval(()=>{},1000);\n`,
    );
    Fs.chmodSync(command, 0o755);
    const f = await setup({ claudeCommand: command, childTimeoutMs: 100 });
    await f.cut();
    f.advance(101);
    await f.call("task_delegate", { role: "review", task: "Wait" });
    await waitFor(() => f.entries().some((entry) => entry.kind === "child-finished"));
    expect(f.entries().at(-1).child.result).toBe("timed out");
    expect(
      JSON.parse(Fs.readFileSync(Path.join(f.directory, "kit.json"), "utf8")).threads,
    ).toHaveLength(1);
  });

  it("journals offline work, serves the updated spec, and replays only unapplied entries after restart", async () => {
    const f = await setup(undefined);
    await f.cut();
    f.advance(101);
    for (const [name, args] of [
      ["task_todo_set", { todoId: "todo", done: true }],
      ["task_update", { note: "continuing" }],
      ["link_pull_request", { url: "https://github.test/pull/1" }],
    ] as const) {
      expect((await f.call(name, args)).isError).toBe(false);
    }
    expect(f.entries().map((entry) => [entry.seq, entry.tool])).toEqual([
      [1, "task_todo_set"],
      [2, "task_update"],
      [3, "link_pull_request"],
    ]);
    const spec = (await f.call("task_spec_read", {})).structuredContent;
    expect(spec.current.spec.todos[0]!.done).toBe(true);
    expect((await f.call("task_create", {})).content[0]!.text).toContain("needs the Mac");
    expect((await f.call("task_update", { stage: "done" })).isError).toBe(true);
    expect(f.entries()).toHaveLength(3);
    f.network.state.down = false;
    await waitFor(() => f.client.connected);
    await waitFor(() => f.control.some((message) => message.op === "journal-pending"));
    f.client.sendControl({ op: "journal-applied", seq: 1 });
    f.client.sendControl({ op: "journal-read", rid: "read", after: 0 });
    await waitFor(() => f.control.some((message) => message.rid === "read"));
    expect(
      (f.control.find((message) => message.rid === "read")!.entries as Array<{ seq: number }>).map(
        (entry) => entry.seq,
      ),
    ).toEqual([2, 3]);
    f.client.close();
    await f.relay.close();
    const restarted = await startRelayServer(f.options);
    cleanups.push(() => restarted.close());
    f.advance(101);
    const response = await fetch(`http://127.0.0.1:${restarted.mcpPort()}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer lead-bearer" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "task_ready", arguments: {} },
      }),
    });
    expect(((await response.json()) as RpcBody).result.structuredContent.journalSeq).toBe(4);
    expect(JSON.parse(Fs.readFileSync(Path.join(f.directory, "applied.json"), "utf8")).seq).toBe(1);
  });

  it("forwards a request held during grace when the Mac returns, without journaling", async () => {
    const mac = Http.createServer((request, response) => {
      request.resume();
      request.on("end", () => response.end(JSON.stringify({ result: "Mac answer" })));
    });
    await new Promise<void>((resolve) => mac.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => mac.close(() => resolve())));
    const f = await setup(undefined);
    // A new client points to the fake Mac, retaining the same relay's kit.
    f.client.close();
    const client = new RelayClient({
      url: `ws://127.0.0.1:${f.relay.port()}`,
      token: f.options.token,
      mcpEndpoint: `http://127.0.0.1:${(mac.address() as { port: number }).port}/mcp`,
      socketFactory: f.network.factory,
      reconnectDelayMs: () => 20,
    });
    cleanups.push(() => client.close());
    await client.waitUntilConnected(5_000);
    f.network.state.down = true;
    client.dropConnection();
    f.relay.dropConnection();
    await waitFor(() => !client.connected);
    let answered = false;
    const answer = f.call("task_update", { note: "during grace" }).then((value) => {
      answered = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(answered).toBe(false);
    f.network.state.down = false;
    expect(await answer).toBe("Mac answer");
    expect(f.entries()).toHaveLength(0);
  });

  it("detects a silent link and serves authenticated MCP and offline evidence", async () => {
    const f = await setup({ linkStaleMs: 100 });
    f.network.state.silent = true;
    f.advance(201);
    const request = (method: string, body: unknown, bearer: string) =>
      fetch(`http://127.0.0.1:${f.relay.mcpPort()}/mcp`, {
        method,
        headers: { authorization: bearer },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
    const initialized = await request(
      "POST",
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      "Bearer lead-bearer",
    );
    expect(initialized.headers.get("mcp-session-id")?.length).toBeGreaterThan(0);
    expect(((await initialized.json()) as RpcBody).result.protocolVersion).toBe("2025-06-18");
    expect((await request("GET", null, "Bearer lead-bearer")).status).toBe(405);
    expect((await request("DELETE", null, "Bearer lead-bearer")).status).toBe(200);
    expect(
      (
        await request(
          "POST",
          { jsonrpc: "2.0", method: "notifications/initialized" },
          "Bearer lead-bearer",
        )
      ).status,
    ).toBe(202);
    expect(
      (await request("POST", { jsonrpc: "2.0", id: 2, method: "ping" }, "Bearer wrong")).status,
    ).toBe(401);
    expect(
      (await f.call("task_evidence_set", { criterionId: "criterion", evidence: "verified" }))
        .isError,
    ).toBe(false);
    expect(
      (await f.call("task_spec_read", {})).structuredContent.current.spec.criteria[0]!.evidence,
    ).toBe("verified");
    const listed = await request(
      "POST",
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      "Bearer lead-bearer",
    );
    expect(((await listed.json()) as RpcBody).result.tools).toEqual([{ name: "task_spec_read" }]);
  });

  it("runs an offline reviewer with its own MCP bearer and wakes the live lead with its result", async () => {
    const bin = Fs.mkdtempSync(Path.join(Os.tmpdir(), "offline-bin-"));
    cleanups.push(() => {
      Fs.rmSync(bin, { recursive: true, force: true });
    });
    const command = Path.join(bin, "claude");
    Fs.writeFileSync(
      command,
      `#!${process.execPath}\nconst fs = require('node:fs');\nlet input = ''; process.stdin.on('data', d => input += d); process.stdin.on('end', async () => {\nconst config = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--mcp-config')+1]));\nfs.writeFileSync(${JSON.stringify(Path.join(bin, "brief"))}, input);\nconst mcp = config.mcpServers['t3-code'];\nawait fetch(mcp.url, {method:'POST',headers:mcp.headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'task_review_set',arguments:{verdict:'pass'}}})});\nconsole.log(JSON.stringify({type:'result',result:'review passed'}));\n});\n`,
    );
    Fs.chmodSync(command, 0o755);
    const f = await setup({ claudeCommand: command });
    const wakeFile = Path.join(bin, "wake");
    const lead = f.client.spawnRemote({
      command: process.execPath,
      args: [
        "-e",
        `const fs=require('node:fs');process.stdin.on('data',d=>{fs.appendFileSync(${JSON.stringify(wakeFile)},d);console.log(JSON.stringify({type:'result',result:'idle'}))});console.log('ready')`,
      ],
      cwd: bin,
      env: { PATH: process.env.PATH ?? "" },
    });
    let output = "";
    lead.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    await waitFor(() => output.includes("ready"));
    const kit = JSON.parse(Fs.readFileSync(Path.join(f.directory, "kit.json"), "utf8"));
    f.client.sendControl({
      op: "offline-kit",
      ...kit,
      models: {
        ...kit.models,
        otherTask: { plan: { model: "wrong-task-model" }, review: { model: "wrong-task-model" } },
      },
      processes: [{ id: f.client.lastProcessId, threadId: "lead" }],
    });
    await waitFor(
      () =>
        JSON.parse(Fs.readFileSync(Path.join(f.directory, "kit.json"), "utf8")).processes.length ===
        1,
    );
    await f.cut();
    f.advance(101);
    const delegated = (
      await f.call("task_delegate", { role: "review", task: "Review the patch", title: "Review" })
    ).structuredContent;
    await waitFor(() => f.entries().some((entry) => entry.kind === "child-finished"));
    expect(f.entries().map((entry) => entry.kind)).toEqual([
      "child-started",
      "call",
      "child-finished",
    ]);
    expect(f.entries()[1].threadId).toBe(delegated.childThreadId);
    expect(f.entries()[0].child.model).toBe("review-model");
    expect(f.entries()[0].child.providerInstanceId).toBe("claude-review");
    expect(f.entries()[1].tool).toBe("task_review_set");
    expect(f.entries()[2].child.result).toBe("review passed");
    expect(f.entries()[2].child.exitCode).toBe(0);
    expect(JSON.parse(Fs.readFileSync(Path.join(bin, "brief"), "utf8")).message.content).toBe(
      "Act as the review sub-agent for this task.\n\nReview the patch",
    );
    await waitFor(() => Fs.existsSync(wakeFile));
    expect(JSON.parse(Fs.readFileSync(wakeFile, "utf8")).message.content).toContain(
      "Its result:\n\nreview passed",
    );
    expect(
      Fs.readFileSync(Path.join(f.directory, f.entries()[2].child.transcript), "utf8"),
    ).toContain('"type":"result"');
  });

  it("stops after ask_user once a live lead finishes its turn and stays idle", async () => {
    const f = await setup(undefined);
    const finishFile = Path.join(f.directory, "finish-turn");
    const lead = f.client.spawnRemote({
      command: process.execPath,
      args: [
        "-e",
        `const fs=require('node:fs'); process.stdin.resume(); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finishFile)})){clearInterval(timer);console.log(JSON.stringify({type:'result',result:'waiting'}));fs.writeFileSync(${JSON.stringify(finishFile + ".done")},'done')}},10); console.log('ready')`,
      ],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    let output = "";
    lead.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    await waitFor(() => output.includes("ready"));
    await f.cut();
    f.advance(101);
    expect((await f.call("ask_user", { question: "Continue?" })).content[0]!.text).toContain(
      "end your turn now",
    );
    f.advance(200);
    await f.relay.tick();
    expect(f.calls.filter((url) => url.includes("/stop?"))).toHaveLength(0);
    // Simulate the lead ending the turn from inside the sandbox after its tool reply.
    Fs.writeFileSync(finishFile, "finish");
    await waitFor(() => Fs.existsSync(`${finishFile}.done`));
    await new Promise((resolve) => setTimeout(resolve, 30));
    f.network.state.down = false;
    await f.client.waitUntilConnected(5_000);
    lead.stdin.write(
      JSON.stringify({ type: "control_request", request: { subtype: "interrupt" } }) + "\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await f.cut();
    f.advance(101);
    await f.relay.tick();
    expect(f.calls.filter((url) => url.includes("/stop?"))).toHaveLength(1);
    expect(lead.exitCode).toBeNull();
    expect(f.entries()[0].tool).toBe("ask_user");
  });
});
