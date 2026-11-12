import type {
  NodeAsk,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2UserInputQuestion,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** A provider question tool call (Claude AskUserQuestion, Codex request_user_input) and its request. */
export interface AskSource {
  readonly threadId: ThreadId;
  readonly request: Pick<
    OrchestrationV2RuntimeRequest,
    "id" | "kind" | "status" | "resolvedAt" | "answers"
  >;
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
}

const RECOMMENDED = /\((recommended|추천)\)/i;

const answerValues = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(answerValues);
  if (value !== null && typeof value === "object" && "answers" in value) {
    return answerValues((value as { readonly answers: unknown }).answers);
  }
  return [];
};

/** Turns a question tool call into an action card; expired or cancelled questions make none. */
export const toAsk = (source: AskSource): NodeAsk | null => {
  const { request } = source;
  if (request.kind !== "user_input") return null;
  if (request.status !== "pending" && request.status !== "resolved") return null;
  const first = source.questions[0];
  const answered = request.status === "resolved";
  return {
    id: request.id,
    threadId: source.threadId,
    kind: "question",
    question: first?.question ?? "질문",
    sub: first?.header ?? null,
    options: (first?.options ?? []).map((option, index) => ({
      key: String.fromCharCode(65 + index),
      label: option.label,
      recommended: RECOMMENDED.test(option.label) || RECOMMENDED.test(option.description),
    })),
    answer: answered
      ? {
          values: source.questions.flatMap((question) =>
            answerValues(request.answers?.[question.id]),
          ),
          at: request.resolvedAt === null ? null : DateTime.formatIso(request.resolvedAt),
        }
      : null,
  };
};

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export interface LinkableRecord {
  readonly nodeId: string;
  readonly dirName: string;
  readonly statusText: string | null;
}

/**
 * The node a thread's questions belong to: the record folder named after the thread,
 * or the record whose STATUS.md names the thread. Anything else stays unlinked.
 */
export const linkThread = (
  threadId: ThreadId,
  records: ReadonlyArray<LinkableRecord>,
): string | null => {
  const ids = [threadId, safeDecode(threadId)];
  const match =
    records.find((record) => ids.includes(record.dirName)) ??
    records.find((record) => ids.some((id) => record.statusText?.includes(id) === true));
  return match?.nodeId ?? null;
};
