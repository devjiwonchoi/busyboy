import { TEXT_DELTA_FLUSH_MS } from "./claude-events";
import type { AgentEvent } from "./contract";

export type GrokPermissionOption = { optionId: string; name?: string; kind?: string };

function text(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function grokPermissionOutcome(
  options: readonly GrokPermissionOption[],
  decision: "allow" | "cancel",
) {
  const option =
    decision === "allow"
      ? (options.find((entry) => entry.kind === "allow_once") ??
        options.find((entry) => entry.kind?.startsWith("allow")))
      : undefined;
  if (!option) return { outcome: { outcome: "cancelled" as const } };
  return { outcome: { outcome: "selected" as const, optionId: option.optionId } };
}

export class GrokEventMapper {
  private itemId: string | undefined;
  private pending = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
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
