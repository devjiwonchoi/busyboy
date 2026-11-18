import {
  query,
  type CanUseTool,
  type McpServerConfig,
  type Options,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { ClaudeEventMapper, type ClaudeRawMessage } from "./claude-events";
import { spawnClaudeProcess, type ClaudeProcess } from "./claude-process";
import type {
  AgentAnswer,
  AgentEvent,
  McpServer,
  ProviderAdapter,
  ProviderSession,
  ProviderStartOptions,
  SignInStatus,
} from "./contract";
import { agentEnvironment, findExecutable } from "./find-executable";
import { claudeContent, modelText, type UserTurn } from "./user-turn";

export const CLAUDE_PATH_ENV = "BUSYBOY_CLAUDE_PATH";
const SIGN_IN_TIMEOUT_MS = 20_000;

class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
  private closed = false;
  private held = true;

  push(turn: UserTurn) {
    if (this.closed) return;
    const content = claudeContent(turn);
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: content.length > 0 ? content : modelText(turn) },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    };
    if (this.waiting && !this.held) {
      this.waiting({ value: message, done: false });
      this.waiting = undefined;
    } else this.items.push(message);
  }

  get isHeld() {
    return this.held;
  }

  release() {
    this.held = false;
    const item = this.waiting && this.items.shift();
    if (item) {
      this.waiting!({ value: item, done: false });
      this.waiting = undefined;
    }
  }

  clear() {
    this.items = [];
  }

  close() {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.held ? undefined : this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

function resolveClaude() {
  return process.env[CLAUDE_PATH_ENV] || findExecutable("claude");
}

function toSdkMcpServers(servers: Record<string, McpServer>): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      server.type === "stdio"
        ? { type: "stdio", command: server.command, args: server.args, env: server.env }
        : { type: server.type, url: server.url, headers: server.headers },
    ]),
  );
}

// why: forkSession copies the history and persistSession: false writes no file for the branch.
function sessionOptions({
  resumeSessionId,
  forkSessionId,
}: ProviderStartOptions): Partial<Options> {
  if (forkSessionId) return { resume: forkSessionId, forkSession: true, persistSession: false };
  return { resume: resumeSessionId };
}

// why: tools: [] leaves the user's MCP servers loaded. Verified with CLI 2.1.311.
const NO_TOOLS: Partial<Options> = {
  tools: [],
  strictMcpConfig: true,
  disallowedTools: ["mcp__*"],
};

function startClaude(options: ProviderStartOptions): ProviderSession {
  const { emit } = options;
  const input = new MessageQueue();
  const abort = new AbortController();
  const mapper = new ClaudeEventMapper(emit);
  let current: Query | undefined;
  let cli: ClaudeProcess | undefined;
  let inTurn = false;
  let stopRequested = false;

  // why: Auto mode still calls canUseTool for a call it would ask about. Allow it so the harness keeps its own auto mode.
  const canUseTool: CanUseTool = (_toolName, toolInput) =>
    Promise.resolve({ behavior: "allow", updatedInput: toolInput });

  const registerMcpServers = async (run: Query) => {
    try {
      if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
        try {
          await run.initializationResult();
        } catch {
          return;
        }
        const result = await run.setMcpServers(toSdkMcpServers(options.mcpServers));
        const failed = Object.keys(result.errors);
        if (failed.length > 0) {
          emit({
            type: "error",
            code: "provider",
            message: `These MCP servers could not start: ${failed.join(", ")}.`,
          });
        }
      }
    } catch {
      if (!stopRequested) {
        const names = Object.keys(options.mcpServers ?? {}).join(", ");
        emit({
          type: "error",
          code: "provider",
          message: `These MCP servers could not be added: ${names}.`,
        });
      }
    } finally {
      input.release();
    }
  };

  const run = async () => {
    const executable = resolveClaude();
    if (!executable) {
      emit({
        type: "error",
        code: "not-installed",
        message: "The `claude` command was not found on PATH.",
      });
      return false;
    }
    current = query({
      prompt: input,
      options: {
        cwd: options.cwd,
        pathToClaudeCodeExecutable: executable,
        env: agentEnvironment(),
        abortController: abort,
        includePartialMessages: true,
        ...sessionOptions(options),
        ...(options.noTools ? NO_TOOLS : {}),
        permissionMode: options.noTools
          ? "dontAsk"
          : options.permissionMode === "full-access"
            ? "bypassPermissions"
            : "auto",
        allowDangerouslySkipPermissions: options.permissionMode === "full-access",
        systemPrompt: { type: "preset", preset: "claude_code", append: options.instructions },
        canUseTool,
        allowedTools: Object.entries(options.mcpServers ?? {})
          .filter(([, server]) => server.trusted)
          .map(([name]) => `mcp__${name}`),
        spawnClaudeCodeProcess: (spawnOptions) => (cli = spawnClaudeProcess(spawnOptions)),
      },
    });
    void registerMcpServers(current);
    for await (const message of current) {
      if (message.type === "result") inTurn = false;
      mapper.push(message as ClaudeRawMessage);
    }
    return !inTurn;
  };

  run()
    .catch((error: unknown) => {
      if (stopRequested) return !inTurn;
      mapper.flush();
      const message = error instanceof Error ? error.message : String(error);
      const stderr = cli?.stderrTail();
      emit({
        type: "error",
        code: "provider",
        message: stderr ? `${message}\n${stderr}` : message,
      });
      return false;
    })
    .then((finished) => {
      mapper.flush();
      mapper.dispose();
      void cli?.stop();
      emit({ type: "stopped", finished } satisfies AgentEvent);
    });

  return {
    send(turn) {
      inTurn = true;
      input.push(turn);
    },
    async interrupt() {
      if (!input.isHeld) {
        await current?.interrupt();
        return;
      }
      input.clear();
      if (inTurn) {
        inTurn = false;
        emit({ type: "turn-done" });
      }
    },
    async compact() {
      inTurn = true;
      input.push({ text: "/compact", note: "", images: [] });
    },
    answer(_requestId, _answer: AgentAnswer) {},
    async stop() {
      stopRequested = true;
      // why: Ends the commands the CLI detached while they are still its descendants,
      // why: then the CLI's own process group (see claude-process.ts).
      await cli?.stop();
      input.close();
      abort.abort();
    },
  };
}

async function claudeSignInStatus(): Promise<SignInStatus> {
  const executable = resolveClaude();
  if (!executable)
    return { state: "not-installed", detail: "The `claude` command was not found on PATH." };
  const abort = new AbortController();
  let cli: ClaudeProcess | undefined;
  const idle: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise((resolve) =>
          abort.signal.addEventListener("abort", () => resolve({ value: undefined, done: true }), {
            once: true,
          }),
        ),
    }),
  };
  const timeout = setTimeout(() => abort.abort(), SIGN_IN_TIMEOUT_MS);
  try {
    const probe = query({
      prompt: idle,
      options: {
        pathToClaudeCodeExecutable: executable,
        env: agentEnvironment(),
        abortController: abort,
        spawnClaudeCodeProcess: (spawnOptions) => (cli = spawnClaudeProcess(spawnOptions)),
      },
    });
    const { account } = await probe.initializationResult();
    if (account.apiProvider && account.apiProvider !== "firstParty")
      return { state: "signed-in", account: account.apiProvider };
    const hasKey = Boolean(account.apiKeySource) && account.apiKeySource !== "none";
    const hasToken = Boolean(account.tokenSource) && account.tokenSource !== "none";
    if (hasToken || hasKey || account.email) {
      return { state: "signed-in", account: account.email ?? account.organization };
    }
    return { state: "signed-out", loginCommand: "claude /login" };
  } catch (error) {
    return { state: "unknown", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
    abort.abort();
    await cli?.stop();
  }
}

export const claudeAdapter: ProviderAdapter = {
  start: startClaude,
  signInStatus: claudeSignInStatus,
};
