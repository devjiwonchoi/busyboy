import type { OrchestrationV2TurnItem, ProjectAttentionContext } from "@t3tools/contracts";

/**
 * A turn that ends on a permission denial leaves the agent waiting on the user even when it
 * only says so in chat. These helpers find that denial in a run's turn items and word the
 * blocker card the server raises for it.
 */

/** Denials only a person can lift. A user rejection is already known to the user. */
const DENIAL_KINDS: ReadonlySet<string> = new Set(["automode-blocked", "permission-rule"]);

const TOOL_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
  "subagent",
]);

/**
 * Reading status, memory and tool lookup are bookkeeping, not moving past the denial. Other
 * BusyBoy tools, such as starting or delegating work, count as carrying on.
 */
const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set([
  "team_status",
  "task_list",
  "task_read",
  "task_search",
  "task_spec_read",
  "task_status",
  "memory_list",
  "memory_write",
  "memory_delete",
  "correction_record",
  "corrections_report",
  "t3_thread_list",
  "t3_thread_read",
]);

const isBookkeepingTool = (item: OrchestrationV2TurnItem) => {
  if (item.type !== "dynamic_tool" || item.toolName === null) return false;
  if (item.toolName === "ToolSearch") return true;
  const t3Tool = /^mcp__t3[-_]code__(.+)$/.exec(item.toolName)?.[1];
  return t3Tool !== undefined && BOOKKEEPING_TOOLS.has(t3Tool);
};

export interface PermissionDenial {
  readonly kind: "automode-blocked" | "permission-rule";
  /** What was denied: the command, or the tool and its input. */
  readonly action: string;
  /** The classifier's reason, such as "Production Deploy", or null when none was given. */
  readonly reason: string | null;
}

const ACTION_MAX_LENGTH = 300;

function clipAction(text: string): string {
  const flat = text.trim();
  return flat.length > ACTION_MAX_LENGTH
    ? `${flat.slice(0, ACTION_MAX_LENGTH - 1).trimEnd()}…`
    : flat;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function deniedAction(item: OrchestrationV2TurnItem): string {
  switch (item.type) {
    case "command_execution":
      return item.input;
    case "file_change":
      return `Edit ${item.fileName}`;
    case "dynamic_tool": {
      const input = stringify(item.input);
      return `${item.toolName ?? "tool"}${input === "" || input === "{}" ? "" : ` ${input}`}`;
    }
    default:
      return item.type;
  }
}

function deniedOutput(item: OrchestrationV2TurnItem): string {
  if (item.type === "command_execution") return item.output ?? "";
  if (item.type === "dynamic_tool") return stringify(item.output);
  return "";
}

/** "… Reason: [Production Deploy]. …" → "Production Deploy". */
export function denialReason(output: string): string | null {
  const match = /Reason:\s*\[([^\]\n]{1,120})\]/.exec(output);
  return match?.[1]?.trim() || null;
}

/**
 * The run's last permission denial when nothing moved past it: no later tool call that
 * did real work succeeded. Null when there was no denial or the agent carried on.
 */
export function unresolvedPermissionDenial(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): PermissionDenial | null {
  const ordered = items.toSorted((a, b) => a.ordinal - b.ordinal);
  const lastIndex = ordered.findLastIndex(
    (item) =>
      TOOL_ITEM_TYPES.has(item.type) &&
      item.toolNonExecutionKind !== undefined &&
      DENIAL_KINDS.has(item.toolNonExecutionKind),
  );
  if (lastIndex < 0) return null;
  const movedOn = ordered
    .slice(lastIndex + 1)
    .some(
      (item) =>
        TOOL_ITEM_TYPES.has(item.type) &&
        item.status === "completed" &&
        item.toolNonExecutionKind === undefined &&
        !isBookkeepingTool(item),
    );
  if (movedOn) return null;
  const denied = ordered[lastIndex]!;
  return {
    kind: denied.toolNonExecutionKind as PermissionDenial["kind"],
    action: clipAction(deniedAction(denied)),
    reason: denialReason(deniedOutput(denied)),
  };
}

export const PERMISSION_BLOCKER_OPTIONS = [
  "진행해도 돼요: 내 지시로 다시 시도",
  "내가 직접 실행할게요",
  "이 단계는 빼고 계속",
] as const;

function impactsOf(reason: string | null): ProjectAttentionContext["impacts"] {
  if (reason === null) return [];
  if (/deploy/i.test(reason)) return ["deploy"];
  if (/merge/i.test(reason)) return ["merge"];
  if (/public|publish|upload/i.test(reason)) return ["publish"];
  return [];
}

/** The blocker card for a denial. `who` names the blocked agent: the PM's name or "#N title". */
export function permissionBlockerCard(input: {
  readonly who: string;
  readonly denial: PermissionDenial;
}): {
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  readonly context: ProjectAttentionContext;
} {
  const { who, denial } = input;
  const checker = denial.kind === "automode-blocked" ? "자동 권한 검사" : "안전 규칙";
  const reasonLine = denial.reason === null ? "" : `\n이유: ${denial.reason}`;
  const command = denial.action.replace(/`/g, "'");
  return {
    question: `${who} 막힘: ${checker}가 작업을 거부했어요\n\n거부된 작업: \`${command}\`${reasonLine}\n\n어떻게 할지 골라 주세요. 답은 막힌 에이전트에게 바로 전달돼요.`,
    options: PERMISSION_BLOCKER_OPTIONS,
    context: {
      action: `${checker}가 거부한 작업을 어떻게 할지 정합니다`,
      reason: `${who}: 턴이 ${checker} 거부로 멈춘 채 끝났어요${denial.reason === null ? "" : ` (${denial.reason})`}. 사용자가 정하기 전엔 진행하지 않아요.`,
      impacts: impactsOf(denial.reason),
      cost: null,
      reversibility: "unknown",
      recommendation:
        "직접 지시한 작업이 맞다면 '진행해도 돼요'를, 직접 확인하고 싶다면 '내가 직접 실행할게요'를 추천해요.",
    },
  };
}
