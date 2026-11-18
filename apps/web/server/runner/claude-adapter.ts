import {
  query,
  type CanUseTool,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { ClaudeEventMapper, type ClaudeRawMessage } from "./claude-events";
import { spawnClaudeProcess, type ClaudeProcess } from "./claude-process";
import type {
  AgentEvent,
  ProviderAdapter,
  ProviderSession,
  ProviderStartOptions,
  SignInStatus,
} from "./contract";
import { agentEnvironment, findExecutable } from "./find-executable";
import { claudeContent, type UserTurn } from "./user-turn";

const CLAUDE_PATH_ENV = "BUSYBOY_CLAUDE_PATH";
const SIGN_IN_TIMEOUT_MS = 20_000;

class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
  private closed = false;

  push(turn: UserTurn) {
    if (this.closed) return;
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: claudeContent(turn) },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    };
    if (this.waiting) {
      this.waiting({ value: message, done: false });
      this.waiting = undefined;
    } else this.items.push(message);
  }

  close() {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
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

function startClaude(options: ProviderStartOptions): ProviderSession {
  const { emit } = options;
  const input = new MessageQueue();
  const abort = new AbortController();
  const mapper = new ClaudeEventMapper(emit);
  let current: Query | undefined;
  let cli: ClaudeProcess | undefined;
  let inTurn = false;
  let stopRequested = false;

  const canUseTool: CanUseTool = (_toolName, toolInput) =>
    Promise.resolve({ behavior: "allow", updatedInput: toolInput });

  const run = async () => {
    const executable = resolveClaude();
    if (!executable) {
      emit({
        type: "error",
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
        resume: options.resumeSessionId,
        permissionMode: "auto",
        systemPrompt: { type: "preset", preset: "claude_code", append: options.instructions },
        canUseTool,
        spawnClaudeCodeProcess: (spawnOptions) => (cli = spawnClaudeProcess(spawnOptions)),
      },
    });
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
      await current?.interrupt();
    },
    async stop() {
      stopRequested = true;
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
