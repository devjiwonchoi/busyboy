import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";

import {
  query,
  type CanUseTool,
  type HookCallback,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { alwaysAskApproval, createAllowedCalls, matchAlwaysAsk } from "./always-ask";
import { ClaudeEventMapper, claudePermissionToEvent, type ClaudeRawMessage } from "./claude-events";
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
import { checkUserRules, userRuleApproval, userRulesHookNeeded } from "./user-rules";
import { claudeContent, modelText, type UserTurn } from "./user-turn";

export const CLAUDE_PATH_ENV = "BUSYBOY_CLAUDE_PATH";
const SIGN_IN_TIMEOUT_MS = 20_000;
const ALWAYS_ASK_TIMEOUT_S = 24 * 60 * 60;

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

type OpenRequest = {
  input: Record<string, unknown>;
  // Remembering a suggestion that grants more than this request would leave the agent in a different permission mode.
  sessionPermissions: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
};

function permissionResult(answer: AgentAnswer, request: OpenRequest): PermissionResult {
  if (answer.kind === "question")
    return { behavior: "allow", updatedInput: { ...request.input, answers: answer.answers } };
  if (!answer.allow)
    return { behavior: "deny", message: answer.message || "The user declined this action." };
  const forSession = answer.forSession && request.sessionPermissions.length > 0;
  return {
    behavior: "allow",
    updatedInput: request.input,
    ...(forSession ? { updatedPermissions: request.sessionPermissions } : {}),
  };
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

// forkSession copies the history and persistSession: false writes no file for the branch.
function sessionOptions({
  resumeSessionId,
  forkSessionId,
}: ProviderStartOptions): Partial<Options> {
  if (forkSessionId) return { resume: forkSessionId, forkSession: true, persistSession: false };
  return { resume: resumeSessionId };
}

// tools: [] leaves the user's MCP servers loaded. Verified with CLI 2.1.311.
const NO_TOOLS: Partial<Options> = {
  tools: [],
  strictMcpConfig: true,
  disallowedTools: ["mcp__*"],
};

function startClaude(options: ProviderStartOptions): ProviderSession {
  const { emit } = options;
  const input = new MessageQueue();
  const abort = new AbortController();
  const requests = new Map<string, OpenRequest>();
  const mapper = new ClaudeEventMapper(emit);
  let current: Query | undefined;
  let cli: ClaudeProcess | undefined;
  let inTurn = false;
  let stopRequested = false;
  const asks = new Map<string, (answer: AgentAnswer | null) => void>();
  const allowedCalls = createAllowedCalls();

  // Auto mode calls canUseTool only for calls it would ask about itself.
  const waitForApproval = (
    requestId: string,
    event: Extract<AgentEvent, { type: "approval" }>,
    signal: AbortSignal,
  ) =>
    new Promise<AgentAnswer | null>((resolve) => {
      const onAbort = () => {
        asks.delete(requestId);
        resolve(null);
        emit({ type: "answered", requestId });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      asks.set(requestId, (value) => {
        signal.removeEventListener("abort", onAbort);
        asks.delete(requestId);
        resolve(value);
      });
      mapper.flush();
      emit(event);
    });

  const deny = (reason: string) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  });

  const alwaysAsk: HookCallback = async (hookInput, toolUseID, { signal }) => {
    if (hookInput.hook_event_name !== "PreToolUse") {
      return {};
    }
    const { tool_name: toolName, tool_input: toolInput } = hookInput;
    const cwd = hookInput.cwd || options.cwd;
    const userRule = await checkUserRules({
      rulesFolder: options.rulesFolder,
      toolName,
      input: toolInput,
      cwd,
      recordFolder: options.recordFolder,
    });
    if (userRule.ask) {
      const call = { toolName, input: toolInput, rule: userRule.ruleKey, cwd };
      if (!(userRule.remember && allowedCalls.has(call))) {
        const requestId = `user-rule-${toolUseID ?? randomUUID()}`;
        const answer = await waitForApproval(
          requestId,
          userRuleApproval({
            requestId,
            toolName,
            input: toolInput,
            detail: userRule.detail,
            remember: userRule.remember,
          }),
          signal,
        );
        const allowed = answer?.kind === "approval" && answer.allow;
        if (allowed && answer.forSession && userRule.remember) allowedCalls.add(call);
        if (!allowed)
          return deny(
            (answer?.kind === "approval" && answer.message) || "The user declined this action.",
          );
      }
    }
    const rule = matchAlwaysAsk({
      rules: options.alwaysAsk ?? [],
      toolName,
      input: toolInput,
      folder: options.cwd,
      recordFolder: options.recordFolder,
      privateFolder: options.privateFolder,
      noFileEdits: options.noFileEdits,
    });
    if (!rule) {
      return {};
    }
    const call = { toolName, input: toolInput, rule, cwd };
    if (allowedCalls.has(call)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: "The user approved this exact action before.",
        },
      };
    }

    const requestId = `always-ask-${toolUseID ?? randomUUID()}`;
    const answer = await waitForApproval(
      requestId,
      alwaysAskApproval({ requestId, toolName, input: toolInput, rule }),
      signal,
    );
    const allowed = answer?.kind === "approval" && answer.allow;
    if (allowed && answer.forSession) allowedCalls.add(call);
    const declined =
      (answer?.kind === "approval" && answer.message) || "The user declined this action.";
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: allowed ? "allow" : "deny",
        permissionDecisionReason: allowed ? "The user approved this action." : declined,
      },
    };
  };

  const canUseTool: CanUseTool = (
    toolName,
    toolInput,
    { signal, toolUseID, title, description, suggestions, suppressAlwaysAllowRule },
  ) => {
    const requestId = toolUseID || randomUUID();
    return new Promise<PermissionResult>((resolve) => {
      const onAbort = () => {
        requests.delete(requestId);
        resolve({ behavior: "deny", message: "The request was cancelled." });
        emit({ type: "answered", requestId });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const sessionPermissions = suppressAlwaysAllowRule
        ? []
        : (suggestions ?? [])
            .filter(
              (suggestion) =>
                suggestion.type === "addRules" || suggestion.type === "addDirectories",
            )
            .map((suggestion) => ({ ...suggestion, destination: "session" as const }));
      requests.set(requestId, {
        input: toolInput,
        sessionPermissions,
        resolve: (result) => {
          signal.removeEventListener("abort", onAbort);
          requests.delete(requestId);
          resolve(result);
        },
      });
      mapper.flush();
      emit(
        claudePermissionToEvent(requestId, {
          toolName,
          input: toolInput,
          title,
          description,
          suggestions: sessionPermissions,
        }),
      );
    });
  };

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
        hooks:
          (options.alwaysAsk?.length ||
            options.privateFolder ||
            options.noFileEdits ||
            userRulesHookNeeded(options.rulesFolder)) &&
          !options.noTools
            ? {
                PreToolUse: [
                  { hooks: [alwaysAsk], timeout: ALWAYS_ASK_TIMEOUT_S, onFailure: "block" },
                ],
              }
            : undefined,
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
      const open = [...requests.entries()];
      for (const [requestId, request] of open) {
        request.resolve({ behavior: "deny", message: "The user interrupted.", interrupt: true });
        emit({ type: "answered", requestId });
      }
      for (const [requestId, resolve] of asks.entries()) {
        resolve(null);
        emit({ type: "answered", requestId });
      }
      if (open.length > 0) return;
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
    answer(requestId, answer) {
      asks.get(requestId)?.(answer);
      const request = requests.get(requestId);
      request?.resolve(permissionResult(answer, request));
    },
    async stop() {
      stopRequested = true;
      // Ends the commands the CLI detached while they are still its descendants,
      // then the CLI's own process group (see claude-process.ts).
      await cli?.stop();
      input.close();
      abort.abort();
    },
  };
}

// claude update only updates the native install, and a Homebrew cask can lag the SDK.
function updateCommandFor(executable: string) {
  let resolved = executable;
  try {
    resolved = realpathSync(executable);
  } catch {
    // Keep the path as found on PATH.
  }
  return resolved.includes("/Caskroom/claude-code/") ? "claude install latest" : "claude update";
}

async function claudeSignInStatus(): Promise<SignInStatus> {
  const executable = resolveClaude();
  if (!executable)
    return { state: "not-installed", detail: "The `claude` command was not found on PATH." };
  const abort = new AbortController();
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
      },
    });
    const { account, hook_on_failure_supported, claude_code_version } =
      await probe.initializationResult();
    // A CLI that predates onFailure: block would let an always-ask failure run the action.
    if (hook_on_failure_supported !== true) {
      const version = claude_code_version ? ` ${claude_code_version}` : "";
      return {
        state: "outdated",
        detail: `Claude Code${version} is too old to keep the always-ask list. Update it the way you installed it, then choose Check again.`,
        updateCommand: updateCommandFor(executable),
      };
    }
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
  }
}

export const claudeAdapter: ProviderAdapter = {
  start: startClaude,
  signInStatus: claudeSignInStatus,
};
