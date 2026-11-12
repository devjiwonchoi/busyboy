import { shortWorkName, parseRequestMessage } from "@t3tools/shared/requestMessage";
import {
  CommandId,
  isTurnFailedBlocker,
  TURN_FAILED_RETRY,
  MessageId,
  type ProjectAttentionAnsweredBy,
  type ProjectAttentionContext,
  type ProjectAttentionDetail,
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

/** Prefix of an answer the user gave by clicking the card. */
export const USER_ANSWER_PREFIX = "[User answer via BusyBoy]";
/** Prefix of an answer the PM relayed from the user's chat after the server checked it. */
export const PM_RELAY_ANSWER_PREFIX = "[User's chat answer, relayed by BusyBoy PM]";

/**
 * Prefix of the message a lead gets when the server approved its plan because the user
 * is AFK. Only the server sends it; no agent tool can.
 */
export const AUTO_APPROVED_PLAN_PREFIX = "[Plan auto-approved (AFK): the user is away]";
/** Prefix of an answer the server gave for the user while AFK was on. */
export const AFK_ANSWER_PREFIX = "[Auto-answered (AFK): the user is away]";
/** Prefix of the note the PM and leads get when the user turns AFK on or off. */
export const AFK_NOTICE_PREFIX = "[AFK]";

/** Prefix of the note a lead gets when the PM closes its question without an answer. */
/** Starts the message telling a lead its approval card closed because someone else changed the spec. */
export const SPEC_CHANGED_PREFIX = "[Spec changed]";
export const PM_DISMISS_PREFIX = "[Question closed by BusyBoy PM]";

function trimQuestion(question: string): string {
  return question.length > RELAYED_QUESTION_MAX_CHARS
    ? `${question.slice(0, RELAYED_QUESTION_MAX_CHARS)}…`
    : question;
}

export function dismissedQuestionText(question: string, reason: string): string {
  return `${PM_DISMISS_PREFIX} Your question "${trimQuestion(question)}" was closed without an answer: ${reason.replace(/[.!?]+$/, "")}. Carry on without it, or ask again if it still matters.`;
}

export function relayedAnswerText(
  question: string,
  answer: string,
  answeredBy: ProjectAttentionAnsweredBy,
): string {
  const trimmed = trimQuestion(parseRequestMessage(question).headline);
  const prefix =
    answeredBy === "user"
      ? USER_ANSWER_PREFIX
      : answeredBy === "afk"
        ? AFK_ANSWER_PREFIX
        : PM_RELAY_ANSWER_PREFIX;
  return `${prefix} ${trimmed} → ${answer}`;
}

export class AttentionRouter extends Context.Service<
  AttentionRouter,
  {
    readonly ask: (
      input: (
        | {
            readonly task: ProjectTask;
            /** The project whose chat shows the card. Defaults to the task's project. */
            readonly projectId?: ProjectId;
          }
        | {
            /** No task: the card is about the project, e.g. a blocked PM. */
            readonly task: null;
            readonly projectId: ProjectId;
          }
      ) & {
        readonly kind: ProjectAttentionKind;
        readonly question: string;
        readonly options: ReadonlyArray<string>;
        readonly askerThreadId: ThreadId | null;
        /** For a plan approval: the spec version under review. */
        readonly specVersion?: number;
        /** For a plan approval: the card's Goal section. */
        readonly summary?: string;
        /** For a plan approval: the card's Verification section. */
        readonly verification?: string;
        readonly context?: ProjectAttentionContext;
        readonly senderRole?: ProjectAttentionItem["senderRole"] | undefined;
        readonly senderName?: string | null | undefined;
        readonly details?: ReadonlyArray<ProjectAttentionDetail> | null | undefined;
      },
    ) => Effect.Effect<ProjectAttentionItem, ProjectTeamError>;
    /** Saves the answer and relays it to the thread that asked. */
    readonly answer: (input: {
      readonly item: ProjectAttentionItem;
      readonly answer: string;
      readonly senderThreadId: ThreadId;
      /** "user" for a card click; "pm" for a relay the caller already checked; "afk" for the AFK sweep. */
      readonly answeredBy: ProjectAttentionAnsweredBy;
      /** What the asker hears instead of the usual relayed answer. */
      readonly relayText?: string;
      /** False saves the answer without telling the asker, e.g. when the task is cancelled. */
      readonly relay?: boolean;
    }) => Effect.Effect<ProjectAttentionItem, ProjectTeamError>;
    /**
     * Closes an open item without an answer. When `notifyAsker` is set, tells the
     * thread that asked so it stops waiting.
     */
    readonly dismiss: (input: {
      readonly item: ProjectAttentionItem;
      readonly reason: string;
      readonly senderThreadId: ThreadId;
      readonly notifyAsker: boolean;
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
      const projectId =
        input.task === null ? input.projectId : (input.projectId ?? input.task.projectId);
      const now = yield* nowIso;
      const latest = yield* repository.getLatestAttentionItem(projectId);
      const batchId =
        Option.isSome(latest) &&
        isoMillis(now) - isoMillis(latest.value.createdAt) <= ATTENTION_BATCH_WINDOW_MS
          ? latest.value.batchId
          : ProjectAttentionBatchId.make(yield* newId("attention-batch"));
      const item = yield* repository.createAttentionItem({
        id: ProjectAttentionItemId.make(yield* newId("attention")),
        projectId,
        taskId: input.task === null ? null : input.task.id,
        kind: input.kind,
        question: input.question,
        options: input.options,
        askerThreadId: input.askerThreadId,
        batchId,
        createdAt: now,
        specVersion: input.specVersion ?? null,
        summary: input.summary ?? null,
        verification: input.verification ?? null,
        context: input.context ?? null,
        details: input.details ?? null,
        senderRole:
          input.senderRole === undefined ? (input.task === null ? "pm" : "lead") : input.senderRole,
        senderName:
          input.senderName === undefined
            ? input.task === null
              ? null
              : shortWorkName(input.task.title)
            : input.senderName,
      });
      yield* publish(projectId);
      return item;
    }).pipe(
      orTeamError(
        "Could not save the question.",
        input.task === null ? input.projectId : input.task.projectId,
      ),
    );

  const requireOpen = (item: ProjectAttentionItem): Effect.Effect<void, ProjectTeamError> =>
    item.answeredAt !== null
      ? Effect.fail(teamError(`Attention item ${item.id} is already answered.`, item.projectId))
      : item.supersededAt !== null
        ? Effect.fail(
            teamError(
              `Attention item ${item.id} is closed: it was dismissed, a newer question replaced it, or its task ended.`,
              item.projectId,
            ),
          )
        : Effect.void;

  const answer: AttentionRouter["Service"]["answer"] = (input) =>
    Effect.gen(function* () {
      const { item } = input;
      yield* requireOpen(item);
      // Relay before saving: a failed relay leaves the item open for a retry, and the
      // fixed command id keeps a retried relay from reaching the lead twice.
      if (input.relay !== false && item.askerThreadId !== null) {
        const key = `project-team:answer:${item.id}`;
        yield* threads.sendToThread({
          projectId: item.projectId,
          commandId: CommandId.make(key),
          threadId: item.askerThreadId,
          messageId: MessageId.make(key),
          senderThreadId: input.senderThreadId,
          text: input.relayText ?? relayedAnswerText(item.question, input.answer, input.answeredBy),
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
        answeredBy: input.answeredBy,
      });
      if (Option.isNone(answered)) {
        // A retry can fail during the relay and replace this card before its answer is saved.
        if (
          isTurnFailedBlocker(item) &&
          input.answer.split("\nNote:")[0]?.trim() === TURN_FAILED_RETRY
        ) {
          const current = yield* repository.getAttentionItem(item.id);
          if (Option.isSome(current) && current.value.supersededAt !== null) {
            return current.value;
          }
        }
        return yield* teamError(`Attention item ${item.id} is already answered.`, item.projectId);
      }
      yield* publish(item.projectId);
      return answered.value;
    }).pipe(orTeamError("Could not deliver the answer.", input.item.projectId));

  const dismiss: AttentionRouter["Service"]["dismiss"] = (input) =>
    Effect.gen(function* () {
      const { item } = input;
      yield* requireOpen(item);
      // Same order as answer: notify first so a failed send leaves the item open for a retry.
      if (input.notifyAsker && item.askerThreadId !== null) {
        const key = `project-team:dismiss:${item.id}`;
        yield* threads.sendToThread({
          projectId: item.projectId,
          commandId: CommandId.make(key),
          threadId: item.askerThreadId,
          messageId: MessageId.make(key),
          senderThreadId: input.senderThreadId,
          text: dismissedQuestionText(item.question, input.reason),
          attachments: [],
          mode: "auto",
          createdBy: "agent",
          creationSource: "server",
        });
      }
      const dismissed = yield* repository.supersedeAttentionItem({
        id: item.id,
        supersededAt: yield* nowIso,
      });
      if (Option.isNone(dismissed)) {
        return yield* teamError(`Attention item ${item.id} is already closed.`, item.projectId);
      }
      yield* publish(item.projectId);
      return dismissed.value;
    }).pipe(orTeamError("Could not close the question.", input.item.projectId));

  return {
    ask,
    answer,
    dismiss,
    publish,
    subscribe: PubSub.subscribe(changes),
  } satisfies AttentionRouter["Service"];
});

export const layer = Layer.effect(AttentionRouter, make);
