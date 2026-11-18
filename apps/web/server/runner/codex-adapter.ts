import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import {
  spawnClaudeProcess as spawnProcessGroup,
  type ClaudeProcess as GroupProcess,
} from "./claude-process";
import {
  CODEX_ANSWERABLE_REQUESTS,
  codexAcceptForSession,
  codexAutoReply,
  CodexEventMapper,
  type CodexRawMessage,
} from "./codex-events";
import type {
  AgentEvent,
  ProviderAdapter,
  ProviderSession,
  ProviderStartOptions,
  SignInStatus,
} from "./contract";
import { agentEnvironment, findExecutable } from "./find-executable";
import { codexInput, type UserTurn } from "./user-turn";

const CODEX_PATH_ENV = "BUSYBOY_CODEX_PATH";
const SIGN_IN_TIMEOUT_MS = 20_000;
const ACCOUNT_CHECK_TIMEOUT_MS = 5_000;
const CLIENT_INFO = { name: "busyboy", title: "BusyBoy", version: "0.0.0" };
const CLOSE_WAIT_MS = 500;

function resolveCodex() {
  return process.env[CODEX_PATH_ENV] || findExecutable("codex");
}

const THREAD_SETTINGS = {
  approvalPolicy: "on-request",
  approvalsReviewer: "auto_review",
  sandbox: "workspace-write",
};

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void };

class AppServerExited extends Error {
  constructor() {
    super("The Codex app server exited.");
  }
}

class AppServerConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  readonly exited: Promise<{ code: number | null; stderr: string }>;

  constructor(
    private child: GroupProcess,
    onMessage: (message: CodexRawMessage) => void,
  ) {
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let message: CodexRawMessage & { result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.method === undefined && typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error)
          pending?.reject(new Error(message.error.message ?? "Codex request failed."));
        else pending?.resolve(message.result);
      } else if (message.method) onMessage(message);
    });
    this.exited = new Promise((resolve) => {
      let spawnError = "";
      const process = child as unknown as ChildProcess;
      process.on("error", (error) => {
        spawnError = error.message;
      });
      const done = (code: number | null) => {
        if (this.closed) return;
        this.closed = true;
        for (const [, pending] of this.pending) pending.reject(new AppServerExited());
        this.pending.clear();
        resolve({ code, stderr: [child.stderrTail(), spawnError].filter(Boolean).join("\n") });
      };
      process.on("close", done);
      process.on("exit", (code) => setTimeout(() => done(code), CLOSE_WAIT_MS).unref());
    });
  }

  private write(message: object) {
    if (!this.closed && this.child.stdin.writable)
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new AppServerExited());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: string | number, result: unknown) {
    this.write({ id, result });
  }

  respondError(id: string | number, message: string) {
    this.write({ id, error: { code: -32601, message } });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        requiredHumanApproval: true,
      },
    });
    this.notify("initialized");
  }

  async kill() {
    await this.child.stop();
    this.child.stdin.end();
  }
}

function spawnAppServer(
  executable: string,
  cwd: string,
  onMessage: (message: CodexRawMessage) => void,
) {
  const env = agentEnvironment() as NodeJS.ProcessEnv;
  const script = /\.[cm]?js$/i.test(executable);
  const command = script ? (findExecutable("node") ?? "node") : executable;
  const args = script ? [executable, "app-server"] : ["app-server"];
  const child = spawnProcessGroup({
    command,
    args,
    cwd,
    env,
    signal: new AbortController().signal,
  });
  return new AppServerConnection(child, onMessage);
}

function startCodex(options: ProviderStartOptions): ProviderSession {
  const { emit } = options;
  const queue: UserTurn[] = [];
  let connection: AppServerConnection | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let inTurn = false;
  let interruptPending = false;
  let pendingStart: object | undefined;
  let stopRequested = false;
  let failed = false;

  const fail = (message: string, code: "provider" | "lost-session" = "provider") => {
    if (failed || stopRequested) return;
    failed = true;
    emit({ type: "error", code, message });
  };

  const interruptTurn = () => {
    if (!connection || !threadId || !turnId) return;
    interruptPending = false;
    connection.request("turn/interrupt", { threadId, turnId }).catch(() => {});
  };

  const startNextTurn = () => {
    if (inTurn || !connection || !threadId) return;
    const turn = queue.shift();
    if (turn === undefined) return;
    inTurn = true;
    const request = {};
    pendingStart = request;
    connection
      .request<{ turn: { id: string } }>("turn/start", {
        threadId,
        input: codexInput(turn),
      })
      .then(({ turn }) => {
        if (pendingStart !== request) return;
        turnId ??= turn.id;
        if (interruptPending) interruptTurn();
      })
      .catch((error: Error) => {
        if (stopRequested || error instanceof AppServerExited) return;
        inTurn = false;
        interruptPending = false;
        emit({ type: "error", code: "provider", message: error.message });
        emit(queue.length > 0 ? { type: "turn-done", more: true } : { type: "turn-done" });
        startNextTurn();
      });
  };

  const onEvent = (event: AgentEvent) => {
    if (event.type === "turn-done") {
      pendingStart = undefined;
      inTurn = false;
      turnId = undefined;
      interruptPending = false;
      if (queue.length > 0) event = { ...event, more: true };
    }
    emit(event);
  };
  const mapper = new CodexEventMapper(onEvent);

  const onMessage = (message: CodexRawMessage) => {
    try {
      handleMessage(message);
    } catch (error) {
      if (message.id !== undefined)
        connection?.respondError(message.id, `BusyBoy could not read ${message.method}.`);
      mapper.flush();
      emit({
        type: "error",
        code: "provider",
        message: `BusyBoy could not read a Codex ${message.method} message: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  const handleMessage = (message: CodexRawMessage) => {
    if (message.id !== undefined) {
      const auto = codexAutoReply(message);
      if (auto) {
        connection?.respond(message.id, auto.result);
        mapper.flush();
        emit({ type: "error", code: "provider", message: auto.notice });
        return;
      }
      if (CODEX_ANSWERABLE_REQUESTS.has(message.method)) {
        connection?.respond(message.id, codexAcceptForSession(message));
        return;
      }
      connection?.respondError(message.id, `BusyBoy does not handle ${message.method}.`);
      return;
    }
    if (message.method === "serverRequest/resolved") return;
    const messageThread = message.params?.threadId;
    if (threadId && typeof messageThread === "string" && messageThread !== threadId) return;
    if (message.method === "turn/started") {
      const startedTurn = message.params?.turn as { id: string } | undefined;
      if (!startedTurn) throw new Error("Codex turn/started had no turn id.");
      turnId = startedTurn.id;
      if (interruptPending) interruptTurn();
    }
    mapper.push(message);
    if (message.method === "turn/completed") startNextTurn();
  };

  const run = async () => {
    const executable = resolveCodex();
    if (!executable) {
      emit({
        type: "error",
        message: "The `codex` command was not found on PATH.",
      });
      return false;
    }
    connection = spawnAppServer(executable, options.cwd, onMessage);
    const current = connection;
    if (stopRequested) void current.kill();
    const ready = (async () => {
      await current.initialize();
      const settings = {
        cwd: options.cwd,
        ...THREAD_SETTINGS,
        developerInstructions: options.instructions ?? null,
        config: {},
      };
      const [method, params] = options.resumeSessionId
        ? ["thread/resume", { threadId: options.resumeSessionId, excludeTurns: true, ...settings }]
        : ["thread/start", settings];
      const response = await current.request<{ thread: { id: string } }>(method, params);
      threadId = response.thread.id;
      emit({ type: "session", sessionId: threadId });
      startNextTurn();
    })();
    ready.catch(async (error: Error) => {
      if (error instanceof AppServerExited) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const status = await Promise.race([
        accountStatus(current).catch(() => undefined),
        new Promise<undefined>(
          (resolve) => (timer = setTimeout(() => resolve(undefined), ACCOUNT_CHECK_TIMEOUT_MS)),
        ),
      ]);
      clearTimeout(timer);
      if (status?.state === "signed-out") fail("Codex is not signed in. Run `codex login`.");
      else if (options.resumeSessionId && /no rollout found for thread id/i.test(error.message)) {
        fail(error.message, "lost-session");
      } else fail(error.message);
      void current.kill();
    });
    const { code, stderr } = await current.exited;
    mapper.flush();
    mapper.dispose();
    fail(stderr.trim() || `The Codex app server exited with code ${code}.`);
    return stopRequested && !inTurn && queue.length === 0;
  };

  run()
    .catch((error: unknown) => {
      fail(error instanceof Error ? error.message : String(error));
      return false;
    })
    .then((finished) => emit({ type: "stopped", finished }));

  return {
    send(turn) {
      queue.push(turn);
      startNextTurn();
    },
    async interrupt() {
      if (turnId) interruptTurn();
      else if (inTurn) interruptPending = true;
      else if (!threadId && queue.length > 0) {
        queue.length = 0;
        emit({ type: "turn-done" });
      }
    },
    async stop() {
      stopRequested = true;
      await connection?.kill();
    },
  };
}

async function accountStatus(connection: AppServerConnection): Promise<SignInStatus> {
  const { account, requiresOpenaiAuth } = await connection.request<{
    account: { type: string; email?: string | null } | null;
    requiresOpenaiAuth: boolean;
  }>("account/read", {});
  if (account) return { state: "signed-in", account: account.email ?? account.type };
  if (!requiresOpenaiAuth) return { state: "signed-in" };
  return { state: "signed-out", loginCommand: "codex login" };
}

async function codexSignInStatus(): Promise<SignInStatus> {
  const executable = resolveCodex();
  if (!executable)
    return { state: "not-installed", detail: "The `codex` command was not found on PATH." };
  const connection = spawnAppServer(executable, process.cwd(), () => {});
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      connection
        .initialize()
        .then(() => accountStatus(connection))
        .catch(async (error: Error): Promise<SignInStatus> => {
          const stderr =
            error instanceof AppServerExited ? (await connection.exited).stderr.trim() : "";
          return { state: "unknown", detail: stderr || error.message };
        }),
      new Promise<SignInStatus>((resolve) => {
        timeout = setTimeout(
          () => resolve({ state: "unknown", detail: "Codex did not report its account in time." }),
          SIGN_IN_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    void connection.kill();
  }
}

export const codexAdapter: ProviderAdapter = {
  start: startCodex,
  signInStatus: codexSignInStatus,
};
