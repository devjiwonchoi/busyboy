// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
/**
 * The relay that runs inside a cloud lead's sandbox (`node relay/server.ts`).
 *
 * One public port takes a single WebSocket from the Mac, authenticated by the
 * sandbox's random bearer in the first message. Over it the relay:
 * - runs the claude CLI and carries its stdin and stdout (channel "proc"), and
 * - forwards HTTP sent to 127.0.0.1:<mcp port> to the Mac's t3-code MCP
 *   endpoint (channel "http"), so the Mac server is never exposed.
 * Messages go through RelaySession, so a dropped WebSocket loses nothing.
 *
 * The relay also keeps its own sandbox alive without the Mac (channel "ctl"):
 * the Mac hands it a credential that reaches only this sandbox project, and
 * the relay extends the sandbox while work runs and stops it (a persistent
 * sandbox keeps its files) once nothing has run for the idle window.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { OfflineRelay, type OfflineKit, type OfflineThread } from "./offline.ts";
import { RelaySession, type RelayLink, type RelayMessage } from "./session.ts";
import { acceptWebSocket } from "./wsServer.ts";

export interface RelayServerOptions {
  readonly token: string;
  readonly port: number;
  readonly mcpPort: number;
  readonly host?: string;
  /** Nothing running for this long stops the sandbox. */
  readonly idleStopMs?: number;
  /** How often the relay looks at its sandbox's time left and idleness. */
  readonly tickMs?: number;
  /** Extend when less than this is left, by extendByMs. */
  readonly extendMarginMs?: number;
  readonly extendByMs?: number;
  /** Tests pass a fake clock and a fake Vercel API. */
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
  readonly log?: (line: string) => void;
  /** Where the relay keeps its children's process ids. */
  readonly pidsFile?: string;
  readonly linkStaleMs?: number;
  readonly offlineGraceMs?: number;
  readonly askIdleStopMs?: number;
  readonly journalDir?: string;
  readonly claudeCommand?: string;
  readonly childTimeoutMs?: number;
}

export interface RelayServer {
  readonly close: () => Promise<void>;
  /** Drops the current WebSocket, as a flaky network would. For tests. */
  readonly dropConnection: () => void;
  readonly port: () => number;
  readonly mcpPort: () => number;
  /** Runs one lifecycle check now. For tests. */
  readonly tick: () => Promise<void>;
}

/**
 * What the Mac sends on channel "ctl" (op "credential"): a project-scoped
 * Vercel token and this sandbox's session. Kept in memory only.
 */
export interface RelayCredential {
  readonly token: string;
  readonly sessionId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly apiBase?: string;
  /** When the session stops unless extended, in epoch ms. */
  readonly expiresAt?: number;
}

const AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_STOP_MS = 30 * 60 * 1000;
const DEFAULT_TICK_MS = 60 * 1000;
const DEFAULT_EXTEND_MARGIN_MS = 15 * 60 * 1000;
const DEFAULT_EXTEND_BY_MS = 30 * 60 * 1000;
const DEFAULT_API_BASE = "https://vercel.com/api";

const tokensMatch = (expected: string, given: unknown): boolean => {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};

export const startRelayServer = async (options: RelayServerOptions): Promise<RelayServer> => {
  const children = new Map<
    string,
    {
      readonly child: NodeChildProcess.ChildProcess;
      readonly cmd: string;
      readonly startedAt: number;
      readonly cwd: string;
      busy: boolean;
      /** Started by the relay itself while the Mac was away; never handed to a Mac. */
      readonly offline?: boolean;
    }
  >();
  const pendingHttp = new Map<string, NodeHttp.ServerResponse>();
  let currentLink: (RelayLink & { readonly drop: () => void }) | null = null;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const offline = new OfflineRelay(
    options.journalDir ?? NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "busyboy-relay-")),
    now,
    log,
  );
  let lastHeardAt = now();
  let downSince: number | null = now();
  let recentEnv: NodeJS.ProcessEnv = {};
  const heldHttp = new Map<string, RelayMessage>();
  const linkDown = () => {
    const down = currentLink === null || now() - lastHeardAt >= (options.linkStaleMs ?? 15_000);
    if (down && downSince === null) {
      downSince = currentLink === null ? now() : lastHeardAt + (options.linkStaleMs ?? 15_000);
    } else if (!down) {
      downSince = null;
    }
    return down;
  };
  /**
   * Process groups of running children, so a Mac that finds this relay dead
   * can end exactly them (they outlive the relay) before resuming their work.
   */
  const pidsFile = options.pidsFile;
  const savePids = () => {
    if (pidsFile === undefined) return;
    const pids = [...children.values()].flatMap(({ child }) =>
      child.pid === undefined ? [] : [child.pid],
    );
    try {
      NodeFs.writeFileSync(pidsFile, JSON.stringify(pids));
    } catch {}
  };

  // One session per Mac process: a reconnect keeps it (and replays), a hello
  // with a new sid means the Mac restarted, so the relay starts a new one.
  const newSession = () => new RelaySession({ onMessage: (message) => handle(message) });
  let session: RelaySession = newSession();
  // An offline child can finish after the Mac is back: tell it there is work to apply.
  offline.onAppend = () => {
    if (!linkDown()) {
      session.send({
        ch: "ctl",
        op: "journal-pending",
        lastSeq: offline.lastSeq,
        appliedSeq: offline.appliedSeq,
      });
    }
  };
  let peerSid: string | undefined;

  let credential: RelayCredential | null = null;
  let expiresAt: number | null = null;
  let lastActivity = now();
  let stopped = false;

  const killGroup = (child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
  };

  const handleProc = (message: RelayMessage) => {
    const id = String(message.id);
    if (message.op === "spawn") {
      const child = NodeChildProcess.spawn(String(message.cmd), message.args as string[], {
        cwd: message.cwd as string,
        // The sandbox's own environment (PATH, HOME) under what the Mac sent.
        env: { ...process.env, ...(message.env as NodeJS.ProcessEnv) },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      recentEnv = message.env as NodeJS.ProcessEnv;
      const entry = {
        child,
        cmd: String(message.cmd),
        startedAt: now(),
        cwd: String(message.cwd),
        busy: true,
      };
      children.set(id, entry);
      savePids();
      lastActivity = now();
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const lines = stdout.split("\n");
        stdout = lines.pop()!;
        for (const line of lines) {
          let value;
          try {
            value = JSON.parse(line);
          } catch {
            continue;
          }
          if (value.type === "result") {
            entry.busy = false;
            lastActivity = now();
          }
        }
        session.send({ ch: "proc", op: "stdout", id, data: chunk.toString("base64") });
      });
      child.stderr?.on("data", (chunk: Buffer) =>
        session.send({ ch: "proc", op: "stderr", id, data: chunk.toString("base64") }),
      );
      child.stdin?.on("error", () => {});
      // Exit goes out exactly once, after stdout and stderr are drained ("close",
      // not "exit"), and also when the process could not start at all.
      let finished = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (finished) return;
        finished = true;
        children.delete(id);
        savePids();
        lastActivity = now();
        session.send({ ch: "proc", op: "exit", id, code, signal });
        killGroup(child, "SIGKILL");
      };
      child.on("error", (error) => {
        session.send({ ch: "proc", op: "error", id, message: error.message });
        if (child.pid === undefined) finish(1, null);
      });
      child.on("close", (code, signal) => finish(code, signal));
      return;
    }
    const child = children.get(id)?.child;
    if (child === undefined) return;
    if (message.op === "stdin") {
      const chunk = Buffer.from(String(message.data), "base64");
      if (
        chunk
          .toString()
          .split("\n")
          .some((line) => {
            try {
              return JSON.parse(line).type === "user";
            } catch {
              return false;
            }
          })
      ) {
        children.get(id)!.busy = true;
      }
      child.stdin?.write(chunk);
    } else if (message.op === "end") child.stdin?.end();
    else if (message.op === "kill")
      killGroup(child, (message.signal as NodeJS.Signals) ?? "SIGTERM");
  };

  const handleHttp = (message: RelayMessage) => {
    const response = pendingHttp.get(String(message.id));
    if (response === undefined) return;
    if (message.op === "head") {
      response.writeHead(Number(message.status), message.headers as NodeHttp.OutgoingHttpHeaders);
      response.flushHeaders();
    } else if (message.op === "chunk") {
      response.write(Buffer.from(String(message.data), "base64"));
    } else if (message.op === "end" || message.op === "error") {
      pendingHttp.delete(String(message.id));
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  };

  const handleCtl = (message: RelayMessage) => {
    if (message.op === "offline-kit") {
      offline.setKit(message as unknown as OfflineKit);
      return;
    }
    if (message.op === "journal-read") {
      session.send({
        ch: "ctl",
        op: "journal",
        rid: message.rid,
        entries: offline.entries.filter(
          (entry) => entry.seq > Math.max(Number(message.after) || 0, offline.appliedSeq),
        ),
      });
      return;
    }
    if (message.op === "journal-applied") {
      offline.applied(Number(message.seq));
      return;
    }
    if (message.op !== "credential") return;
    const next = message as unknown as RelayCredential & { readonly ch: string };
    if (typeof next.token !== "string" || typeof next.sessionId !== "string") return;
    // A new session (the sandbox was resumed) starts its own clock.
    if (credential?.sessionId !== next.sessionId) expiresAt = null;
    credential = {
      token: next.token,
      sessionId: next.sessionId,
      teamId: String(next.teamId),
      projectId: String(next.projectId),
      ...(typeof next.apiBase === "string" ? { apiBase: next.apiBase } : {}),
    };
    // The Mac's view of the deadline is only a starting point; extend answers keep it current.
    if (expiresAt === null && typeof next.expiresAt === "number") expiresAt = next.expiresAt;
  };

  const handle = (message: RelayMessage) => {
    // Credential refreshes are not work: an idle sandbox stops even with the Mac connected.
    if (message.ch !== "ctl") lastActivity = now();
    if (message.ch === "proc") handleProc(message);
    else if (message.ch === "http") handleHttp(message);
    else if (message.ch === "ctl") handleCtl(message);
  };

  // Offline children use the same process groups and idle accounting as Mac spawns.
  const delegate = (thread: OfflineThread, args: Record<string, unknown>) => {
    if (args.role !== "review" && args.role !== "implement" && args.role !== "fix") {
      return "task_delegate needs role review, implement or fix.";
    }
    if (typeof args.task !== "string" || args.task.trim() === "") {
      return "task_delegate needs a task brief.";
    }
    const models = offline.kit.models[thread.taskId];
    // A step not on Claude falls back to the plan model, as cloud tasks do on the Mac.
    const model = models?.[args.role] ?? models?.plan;
    if (model == null) {
      return "No Claude model is set for this task, so task_delegate can't run while the Mac is offline. Continue without it.";
    }
    const id = NodeCrypto.randomUUID();
    const claudeSessionId = NodeCrypto.randomUUID();
    const bearer = NodeCrypto.randomBytes(32).toString("hex");
    const childThreadId = `offline-child:${id}`;
    offline.kit.threads.push({
      tokenSha256: NodeCrypto.createHash("sha256").update(bearer).digest("hex"),
      threadId: childThreadId,
      taskId: thread.taskId,
      role: args.role === "review" ? "reviewer" : "child",
    });
    offline.setKit(offline.kit);
    const directory = NodePath.join(offline.directory, "children");
    NodeFs.mkdirSync(directory, { recursive: true });
    const config = NodePath.join(directory, `${id}.mcp.json`);
    NodeFs.writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          "t3-code": {
            type: "http",
            url: `http://127.0.0.1:${mcpPort}/mcp`,
            headers: { Authorization: `Bearer ${bearer}` },
          },
        },
      }),
    );
    const leadThreadId =
      thread.role === "lead"
        ? thread.threadId
        : (offline.kit.threads.find((item) => item.taskId === thread.taskId && item.role === "lead")
            ?.threadId ?? thread.threadId);
    const lead = [...offline.kit.processes]
      .reverse()
      .map((proc) => (proc.threadId === leadThreadId ? children.get(proc.id) : undefined))
      .find((proc) => proc !== undefined);
    const command = options.claudeCommand ?? "claude";
    const child = NodeChildProcess.spawn(
      command,
      [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        model.model,
        "--session-id",
        claudeSessionId,
        "--mcp-config",
        config,
        "--permission-mode",
        "bypassPermissions",
      ],
      {
        cwd: lead?.cwd ?? process.cwd(),
        env: { ...process.env, ...recentEnv },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.set(id, {
      child,
      cmd: command,
      startedAt: now(),
      cwd: lead?.cwd ?? process.cwd(),
      busy: true,
      offline: true,
    });
    savePids();
    const seq = offline.append({
      kind: "child-started",
      threadId: thread.threadId,
      taskId: thread.taskId,
      child: {
        id,
        role: args.role,
        task: args.task,
        title: args.title,
        model: model.model,
        providerInstanceId: model.providerInstanceId,
        claudeSessionId,
        leadThreadId,
      },
    });
    let result = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(
      () => {
        timedOut = true;
        killGroup(child, "SIGTERM");
        killTimer = setTimeout(() => killGroup(child, "SIGKILL"), 10_000);
        killTimer.unref();
      },
      options.childTimeoutMs ?? 2 * 60 * 60 * 1000,
    );
    timeout.unref();
    let buffer = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      NodeFs.appendFileSync(NodePath.join(directory, `${id}.jsonl`), chunk);
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (value.type === "result") {
          result = String(value.result ?? "");
        }
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => log(`offline child ${id}: ${chunk.toString()}`));
    child.stdin!.on("error", (error) => log(`offline child ${id} stdin: ${error.message}`));
    child.on("error", (error) => {
      result = error.message;
      log(`offline child ${id}: ${error.message}`);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (timedOut) {
        result = "timed out";
      }
      children.delete(id);
      offline.removeChild(childThreadId);
      savePids();
      lastActivity = now();
      offline.append({
        kind: "child-finished",
        threadId: childThreadId,
        taskId: thread.taskId,
        child: {
          id,
          role: args.role,
          claudeSessionId,
          result,
          exitCode,
          transcript: `children/${id}.jsonl`,
        },
      });
      const live = [...offline.kit.processes]
        .reverse()
        .map((proc) => (proc.threadId === leadThreadId ? children.get(proc.id) : undefined))
        .find((proc) => proc !== undefined);
      if (live) {
        live.busy = true;
        live.child.stdin?.write(
          userLine(
            `Delegated task ${childThreadId} (${args.role}) finished while the Mac was offline. Its result:\n\n${result}`,
          ),
        );
      }
      killGroup(child, "SIGKILL");
    });
    child.stdin!.end(
      userLine(
        `Act as the ${args.role === "review" ? "review" : "implementation"} sub-agent for this task.\n\n${args.task}`,
      ),
    );
    return {
      offline: true,
      childThreadId,
      journalSeq: seq,
      note: "Started in the sandbox while the Mac is offline. Its result arrives as a message when it finishes.",
    };
  };
  const userLine = (content: string) =>
    `${JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid: NodeCrypto.randomUUID() })}\n`;

  const flushHeld = () => {
    const down = linkDown();
    for (const [id, message] of heldHttp) {
      const response = pendingHttp.get(id);
      if (!response) {
        heldHttp.delete(id);
        continue;
      }
      if (!down) {
        heldHttp.delete(id);
        session.send(message);
      } else if (now() - downSince! >= (options.offlineGraceMs ?? 60_000)) {
        if (
          offline.serve(
            message as unknown as Parameters<OfflineRelay["serve"]>[0],
            response,
            delegate,
          )
        ) {
          heldHttp.delete(id);
          pendingHttp.delete(id);
          lastActivity = now();
        }
      }
    }
  };

  /** Calls the sandbox API for this session with the project-scoped credential. */
  const callSandbox = async (action: "extend-timeout" | "stop", body?: unknown) => {
    const current = credential!;
    const url = new URL(
      `${current.apiBase ?? DEFAULT_API_BASE}/v2/sandboxes/sessions/${encodeURIComponent(current.sessionId)}/${action}`,
    );
    url.searchParams.set("teamId", current.teamId);
    url.searchParams.set("projectId", current.projectId);
    const response = await (options.fetch ?? globalThis.fetch)(url.toString(), {
      method: "POST",
      headers: { Authorization: `Bearer ${current.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${action} answered ${response.status}`);
    return (await response.json().catch(() => ({}))) as {
      session?: { startedAt?: number; timeout?: number };
    };
  };

  let ticking = false;
  const tick = async () => {
    flushHeld();
    if (ticking || stopped || credential === null) return;
    ticking = true;
    try {
      const at = now();
      if (
        [...children.values()].some((entry) => entry.busy) ||
        (!linkDown() && pendingHttp.size > 0)
      )
        lastActivity = at;
      const idleStopMs =
        offline.pendingAsk && linkDown()
          ? (options.askIdleStopMs ?? 120_000)
          : (options.idleStopMs ?? DEFAULT_IDLE_STOP_MS);
      if (at - lastActivity >= idleStopMs) {
        log(`relay idle for ${Math.round((at - lastActivity) / 1000)}s; stopping the sandbox`);
        await callSandbox("stop");
        stopped = true;
        return;
      }
      if (
        expiresAt === null ||
        expiresAt - at < (options.extendMarginMs ?? DEFAULT_EXTEND_MARGIN_MS)
      ) {
        const result = await callSandbox("extend-timeout", {
          duration: options.extendByMs ?? DEFAULT_EXTEND_BY_MS,
        });
        const started = result.session?.startedAt;
        const timeout = result.session?.timeout;
        expiresAt =
          typeof started === "number" && typeof timeout === "number"
            ? started + timeout
            : at + (options.extendByMs ?? DEFAULT_EXTEND_BY_MS);
        log(`relay extended the sandbox to ${new Date(expiresAt).toISOString()}`);
      }
    } catch (error) {
      log(
        `relay lifecycle check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      ticking = false;
    }
  };
  const lifecycleTimer = setInterval(() => void tick(), options.tickMs ?? DEFAULT_TICK_MS);
  lifecycleTimer.unref();

  const routeTimer = setInterval(flushHeld, 100);
  routeTimer.unref();
  const ackTimer = setInterval(() => session.ack(), 1_000);
  ackTimer.unref();

  const publicServer = NodeHttp.createServer((request, response) => {
    response.writeHead(request.url === "/health" ? 200 : 404).end();
  });
  publicServer.on("upgrade", (request, socket, head) => {
    const ws = acceptWebSocket(request, socket as never, head);
    if (ws === null) return;
    let authed = false;
    const link = {
      send: (line: string) => ws.send(line),
      close: () => ws.close(),
      drop: () => (socket as { destroy: () => void }).destroy(),
    };
    const authTimer = setTimeout(() => {
      if (!authed) ws.close();
    }, AUTH_TIMEOUT_MS);
    ws.onMessage = (line) => {
      if (!authed) {
        let frame: { t?: unknown; token?: unknown; sid?: unknown };
        try {
          frame = JSON.parse(line) as typeof frame;
        } catch {
          return ws.close();
        }
        if (frame.t !== "hello" || !tokensMatch(options.token, frame.token)) return ws.close();
        authed = true;
        clearTimeout(authTimer);
        currentLink = link;
        lastHeardAt = now();
        downSince = null;
        const sid = typeof frame.sid === "string" ? frame.sid : undefined;
        const restarted = sid !== peerSid;
        if (restarted) {
          // The old Mac session is gone with what it had not acknowledged.
          session = newSession();
          peerSid = sid;
        }
        session.attach(link);
        try {
          session.receive(link, line);
        } catch {
          return ws.close();
        }
        // Processes a restarted Mac did not start, so it can take them over.
        if (restarted) {
          session.send({
            ch: "ctl",
            op: "procs",
            list: [...children]
              .filter(([, entry]) => entry.offline !== true)
              .map(([id, entry]) => ({
                id,
                cmd: entry.cmd,
                startedAt: entry.startedAt,
              })),
          });
        }
        if (offline.lastSeq > offline.appliedSeq) {
          session.send({
            ch: "ctl",
            op: "journal-pending",
            lastSeq: offline.lastSeq,
            appliedSeq: offline.appliedSeq,
          });
        }
        flushHeld();
        return;
      }
      lastHeardAt = now();
      downSince = null;
      try {
        session.receive(link, line);
        flushHeld();
      } catch {
        ws.close();
      }
    };
    ws.onClose = () => {
      clearTimeout(authTimer);
      if (currentLink === link) {
        currentLink = null;
        downSince ??= now();
      }
      session.detach(link);
    };
  });

  let nextRequest = 0;
  const mcpServer = NodeHttp.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const id = `r${++nextRequest}`;
      pendingHttp.set(id, response);
      const message = {
        ch: "http",
        op: "request",
        id,
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("base64"),
      };
      if (offline.isOfflineChild(request.headers.authorization)) {
        if (offline.serve(message, response, delegate)) {
          pendingHttp.delete(id);
        } else {
          response.writeHead(400).end();
          pendingHttp.delete(id);
        }
      } else if (linkDown()) {
        heldHttp.set(id, message);
        flushHeld();
      } else {
        // Already-forwarded requests stay with the Mac and finish after replay.
        session.send(message);
      }
      response.on("close", () => {
        const held = heldHttp.delete(id);
        if (pendingHttp.delete(id) && !held) session.send({ ch: "http", op: "abort", id });
      });
    });
  });

  const listen = (server: NodeHttp.Server, port: number, host: string) =>
    new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : port);
      });
    });

  const port = await listen(publicServer, options.port, options.host ?? "0.0.0.0");
  const mcpPort = await listen(mcpServer, options.mcpPort, "127.0.0.1");

  return {
    port: () => port,
    mcpPort: () => mcpPort,
    dropConnection: () => currentLink?.drop(),
    tick,
    close: async () => {
      clearInterval(ackTimer);
      clearInterval(routeTimer);
      for (const response of pendingHttp.values()) {
        response.destroy();
      }
      clearInterval(lifecycleTimer);
      for (const { child } of children.values()) killGroup(child, "SIGKILL");
      currentLink?.close();
      await Promise.all(
        [publicServer, mcpServer].map(
          (server) => new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
    },
  };
};

const isEntry = process.argv[1]?.endsWith("relay/server.ts") === true;
if (isEntry) {
  const token = process.env.BUSYBOY_RELAY_TOKEN;
  if (token === undefined || token.length < 32) {
    process.stderr.write("BUSYBOY_RELAY_TOKEN is missing.\n");
    process.exit(2);
  }
  // Children must not inherit the bearer.
  delete process.env.BUSYBOY_RELAY_TOKEN;
  void startRelayServer({
    token,
    port: Number(process.env.BUSYBOY_RELAY_PORT ?? "8787"),
    mcpPort: Number(process.env.BUSYBOY_RELAY_MCP_PORT ?? "8788"),
    pidsFile: new URL("./children.json", import.meta.url).pathname,
    journalDir: new URL("./journal/", import.meta.url).pathname,
    claudeCommand: process.env.BUSYBOY_RELAY_CLAUDE ?? "claude",
    ...(process.env.BUSYBOY_RELAY_IDLE_STOP_MS === undefined
      ? {}
      : { idleStopMs: Number(process.env.BUSYBOY_RELAY_IDLE_STOP_MS) }),
  }).then((server) => {
    process.stdout.write(`relay listening on ${server.port()} (mcp ${server.mcpPort()})\n`);
  });
}
