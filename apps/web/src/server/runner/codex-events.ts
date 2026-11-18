import { parseAskedQuestions } from "./asked-questions";
// why: Types follow codex-cli 0.167.0 (codex app-server generate-ts), reduced to the fields read here.
import { TEXT_DELTA_FLUSH_MS } from "./claude-events";
import {
  elicitationContent,
  elicitationDefaults,
  elicitationQuestions,
  unfillableFields,
  type ElicitationSchema,
} from "./codex-elicitation";
import type { AgentAnswer, AgentEvent } from "./contract";

export type CodexRawMessage = {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

type ThreadItem = {
  type: string;
  id?: string;
  text?: string;
  command?: string;
  commandActions?: { command: string }[];
  changes?: { path: string }[];
  server?: string;
  tool?: string;
  query?: string;
  path?: string;
  questions?: AsyncQuestion[] | null;
};

// why: request_user_input is unavailable in Default mode, and the model also sends the other tool's shape here.
type AsyncQuestion = { title?: string; question?: string; options?: unknown };

export const CODEX_MESSAGE_QUESTION_PREFIX = "codex-ask-";

type Turn = {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: TurnError | null;
};
type TurnError = { message: string; codexErrorInfo?: unknown; additionalDetails?: string | null };

type SandboxPath =
  | { type: "path"; path: string }
  | { type: "glob_pattern"; pattern: string }
  | { type: "special"; value: { kind: string; path?: string; subpath?: string | null } };

const SPECIAL_PATHS: Record<string, string> = {
  root: "the whole disk",
  minimal: "system paths",
  tmpdir: "the temporary folder",
  slash_tmp: "/tmp",
  project_roots: "the project folders",
};

function sandboxPathLabel(path: SandboxPath) {
  if (path.type === "path") return path.path;
  if (path.type === "glob_pattern") return path.pattern;
  const { kind, path: unknownPath, subpath } = path.value;
  const base = SPECIAL_PATHS[kind] ?? unknownPath ?? kind;
  return subpath ? `${subpath} in ${base}` : base;
}

const ACCESS_LABELS: Record<string, string> = { read: "Read", write: "Write", deny: "No access" };

type PermissionProfile = {
  network?: { enabled: boolean | null } | null;
  fileSystem?: {
    read?: string[] | null;
    write?: string[] | null;
    entries?: { path: SandboxPath; access: string }[];
  } | null;
};

function permissionLines(permissions: PermissionProfile | null | undefined) {
  const entries = permissions?.fileSystem?.entries;
  return [
    permissions?.network?.enabled && "Network access",
    ...(entries?.length
      ? entries.map(
          (entry) =>
            `${ACCESS_LABELS[entry.access] ?? entry.access}: ${sandboxPathLabel(entry.path)}`,
        )
      : [
          permissions?.fileSystem?.write?.length &&
            `Write: ${permissions.fileSystem.write.join(", ")}`,
          permissions?.fileSystem?.read?.length &&
            `Read: ${permissions.fileSystem.read.join(", ")}`,
        ]),
  ];
}

export const CODEX_ANSWERABLE_REQUESTS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

const LABEL_LIMIT = 80;

// why: Codex wraps commands in the login shell and reports the parsed commands separately.
function displayCommand(command: unknown, actions: unknown) {
  const parsed = Array.isArray(actions)
    ? actions.map((action: { command?: unknown }) => action.command)
    : [];
  if (parsed.length && parsed.every((value) => typeof value === "string" && value))
    return parsed.join(" && ");
  return typeof command === "string" ? command : undefined;
}

function shorten(value: string) {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > LABEL_LIMIT ? `${line.slice(0, LABEL_LIMIT - 1)}…` : line;
}

function itemLabel(item: ThreadItem): string | undefined {
  switch (item.type) {
    case "commandExecution": {
      const command = displayCommand(item.command, item.commandActions);
      return command ? `Shell: ${shorten(command)}` : "Shell";
    }
    case "fileChange": {
      const paths = item.changes?.map((change) => change.path) ?? [];
      if (paths.length === 0) return "Edit";
      return `Edit: ${shorten(paths.length === 1 ? paths[0]! : `${paths[0]} and ${paths.length - 1} more`)}`;
    }
    case "mcpToolCall":
      return `${item.server}: ${item.tool}`;
    case "dynamicToolCall":
      return item.tool ?? "Tool";
    case "webSearch":
      return item.query ? `Web search: ${shorten(item.query)}` : "Web search";
    case "imageView":
      return item.path ? `View image: ${shorten(item.path)}` : "View image";
    default:
      return undefined;
  }
}

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

export function codexErrorEvent(
  error: TurnError | null | undefined,
): Extract<AgentEvent, { type: "error" }> {
  const { code, httpStatus } = errorCode(error?.codexErrorInfo);
  if (code === "unauthorized" || httpStatus === 401) {
    return {
      type: "error",
      code: "signed-out",
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
  private endedByDenial = false;

  constructor(private readonly emit: (event: AgentEvent) => void) {}

  // why: A denial with cancel ends the Codex turn. Claude continues. That gap cannot be closed from here.
  deniedWithCancel() {
    this.endedByDenial = true;
  }

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
      case "item/started": {
        const label = itemLabel(params.item as ThreadItem);
        if (label) this.send({ type: "tool", label });
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
        const endedByDenial = this.endedByDenial;
        this.endedByDenial = false;
        if (turn.status === "interrupted" && endedByDenial) {
          this.send({
            type: "error",
            code: "provider",
            message: "The command was denied, so Codex ended the turn.",
          });
          this.send({ type: "turn-done" });
        } else
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
    if (item.questions?.length) {
      this.send({
        type: "question",
        requestId: `${CODEX_MESSAGE_QUESTION_PREFIX}${itemId}`,
        questions: parseAskedQuestions(item.questions) ?? [
          {
            question: "Codex asked a question BusyBoy could not read. Reply with the answer.",
            multiSelect: false,
            options: [],
          },
        ],
      });
    }
  }
}

function detailLines(...lines: (string | number | null | undefined | false)[]) {
  const detail = lines.filter(Boolean).join("\n");
  return detail || undefined;
}

type ElicitationParams = {
  serverName?: string;
  mode?: string;
  message?: string;
  title?: string;
  description?: string;
  url?: string;
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

// why: Matching decision strings with includes misses Codex's externally tagged objects.
type ListedDecision = { name: string; value: unknown };

const COMMAND_DECISIONS = new Set([
  "accept",
  "acceptForSession",
  "acceptWithExecpolicyAmendment",
  "applyNetworkPolicyAmendment",
  "decline",
  "cancel",
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

function networkAmendment(value: unknown): { host?: string; action?: string } | undefined {
  const amendment =
    value && typeof value === "object"
      ? (
          value as {
            applyNetworkPolicyAmendment?: {
              network_policy_amendment?: { host?: unknown; action?: unknown };
            };
          }
        ).applyNetworkPolicyAmendment?.network_policy_amendment
      : undefined;
  if (!amendment || typeof amendment !== "object") return undefined;
  return {
    host: typeof amendment.host === "string" ? amendment.host : undefined,
    action: typeof amendment.action === "string" ? amendment.action : undefined,
  };
}

function sessionChoice(params: Record<string, unknown>): { offered: boolean; label?: string } {
  if (params.kind === "humanCommand") return { offered: false };
  const decisions = listedDecisions(params.availableDecisions);
  if (!decisions) return { offered: true };
  if (decisions.some((decision) => decision.name === "acceptForSession")) return { offered: true };
  const prefix = decisions.find((decision) => decision.name === "acceptWithExecpolicyAmendment");
  const command = prefix ? execpolicyPrefix(prefix.value) : undefined;
  if (command)
    return { offered: true, label: `Always allow commands starting with ${shorten(command)}` };
  const network = decisions.find((decision) => decision.name === "applyNetworkPolicyAmendment");
  const rule = network ? networkAmendment(network.value) : undefined;
  if (rule && rule.action !== "deny")
    return {
      offered: true,
      label: rule.host ? `Always allow ${rule.host}` : "Always allow this host",
    };
  return { offered: false };
}

// why: cancel is the only refusal on some requests, and cancel also ends the turn.
function commandApprovalDecision(
  params: Record<string, unknown>,
  allow: boolean,
  forSession: boolean,
): unknown {
  const human = params.kind === "humanCommand";
  const decisions = listedDecisions(params.availableDecisions);
  if (allow && forSession && !human) {
    const session = listedValue(decisions, "acceptForSession");
    if (!decisions || decisions.some((decision) => decision.name === "acceptForSession"))
      return session;
    const prefix = listedValue(decisions, "acceptWithExecpolicyAmendment");
    if (prefix !== undefined && execpolicyPrefix(prefix)) return prefix;
    const network = listedValue(decisions, "applyNetworkPolicyAmendment");
    if (network !== undefined && networkAmendment(network)?.action !== "deny") return network;
  }
  if (allow) {
    const once = listedValue(decisions, "accept");
    if (once !== undefined) return once;
    return "accept";
  }
  const decline = listedValue(decisions, "decline");
  if (decline !== undefined) return decline;
  const cancel = listedValue(decisions, "cancel");
  if (cancel !== undefined) return cancel;
  return "decline";
}

export function codexRequestToEvent(
  requestId: string,
  message: CodexRawMessage,
): Extract<AgentEvent, { type: "approval" | "question" }> | undefined {
  const params = message.params ?? {};
  const reason = typeof params.reason === "string" ? params.reason : undefined;
  switch (message.method) {
    case "item/commandExecution/requestApproval": {
      const command = displayCommand(params.command, params.commandActions);
      const network = params.networkApprovalContext as
        | { host?: string; protocol?: string }
        | null
        | undefined;
      const title =
        params.kind === "writeStdin"
          ? "Allow input to a running command?"
          : command
            ? `Allow Shell: ${shorten(command)}?`
            : "Allow a shell command?";
      const session = sessionChoice(params);
      return {
        type: "approval",
        requestId,
        title,
        detail: detailLines(
          reason,
          typeof params.cwd === "string" && `In ${params.cwd}`,
          network?.host && `Network: ${network.host}`,
          ...permissionLines(params.additionalPermissions as PermissionProfile | null | undefined),
        ),
        canAllowForSession: session.offered,
        ...(session.label ? { allowForSessionLabel: session.label } : {}),
      };
    }
    case "item/fileChange/requestApproval":
      return {
        type: "approval",
        requestId,
        title: "Allow file changes?",
        detail: detailLines(
          reason,
          typeof params.grantRoot === "string" && `Write access under ${params.grantRoot}`,
        ),
        canAllowForSession: true,
      };
    case "item/permissions/requestApproval": {
      return {
        type: "approval",
        requestId,
        title: "Allow extra permissions?",
        detail: detailLines(reason, ...permissionLines(params.permissions as PermissionProfile)),
        canAllowForSession: true,
      };
    }
    case "item/tool/requestUserInput": {
      const questions = parseAskedQuestions(params.questions) ??
        parseAskedQuestions(params) ?? [
          {
            question: "Codex asked a question BusyBoy could not read. Reply with the answer.",
            multiSelect: false,
            options: [],
          },
        ];
      return { type: "question", requestId, questions };
    }
    case "mcpServer/elicitation/request": {
      const elicitation = params as ElicitationParams;
      const text = [elicitation.message, elicitation.title, elicitation.description].find(
        (value) => typeof value === "string",
      );
      if (isForm(elicitation)) {
        const questions = elicitationQuestions(
          elicitation.message ?? "",
          elicitation.requestedSchema ?? {},
        );
        if (questions.length > 0) return { type: "question", requestId, questions };
      }
      const defaults = isForm(elicitation)
        ? elicitationDefaults(elicitation.requestedSchema ?? {})
        : [];
      return {
        type: "approval",
        requestId,
        title: `Allow ${elicitation.serverName}: ${shorten(String(text ?? "request"))}?`,
        detail: detailLines(
          typeof elicitation.url === "string" && elicitation.url,
          defaults.length > 0 && "Sends:",
          ...defaults,
        ),
        canAllowForSession: false,
      };
    }
    default:
      return undefined;
  }
}

export function codexAnswerToResult(message: CodexRawMessage, answer: AgentAnswer): unknown {
  const params = message.params ?? {};
  const allow = answer.kind === "question" || answer.allow;
  const forSession = answer.kind === "approval" && answer.allow && Boolean(answer.forSession);
  switch (message.method) {
    case "item/commandExecution/requestApproval":
      return { decision: commandApprovalDecision(params, allow, forSession) };
    case "item/fileChange/requestApproval":
      return { decision: allow ? (forSession ? "acceptForSession" : "accept") : "decline" };
    case "item/permissions/requestApproval": {
      const requested = params.permissions as { network?: unknown; fileSystem?: unknown };
      const granted = Object.fromEntries(
        Object.entries(requested ?? {}).filter(([, value]) => value != null),
      );
      return { permissions: allow ? granted : {}, scope: forSession ? "session" : "turn" };
    }
    case "item/tool/requestUserInput": {
      const questions = Array.isArray(params.questions) ? params.questions : [];
      if (answer.kind !== "question") return { answers: {} };
      const answers = Object.fromEntries(
        questions.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const id = (item as { id?: unknown }).id;
          const key = parseAskedQuestions(item)?.[0]?.question;
          const value = key === undefined ? undefined : answer.answers[key];
          if (typeof id !== "string" || value === undefined) return [];
          return [[id, { answers: [value] }]];
        }),
      );
      return { answers };
    }
    case "mcpServer/elicitation/request": {
      const elicitation = params as ElicitationParams;
      const decline = { action: "decline", content: null, _meta: null };
      if (answer.kind === "question") {
        const content = elicitationContent(
          elicitation.message ?? "",
          elicitation.requestedSchema ?? {},
          answer,
        );
        return content ? { action: "accept", content, _meta: null } : decline;
      }
      if (!answer.allow) return decline;
      const content = isForm(elicitation)
        ? (elicitationContent("", elicitation.requestedSchema ?? {}, {
            kind: "question",
            answers: {},
          }) ?? {})
        : null;
      return { action: "accept", content, _meta: null };
    }
    default:
      return undefined;
  }
}

export function codexQuestionAnswerText(answer: AgentAnswer) {
  if (answer.kind !== "question") return "I would rather not answer that. Continue without it.";
  return Object.entries(answer.answers)
    .map(([question, label]) => `${question} ${label}`)
    .join("\n");
}
