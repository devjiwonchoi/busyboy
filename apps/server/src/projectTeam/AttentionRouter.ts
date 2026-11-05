import {
  CommandId,
  MessageId,
  ProjectAttentionBatchId,
  type ProjectAttentionItem,
  ProjectAttentionItemId,
  type ProjectAttentionKind,
  type ProjectId,
  type ProjectTask,
  type ProjectTeamError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import { MINUTE_MS, isoMillis, makeIdGenerator, nowIso, orTeamError, teamError } from "./common.ts";

/** Items raised within this window of the previous one share its batch and notification. */
export const ATTENTION_BATCH_WINDOW_MS = 2 * MINUTE_MS;
const RELAYED_QUESTION_MAX_CHARS = 500;

export function relayedAnswerText(question: string, answer: string): string {
  const trimmed =
    question.length > RELAYED_QUESTION_MAX_CHARS
      ? `${question.slice(0, RELAYED_QUESTION_MAX_CHARS)}…`
      : question;
  return `[User answer via BusyBoy PM] ${trimmed} → ${answer}`;
}

export class AttentionRouter extends Context.Service<
  AttentionRouter,
  {
    readonly ask: (input: {
      readonly task: ProjectTask;
      readonly kind: ProjectAttentionKind;
      readonly question: string;
      readonly options: ReadonlyArray<string>;
      readonly askerThreadId: ThreadId | null;
    }) => Effect.Effect<ProjectAttentionItem, ProjectTeamError>;
    /** Saves the answer and relays it to the thread that asked. */
    readonly answer: (input: {
      readonly item: ProjectAttentionItem;
      readonly answer: string;
      readonly senderThreadId: ThreadId;
    }) => Effect.Effect<ProjectAttentionItem, ProjectTeamError>;
    /** Signals that a project's attention summary may have changed. */
    readonly publish: (projectId: ProjectId) => Effect.Effect<void>;
    readonly subscribe: Effect.Effect<PubSub.Subscription<ProjectId>, never, Scope.Scope>;
  }
>()("t3/projectTeam/AttentionRouter") {}

const make = Effect.gen(function* () {
  const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const newId = yield* makeIdGenerator;
  const changes = yield* PubSub.unbounded<ProjectId>();

  const publish: AttentionRouter["Service"]["publish"] = (projectId) =>
    PubSub.publish(changes, projectId).pipe(Effect.asVoid);

  const ask: AttentionRouter["Service"]["ask"] = (input) =>
    Effect.gen(function* () {
      const projectId = input.task.projectId;
      const now = yield* nowIso;
      const latest = yield* repository.getLatestAttentionItem(projectId);
      const batchId =
        Option.isSome(latest) &&
        isoMillis(now) - isoMillis(latest.value.createdAt) <= ATTENTION_BATCH_WINDOW_MS
          ? latest.value.batchId
          : ProjectAttentionBatchId.make(yield* newId("attention-batch"));
      // A newer plan replaces any approval the user has not answered yet.
      if (input.kind === "approval") {
        yield* repository.supersedeOpenAttentionItems({
          taskId: input.task.id,
          kind: "approval",
          supersededAt: now,
        });
      }
      const item = yield* repository.createAttentionItem({
        id: ProjectAttentionItemId.make(yield* newId("attention")),
        projectId,
        taskId: input.task.id,
        kind: input.kind,
        question: input.question,
        options: input.options,
        askerThreadId: input.askerThreadId,
        batchId,
        createdAt: now,
      });
      yield* publish(projectId);
      return item;
    }).pipe(orTeamError("Could not save the question.", input.task.projectId));

  const answer: AttentionRouter["Service"]["answer"] = (input) =>
    Effect.gen(function* () {
      const { item } = input;
      if (item.answeredAt !== null) {
        return yield* teamError(`Attention item ${item.id} is already answered.`, item.projectId);
      }
      if (item.supersededAt !== null) {
        return yield* teamError(
          `Attention item ${item.id} is closed: a newer question replaced it or its task ended.`,
          item.projectId,
        );
      }
      // Relay before saving: a failed relay leaves the item open for a retry, and the
      // fixed command id keeps a retried relay from reaching the lead twice.
      if (item.askerThreadId !== null) {
        const key = `project-team:answer:${item.id}`;
        yield* threads.sendToThread({
          projectId: item.projectId,
          commandId: CommandId.make(key),
          threadId: item.askerThreadId,
          messageId: MessageId.make(key),
          senderThreadId: input.senderThreadId,
          text: relayedAnswerText(item.question, input.answer),
          attachments: [],
          mode: "auto",
          createdBy: "agent",
          creationSource: "server",
        });
      }
      const answered = yield* repository.answerAttentionItem({
        id: item.id,
        answer: input.answer,
        answeredAt: yield* nowIso,
      });
      if (Option.isNone(answered)) {
        return yield* teamError(`Attention item ${item.id} is already answered.`, item.projectId);
      }
      yield* publish(item.projectId);
      return answered.value;
    }).pipe(orTeamError("Could not deliver the answer.", input.item.projectId));

  return {
    ask,
    answer,
    publish,
    subscribe: PubSub.subscribe(changes),
  } satisfies AttentionRouter["Service"];
});

export const layer = Layer.effect(AttentionRouter, make);
