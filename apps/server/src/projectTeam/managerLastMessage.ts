import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  ProjectManagerLastMessage,
} from "@t3tools/contracts";
import { isBackgroundCompactionMessageId } from "@t3tools/shared/claudeCompaction";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import { forkParked } from "../serverActivation.ts";
import * as AttentionRouter from "./AttentionRouter.ts";

/** The sidebar shows one line; this leaves room for wide sidebars without sending whole replies. */
export const LAST_MESSAGE_PREVIEW_MAX_CHARS = 160;

type PreviewMessage = Pick<
  OrchestrationV2ConversationMessage,
  "id" | "role" | "text" | "createdBy" | "streaming" | "createdAt"
>;

/**
 * Whether the user sees this message in the PM chat as one of the two sides
 * of the conversation. Wakes, decision cards and agent messages use the user
 * role too, so only messages the user wrote count on that side.
 */
function isConversationMessage(message: PreviewMessage): boolean {
  if (message.streaming || isBackgroundCompactionMessageId(message.id)) return false;
  if (message.role === "assistant") return true;
  return message.role === "user" && message.createdBy === "user";
}

/** Markdown flattened to one plain line: no fences, links, emphasis or line breaks. */
export function previewText(text: string): string {
  const flat = text
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|\*|_|`|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > LAST_MESSAGE_PREVIEW_MAX_CHARS
    ? `${flat.slice(0, LAST_MESSAGE_PREVIEW_MAX_CHARS - 1).trimEnd()}…`
    : flat;
}

/** The PM chat's latest settled message, as a one-line preview. */
export function managerLastMessage(
  messages: ReadonlyArray<PreviewMessage>,
): ProjectManagerLastMessage | null {
  let latest: { message: PreviewMessage; text: string; at: number } | null = null;
  for (const message of messages) {
    if (!isConversationMessage(message)) continue;
    const text = previewText(message.text);
    if (text.length === 0) continue;
    const at = DateTime.toEpochMillis(message.createdAt);
    if (latest === null || at >= latest.at) latest = { message, text, at };
  }
  if (latest === null) return null;
  return {
    role: latest.message.role === "assistant" ? "assistant" : "user",
    text: latest.text,
    at: DateTime.formatIso(latest.message.createdAt),
  };
}

/** Domain events that can change the PM chat's preview, by thread. */
export function previewChangeThreadId(event: OrchestrationV2DomainEvent): string | null {
  if (event.type === "run.updated") {
    const status = event.payload.status;
    return status === "completed" || status === "failed" || status === "interrupted"
      ? event.threadId
      : null;
  }
  if (event.type === "message.updated") {
    return isConversationMessage(event.payload) ? event.threadId : null;
  }
  return null;
}

/**
 * Republishes the team attention summary when a PM chat gets a new settled
 * message, so the sidebar manager row shows the latest one.
 */
export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
    const router = yield* AttentionRouter.AttentionRouter;
    const handle = (event: OrchestrationV2DomainEvent) =>
      Effect.gen(function* () {
        const threadId = previewChangeThreadId(event);
        if (threadId === null) return;
        const managers = yield* repository.listManagers();
        const manager = managers.find((candidate) => candidate.threadId === threadId);
        if (manager !== undefined) yield* router.publish(manager.projectId);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("manager preview refresh failed", { threadId: event.threadId, cause }),
        ),
      );
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) => Effect.logWarning("manager preview stream failed", { cause })),
      ),
    );
  }),
);
