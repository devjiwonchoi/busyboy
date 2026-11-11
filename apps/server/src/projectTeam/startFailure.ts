/**
 * Sorts out why a task lead failed to start, so the server can retry it
 * somewhere the user's location setting allows, or tell the user the real
 * cause right away when only a person can fix it.
 */
import type {
  ExecutionLocation,
  ProjectAttentionContext,
  ProjectAttentionDetail,
  TaskExecutionLocationPolicy,
} from "@t3tools/contracts";

export type StartFailureKind =
  /** The cloud has no login for the lead (no Claude token saved for the cloud). */
  | "cloud_credentials"
  /** The sandbox or its network could not be reached or created. */
  | "cloud_unavailable"
  /** The provider rejected the login on this Mac too. */
  | "provider_auth"
  | "usage_limit"
  | "unknown";

export interface StartFailure {
  readonly kind: StartFailureKind;
  /** True when only a person can fix it where the lead runs now. */
  readonly humanOnly: boolean;
  /** The cause as the start of a sentence, e.g. "클라우드 로그인 토큰이 없어". */
  readonly cause: string;
  /** The cause as a short label, e.g. "클라우드 로그인 토큰 없음". */
  readonly summary: string;
}

export function classifyStartFailure(errorText: string, location: ExecutionLocation): StartFailure {
  const text = errorText.toLowerCase();
  const cloud = location === "cloud";
  if (
    cloud &&
    /claude_oauth_token|oauth token|setup-token|no claude (?:login|token)|cloud login|credentials? (?:are )?missing|missing credentials?/.test(
      text,
    )
  ) {
    return {
      kind: "cloud_credentials",
      humanOnly: true,
      cause: "클라우드 로그인 토큰이 없어",
      summary: "클라우드 로그인 토큰 없음",
    };
  }
  if (
    /\b401\b|unauthorized|authentication|invalid api key|token[_ ]expired|not logged in/.test(text)
  ) {
    return cloud
      ? {
          kind: "cloud_credentials",
          humanOnly: true,
          cause: "클라우드 로그인이 거절돼",
          summary: "클라우드 로그인 거절",
        }
      : {
          kind: "provider_auth",
          humanOnly: true,
          cause: "로그인이 만료돼",
          summary: "로그인 만료",
        };
  }
  if (/\b429\b|rate.?limit|usage limit|quota/.test(text)) {
    return {
      kind: "usage_limit",
      humanOnly: true,
      cause: "사용량 한도에 걸려",
      summary: "사용량 한도",
    };
  }
  if (
    cloud &&
    /sandbox|vercel|econn|enotfound|etimedout|fetch failed|socket hang up|network|timed? ?out|snapshot/.test(
      text,
    )
  ) {
    return {
      kind: "cloud_unavailable",
      humanOnly: false,
      cause: "클라우드 샌드박스에 연결하지 못해",
      summary: "클라우드 연결 실패",
    };
  }
  return {
    kind: "unknown",
    humanOnly: false,
    cause: "알 수 없는 오류로",
    summary: "알 수 없는 오류",
  };
}

/**
 * What to do: start it on this Mac when the failure is the cloud's and the
 * setting allows the Mac (not local only, which never uses the cloud anyway,
 * and not a lead the PM pinned to the cloud), else tell the user.
 */
export function startFailureAction(input: {
  readonly failure: StartFailure;
  readonly location: ExecutionLocation;
  readonly policy: TaskExecutionLocationPolicy;
  /** The PM asked for the cloud on purpose. */
  readonly pinnedToCloud: boolean;
}): "retry_local" | "notify" {
  const cloudSide =
    input.failure.kind === "cloud_credentials" || input.failure.kind === "cloud_unavailable";
  if (
    input.location === "cloud" &&
    cloudSide &&
    !input.pinnedToCloud &&
    (input.policy === "local_first" || input.policy === "cloud_first")
  ) {
    return "retry_local";
  }
  return "notify";
}

function shortTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  return flat.length > 28 ? `${flat.slice(0, 27).trimEnd()}…` : flat;
}

/** The message that names the real cause when the server cannot restart the lead itself. */
export function startFailureCard(input: {
  readonly title: string;
  readonly failure: StartFailure;
  readonly location: ExecutionLocation;
  readonly pinnedToCloud: boolean;
  readonly error: string;
}): {
  readonly question: string;
  readonly details: ReadonlyArray<ProjectAttentionDetail>;
  readonly context: ProjectAttentionContext;
} {
  const where =
    input.location !== "cloud"
      ? "이 Mac에서 시작하다 실패했어요."
      : input.pinnedToCloud || input.failure.kind === "unknown"
        ? "클라우드에서 실행하도록 정해져 있어서 이 Mac으로 옮기지 않았어요."
        : "실행 위치 설정이 클라우드만 허용해서 이 Mac으로 옮기지 않았어요.";
  const fix =
    input.failure.kind === "cloud_credentials"
      ? "설정에서 클라우드 로그인을 저장한 뒤 다시 시작을 눌러 주세요."
      : input.failure.humanOnly
        ? "원인을 해결한 뒤 다시 시작을 눌러 주세요."
        : "다시 시작하면 같은 곳에서 한 번 더 시도해요.";
  const question = [
    `${input.failure.cause} ${shortTitle(input.title)} 리드를 시작하지 못했어요`,
    where,
    fix,
  ].join("\n\n");
  const error = input.error.replace(/\s+/g, " ").trim();
  return {
    question,
    context: {
      action: "원인을 해결한 뒤 같은 곳에서 리드를 다시 시작해요.",
      reason: `리드가 시작하자마자 멈췄어요: ${input.failure.summary}.`,
      impacts: [],
      cost: null,
      reversibility: "reversible",
      recommendation: input.failure.humanOnly
        ? "원인을 먼저 해결하고 다시 시작을 눌러 주세요."
        : "다시 시작을 추천해요.",
    },
    details: [
      { label: "원인", text: input.failure.summary },
      ...(error.length > 0 ? [{ label: "오류", text: error.slice(0, 500) }] : []),
    ],
  };
}

/** Logged when the PM asked for the cloud on purpose, so a failed start is not moved. */
export const CLOUD_PINNED_NOTE = "PM이 클라우드 실행을 지정했어요.";

/** Hides anything that looks like a token before an error is shown. */
export function redactTokens(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[가림]")
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g, "[가림]")
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, "[가림]");
}
