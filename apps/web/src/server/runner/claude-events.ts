import { parseAskedQuestions } from "./asked-questions";
import type { AgentEvent } from "./contract";

export type ClaudeRawMessage = {
  type: string;
  subtype?: string;
  session_id?: string;
  error?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  terminal_reason?: string;
  api_error_status?: number | null;
  event?: {
    type?: string;
    index?: number;
    message?: { id?: string };
    content_block?: { type?: string; text?: string };
    delta?: { type?: string; text?: string };
  };
  message?: { id?: string; content?: unknown };
  parent_tool_use_id?: string | null;
  mcp_servers?: { name?: string; status?: string }[];
};

/*why: * A `canUseTool` call, as the adapter receives it and as recordings store it. */
export type ClaudePermissionRequest = {
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  description?: string;
  suggestions?: unknown[];
};

export const TEXT_DELTA_FLUSH_MS = 50;

const SIGNED_OUT_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed"]);
const LABEL_LIMIT = 80;
const CONTEXT_FULL =
  "Claude stopped: the conversation is longer than the model can read. Run /compact or start a new agent.";

const TERMINAL_REASONS: Record<string, string> = {
  api_error: "Claude gave up after repeated API errors.",
  malformed_tool_use_exhausted: "Claude gave up after repeated malformed tool calls.",
  budget_exhausted: "Claude stopped: the turn's token budget ran out.",
  structured_output_retry_exhausted: "Claude could not produce the requested structured output.",
  tool_deferred_unavailable:
    "Claude could not resume a deferred tool call because the tool is gone.",
  turn_setup_failed: "Claude could not start the turn.",
  blocking_limit: CONTEXT_FULL,
  prompt_too_long: CONTEXT_FULL,
  rapid_refill_breaker: "Claude stopped: the context filled up again right after compacting.",
  image_error: "Claude stopped: an image in the conversation could not be read.",
  model_error: "Claude stopped: the model returned an error.",
  max_turns: "Claude stopped: the turn reached its step limit.",
};

const INTERRUPTED_REASONS = new Set(["aborted_streaming", "aborted_tools"]);

function shorten(value: string) {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > LABEL_LIMIT ? `${line.slice(0, LABEL_LIMIT - 1)}…` : line;
}

export function claudeMcpStartupNotice(server: { name?: string; status?: string }) {
  const name = server.name?.trim();
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) return undefined;
  if (server.status === "failed") return `The MCP server ${name} failed to start.`;
  if (server.status === "needs-auth")
    return `The MCP server ${name} needs a login. Run \`claude mcp login ${name}\`.`;
  return undefined;
}

export function toolLabel(name: string, input: Record<string, unknown>) {
  const detail =
    input.command ??
    input.file_path ??
    input.path ??
    input.pattern ??
    input.url ??
    input.query ??
    input.description;
  return typeof detail === "string" && detail ? `${name}: ${shorten(detail)}` : name;
}

export function claudeResultError(message: ClaudeRawMessage): string | undefined {
  const reason = message.terminal_reason;
  if (reason && INTERRUPTED_REASONS.has(reason)) return undefined;
  const known = reason ? TERMINAL_REASONS[reason] : undefined;
  if (message.subtype === "success" && !message.is_error && !known) return undefined;
  if (message.api_error_status === 529) return "Claude is overloaded right now. Try again shortly.";
  if (message.api_error_status === 429) return "Claude hit its rate limit. Try again later.";
  const listed = message.errors?.find(
    (error) => typeof error === "string" && !error.startsWith("[ede_diagnostic]"),
  );
  if (reason === "api_error" && message.result?.trim().startsWith("API Error:"))
    return message.result.trim().slice(0, 500);
  if (known) return known;
  if (listed) return listed;
  if (message.subtype === "error_max_turns") return TERMINAL_REASONS.max_turns;
  if (message.subtype === "error_max_budget_usd")
    return "Claude stopped: the turn reached its spending limit.";
  return message.result?.trim() || "Claude ended the turn with an error.";
}

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
};

export class ClaudeEventMapper {
  private streamingMessageId: string | undefined;
  private streamingBlocks = new Map<number, string>();
  private streamedCount = new Map<string, number>();
  private completedCount = new Map<string, number>();
  private streamedText = new Map<string, string>();
  private pending = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private anonymous = 0;

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  push(message: ClaudeRawMessage) {
    if (message.parent_tool_use_id) return;
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          if (message.session_id) this.send({ type: "session", sessionId: message.session_id });
          for (const server of message.mcp_servers ?? []) {
            const notice = claudeMcpStartupNotice(server);
            if (notice) this.send({ type: "error", code: "provider", message: notice });
          }
        }
        return;
      case "stream_event":
        this.streamEvent(message.event ?? {});
        return;
      case "assistant":
        this.assistant(message);
        return;
      case "result": {
        const error = claudeResultError(message);
        if (error) this.send({ type: "error", code: "provider", message: error });
        const interrupted = Boolean(
          message.terminal_reason && INTERRUPTED_REASONS.has(message.terminal_reason),
        );
        this.send({ type: "turn-done", ...(interrupted ? { interrupted } : {}) });
        this.streamedText.clear();
        return;
      }
    }
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    this.pending = new Map();
    for (const [itemId, text] of pending) this.emit({ type: "text-delta", itemId, text });
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }

  private send(event: AgentEvent) {
    this.flush();
    this.emit(event);
  }

  private nextItemId(counts: Map<string, number>, messageId: string | undefined) {
    const key = messageId ?? `anonymous-${++this.anonymous}`;
    const index = counts.get(key) ?? 0;
    counts.set(key, index + 1);
    return `${key}:text:${index}`;
  }

  private streamEvent(event: NonNullable<ClaudeRawMessage["event"]>) {
    if (event.type === "message_start") {
      this.streamingMessageId = event.message?.id;
      this.streamingBlocks.clear();
      return;
    }
    if (
      event.type === "content_block_start" &&
      event.content_block?.type === "text" &&
      event.index !== undefined
    ) {
      const itemId = this.nextItemId(this.streamedCount, this.streamingMessageId);
      this.streamingBlocks.set(event.index, itemId);
      this.streamedText.set(itemId, "");
      this.append(itemId, event.content_block.text ?? "");
      return;
    }
    if (
      event.type === "content_block_delta" &&
      event.delta?.type === "text_delta" &&
      event.delta.text
    ) {
      const itemId = event.index === undefined ? undefined : this.streamingBlocks.get(event.index);
      if (itemId) this.append(itemId, event.delta.text);
    }
  }

  private append(itemId: string, text: string) {
    if (!text) return;
    this.streamedText.set(itemId, (this.streamedText.get(itemId) ?? "") + text);
    this.pending.set(itemId, (this.pending.get(itemId) ?? "") + text);
    this.timer ??= setTimeout(() => this.flush(), TEXT_DELTA_FLUSH_MS);
  }

  private assistant(message: ClaudeRawMessage) {
    if (message.error && SIGNED_OUT_ERRORS.has(message.error)) {
      this.send({
        type: "error",
        code: "signed-out",
        message: "Claude is not signed in. Run `claude` and use /login.",
      });
    }
    const blocks = Array.isArray(message.message?.content)
      ? (message.message.content as ContentBlock[])
      : [];
    for (const block of blocks) {
      if (block.type === "text") {
        const itemId = this.nextItemId(this.completedCount, message.message?.id);
        const streamed = this.streamedText.get(itemId);
        this.streamedText.delete(itemId);
        if (message.error || !block.text || block.text === streamed) continue;
        this.send({ type: "text", itemId, text: block.text });
      } else if (block.type === "tool_use" && block.name && block.name !== "AskUserQuestion") {
        this.send({ type: "tool", label: toolLabel(block.name, block.input ?? {}) });
      }
    }
  }
}

export function claudePermissionToEvent(
  requestId: string,
  request: ClaudePermissionRequest,
): Extract<AgentEvent, { type: "approval" | "question" }> {
  if (request.toolName === "AskUserQuestion") {
    const questions = parseAskedQuestions(request.input) ?? [
      {
        question: "Claude asked a question BusyBoy could not read. Reply with the answer.",
        multiSelect: false,
        options: [],
      },
    ];
    return { type: "question", requestId, questions };
  }
  return {
    type: "approval",
    requestId,
    title: request.title ?? `Allow ${toolLabel(request.toolName, request.input)}?`,
    detail: request.description,
    canAllowForSession: (request.suggestions?.length ?? 0) > 0,
  };
}
