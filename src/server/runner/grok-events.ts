import { TEXT_DELTA_FLUSH_MS, toolLabel } from "./claude-events";
// why: The always-ask list is written for Claude and Codex tool names. Grok names tools differently.
import type { AgentEvent } from "./contract";

export type GrokPermissionOption = { optionId: string; name?: string; kind?: string };

const SHELL_NAMES = new Set([
  "bash",
  "shell",
  "exec_command",
  "local_shell",
  "unified_exec",
  "run_terminal_command",
  "terminal",
]);

function text(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toolMeta(toolCall: Record<string, unknown>) {
  return record(record(toolCall._meta)["x.ai/tool"]);
}

// why: Shell calls become Bash and file calls become Write or Edit, which is what the list reads.
export function grokToolSubject(toolCall: Record<string, unknown>) {
  const meta = toolMeta(toolCall);
  const raw = record(toolCall.rawInput ?? toolCall.raw_input ?? meta.input);
  const variant = text(raw.variant) ?? "";
  const name = (text(toolCall.name) ?? text(meta.name) ?? variant) || "tool";
  const title = text(toolCall.title) ?? name;
  const command = text(raw.command);
  const shell =
    SHELL_NAMES.has(name.toLowerCase()) ||
    variant.toLowerCase() === "bash" ||
    (toolCall.kind === "execute" && command !== undefined);
  if (shell) return { toolName: "Bash", input: { command: command ?? "" }, title };
  const path = text(raw.path) ?? text(raw.file_path) ?? text(raw.filePath);
  const edit =
    toolCall.kind === "edit" || /write|edit|search_replace|apply_patch/i.test(`${name} ${variant}`);
  if (edit && path) {
    const toolName = /edit|search_replace|apply_patch/i.test(`${name} ${variant}`)
      ? "Edit"
      : "Write";
    return { toolName, input: { ...raw, file_path: path }, title };
  }
  const namespace = text(meta.namespace);
  const toolName = namespace && namespace !== "grok_build" ? `mcp__${namespace}__${name}` : name;
  return { toolName, input: raw, title };
}

export function grokTrustedTool(toolCall: Record<string, unknown>, trusted: ReadonlySet<string>) {
  const namespace = text(toolMeta(toolCall).namespace);
  if (namespace && trusted.has(namespace)) return true;
  const name = text(toolCall.name) ?? "";
  for (const server of trusted) {
    if (name === server || name.startsWith(`mcp__${server}__`) || name.startsWith(`${server}__`))
      return true;
  }
  return false;
}

export function grokPermissionOutcome(
  options: readonly GrokPermissionOption[],
  decision: "allow" | "allow-session" | "deny" | "cancel",
) {
  if (decision === "cancel") return { outcome: { outcome: "cancelled" as const } };
  const preferred =
    decision === "deny"
      ? "reject_once"
      : decision === "allow-session"
        ? "allow_always"
        : "allow_once";
  const fallback = decision === "deny" ? "reject_always" : "allow_once";
  const option =
    options.find((entry) => entry.kind === preferred) ??
    options.find((entry) => entry.kind === fallback) ??
    options.find((entry) =>
      decision === "deny" ? entry.kind?.startsWith("reject") : entry.kind?.startsWith("allow"),
    );
  if (!option) return { outcome: { outcome: "cancelled" as const } };
  return { outcome: { outcome: "selected" as const, optionId: option.optionId } };
}

export function grokCanAllowForSession(options: readonly GrokPermissionOption[]) {
  return options.some((entry) => entry.kind === "allow_always");
}

function toolUpdate(update: Record<string, unknown>) {
  return {
    ...update,
    toolCallId: update.toolCallId ?? update.tool_call_id,
    rawInput: update.rawInput ?? update.raw_input,
    name: update.name,
    title: update.title,
    kind: update.kind,
    _meta: update._meta,
  };
}

export class GrokEventMapper {
  private itemId: string | undefined;
  private pending = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tools = new Set<string>();
  private turn = 0;

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  beginTurn() {
    this.turn += 1;
    this.itemId = undefined;
    this.pending = "";
  }

  pushUpdate(update: Record<string, unknown>) {
    const kind = update.sessionUpdate ?? update.session_update;
    if (kind === "agent_message_chunk") {
      const content = record(update.content);
      const chunk = content.type === "text" ? (text(content.text) ?? "") : "";
      if (!chunk) return;
      const id = text(update.messageId) ?? text(update.message_id) ?? `grok-text-${this.turn}`;
      if (this.itemId && this.itemId !== id) this.flush();
      this.itemId = id;
      this.pending += chunk;
      this.timer ??= setTimeout(() => this.flush(), TEXT_DELTA_FLUSH_MS);
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      this.flush();
      const call = toolUpdate(update);
      const id = text(call.toolCallId);
      if (!id || this.tools.has(id)) return;
      const subject = grokToolSubject(call);
      if (!subject.toolName) return;
      this.tools.add(id);
      this.emit({ type: "tool", label: toolLabel(subject.toolName, subject.input) });
    }
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.itemId || !this.pending) return;
    this.emit({ type: "text-delta", itemId: this.itemId, text: this.pending });
    this.pending = "";
  }

  endTurn() {
    this.flush();
    this.itemId = undefined;
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export function grokStopMessage(stopReason: string) {
  switch (stopReason) {
    case "max_tokens":
      return "Grok stopped: the reply reached its length limit.";
    case "max_turn_requests":
      return "Grok stopped: the turn reached its step limit.";
    case "refusal":
      return "Grok declined the request.";
    default:
      return `Grok stopped the turn (${stopReason}).`;
  }
}
