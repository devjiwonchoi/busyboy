import { TEXT_DELTA_FLUSH_MS } from "./claude-events";
import { elicitationDefaults, unfillableFields, type ElicitationSchema } from "./codex-elicitation";
import type { AgentEvent } from "./contract";

export type CodexRawMessage = {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

type ThreadItem = { type: string; id?: string; text?: string };

type Turn = {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: TurnError | null;
};
type TurnError = { message: string; codexErrorInfo?: unknown; additionalDetails?: string | null };

export const CODEX_ANSWERABLE_REQUESTS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

const ERROR_TEXT: Record<string, string> = {
  contextWindowExceeded:
    "Codex stopped: the conversation is longer than the model can read. Compact it or start a new agent.",
  sessionBudgetExceeded: "Codex stopped: the session's budget ran out.",
  usageLimitExceeded: "Codex hit its usage limit.",
  rateLimitExceeded: "Codex hit its rate limit. Try again shortly.",
  serverOverloaded: "Codex is overloaded right now. Try again shortly.",
  modelNotFound: "Codex could not find the selected model.",
  internalServerError: "Codex ran into a server error. Try again shortly.",
  badRequest: "Codex rejected the request.",
  sandboxError: "Codex could not run the command in its sandbox.",
  tooManyDenials: "Codex stopped after too many denied requests.",
  cyberPolicy: "Codex declined the request under its usage policy.",
  misalignmentPolicyViolation: "Codex declined the request under its usage policy.",
  policyCapacityUnavailable: "Codex is out of capacity right now. Try again shortly.",
  flexUnavailable: "Codex has no flex capacity right now. Try again shortly.",
  httpConnectionFailed: "Codex could not reach its server.",
  responseStreamConnectionFailed: "Codex could not reach its server.",
  responseStreamDisconnected: "Codex lost the connection to its server.",
  responseTooManyFailedAttempts: "Codex gave up after repeated failed requests.",
};
const DETAIL_LIMIT = 500;

function errorCode(info: unknown): { code?: string; httpStatus?: number } {
  if (typeof info === "string") return { code: info };
  if (!info || typeof info !== "object") return {};
  const [code, value] = Object.entries(info)[0] ?? [];
  const status = (value as { httpStatusCode?: unknown } | undefined)?.httpStatusCode;
  return { code, httpStatus: typeof status === "number" ? status : undefined };
}

function codexErrorEvent(
  error: TurnError | null | undefined,
): Extract<AgentEvent, { type: "error" }> {
  const { code, httpStatus } = errorCode(error?.codexErrorInfo);
  if (code === "unauthorized" || httpStatus === 401) {
    return {
      type: "error",
      message: "Codex is not signed in. Run `codex login`.",
    };
  }
  const detail = (error?.additionalDetails?.trim() || error?.message?.trim() || "").slice(
    0,
    DETAIL_LIMIT,
  );
  const known =
    httpStatus === 429 ? ERROR_TEXT.rateLimitExceeded : code ? ERROR_TEXT[code] : undefined;
  const message =
    known && detail && detail !== known
      ? `${known} Codex said: ${detail}`
      : known || detail || "The Codex turn failed.";
  return { type: "error", code: "provider", message };
}

export class CodexEventMapper {
  private streamed = new Map<string, string>();
  private pending = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private turnError: TurnError | undefined;
  private failedServers = new Set<string>();

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  push(message: CodexRawMessage) {
    const params = message.params ?? {};
    switch (message.method) {
      case "item/agentMessage/delta": {
        if (typeof params.delta !== "string" || !params.delta) return;
        this.append(
          typeof params.itemId === "string" ? params.itemId : "agent-message",
          params.delta,
        );
        return;
      }
      case "item/completed": {
        const item = params.item as ThreadItem;
        if (item.type === "agentMessage") this.completeMessage(item);
        return;
      }
      case "error": {
        if (params.willRetry !== true) this.turnError = params.error as TurnError;
        return;
      }
      case "mcpServer/startupStatus/updated": {
        const name = typeof params.name === "string" ? params.name.trim() : "";
        const status = params.status;
        if (!name || this.failedServers.has(name)) return;
        if (status !== "failed" && status !== "needs-auth" && status !== "needsAuth") return;
        this.failedServers.add(name);
        const reason =
          typeof params.error === "string" && params.error.trim()
            ? `: ${params.error.trim().slice(0, DETAIL_LIMIT)}`
            : ".";
        const message =
          status === "failed"
            ? `The MCP server ${name} failed to start${reason}`
            : `The MCP server ${name} needs a login. Run \`codex mcp login ${name}\`.`;
        this.send({ type: "error", code: "provider", message });
        return;
      }
      case "turn/completed": {
        const turn = params.turn as Turn;
        if (turn.status === "failed") this.send(codexErrorEvent(this.turnError ?? turn.error));
        this.turnError = undefined;
        this.send(
          turn.status === "interrupted"
            ? { type: "turn-done", interrupted: true }
            : { type: "turn-done" },
        );
        this.streamed.clear();
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

  private append(itemId: string, text: string) {
    this.streamed.set(itemId, (this.streamed.get(itemId) ?? "") + text);
    this.pending.set(itemId, (this.pending.get(itemId) ?? "") + text);
    this.timer ??= setTimeout(() => this.flush(), TEXT_DELTA_FLUSH_MS);
  }

  private completeMessage(item: ThreadItem) {
    const itemId = item.id ?? "agent-message";
    const streamed = this.streamed.get(itemId);
    this.streamed.delete(itemId);
    if (item.text && item.text !== streamed) this.send({ type: "text", itemId, text: item.text });
    else this.flush();
  }
}

type ElicitationParams = {
  serverName?: string;
  mode?: string;
  requestedSchema?: ElicitationSchema;
};

function isForm(params: ElicitationParams) {
  return params.mode === "form" || params.mode === "openai/form" || params.mode === "openaiForm";
}

export function codexAutoReply(
  message: CodexRawMessage,
): { result: unknown; notice: string } | undefined {
  if (message.method !== "mcpServer/elicitation/request") return undefined;
  const params = (message.params ?? {}) as ElicitationParams;
  const decline = { action: "decline", content: null, _meta: null };
  if (isForm(params)) {
    const missing = unfillableFields(params.requestedSchema ?? {});
    if (missing.length === 0) return undefined;
    return {
      result: decline,
      notice: `The MCP server ${params.serverName} asked for a form BusyBoy cannot fill in yet (${missing.join(", ")}), so it was declined.`,
    };
  }
  if (params.mode === "url") return undefined;
  return {
    result: decline,
    notice: `The MCP server ${params.serverName} asked for a ${params.mode} check BusyBoy does not support, so it was declined.`,
  };
}

type ListedDecision = { name: string; value: unknown };

const COMMAND_DECISIONS = new Set([
  "accept",
  "acceptForSession",
  "acceptWithExecpolicyAmendment",
  "applyNetworkPolicyAmendment",
]);

function listedDecisions(offered: unknown): ListedDecision[] | undefined {
  if (!Array.isArray(offered)) return undefined;
  const decisions: ListedDecision[] = [];
  for (const value of offered) {
    if (typeof value === "string" && COMMAND_DECISIONS.has(value)) {
      decisions.push({ name: value, value });
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const [name] = Object.keys(value).filter((key) => COMMAND_DECISIONS.has(key));
    if (name) decisions.push({ name, value });
  }
  return decisions;
}

function listedValue(decisions: ListedDecision[] | undefined, name: string): unknown {
  if (!decisions) return name;
  return decisions.find((decision) => decision.name === name)?.value;
}

function execpolicyPrefix(value: unknown): string | undefined {
  const amendment =
    value && typeof value === "object"
      ? (value as { acceptWithExecpolicyAmendment?: { execpolicy_amendment?: unknown } })
          .acceptWithExecpolicyAmendment?.execpolicy_amendment
      : undefined;
  const text = Array.isArray(amendment)
    ? amendment.filter((part): part is string => typeof part === "string").join(" ")
    : amendment &&
        typeof amendment === "object" &&
        typeof (amendment as { command?: unknown }).command === "string"
      ? (amendment as { command: string }).command
      : typeof amendment === "string"
        ? amendment
        : "";
  const prefix = text.trim();
  if (!prefix || /[\r\n]/.test(prefix)) return undefined;
  return prefix;
}

function networkAction(value: unknown): string | undefined {
  const amendment =
    value && typeof value === "object"
      ? (
          value as {
            applyNetworkPolicyAmendment?: {
              network_policy_amendment?: { action?: unknown };
            };
          }
        ).applyNetworkPolicyAmendment?.network_policy_amendment
      : undefined;
  return typeof amendment?.action === "string" ? amendment.action : undefined;
}

function commandAcceptDecision(params: Record<string, unknown>): unknown {
  const decisions = listedDecisions(params.availableDecisions);
  if (params.kind !== "humanCommand") {
    const session = listedValue(decisions, "acceptForSession");
    if (!decisions || decisions.some((decision) => decision.name === "acceptForSession"))
      return session;
    const prefix = listedValue(decisions, "acceptWithExecpolicyAmendment");
    if (prefix !== undefined && execpolicyPrefix(prefix)) return prefix;
    const network = listedValue(decisions, "applyNetworkPolicyAmendment");
    if (network !== undefined && networkAction(network) !== "deny") return network;
  }
  return listedValue(decisions, "accept") ?? "accept";
}

export function codexAcceptForSession(message: CodexRawMessage): unknown {
  const params = message.params ?? {};
  switch (message.method) {
    case "item/commandExecution/requestApproval":
      return { decision: commandAcceptDecision(params) };
    case "item/fileChange/requestApproval":
      return { decision: "acceptForSession" };
    case "item/permissions/requestApproval": {
      const requested = params.permissions as { network?: unknown; fileSystem?: unknown };
      const granted = Object.fromEntries(
        Object.entries(requested ?? {}).filter(([, value]) => value != null),
      );
      return { permissions: granted, scope: "session" };
    }
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "mcpServer/elicitation/request": {
      const elicitation = params as ElicitationParams;
      const content = isForm(elicitation)
        ? elicitationDefaults(elicitation.requestedSchema ?? {})
        : null;
      return { action: "accept", content, _meta: null };
    }
    default:
      return undefined;
  }
}
