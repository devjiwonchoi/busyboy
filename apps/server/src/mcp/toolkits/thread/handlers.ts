import {
  type CommandId,
  type RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type RunId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadForkSourcePoint,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { modelSelectionCommandType } from "@t3tools/shared/model";

import * as McpToolAccess from "../../McpToolAccess.ts";
import { withOperationPermission } from "../../OperationPermissionCards.ts";
import { DispatchModeLimit } from "../../../orchestration-v2/DispatchModeLimit.ts";
import { runForSourcePoint } from "../../../orchestration-v2/Orchestrator.ts";
import {
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "../../threadAccess.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { ThreadToolkit } from "./tools.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function queueEntry(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  limit: number,
) {
  const run = projection.runs.find((run) => run.id === runId && run.status === "queued");
  const message = projection.messages.find((message) => message.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return {
    queuedRunId: run.id,
    text: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
  };
}
const dispatch = Effect.fn("mcp.dispatchThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

const readQuestion = Effect.fn("mcp.readQuestion")(function* (input: {
  threadId?: ThreadId | undefined;
  requestId: RuntimeRequestId;
}) {
  const context = yield* readThread(input.threadId, ["runtimeRequests", "turnItems"]);
  const request = context.projection.runtimeRequests.find(
    (request) =>
      request.id === input.requestId &&
      request.kind === "user_input" &&
      request.status === "pending",
  );
  const item = context.projection.turnItems.find(
    (item) => item.type === "user_input_request" && item.requestId === input.requestId,
  );
  if (request === undefined || item?.type !== "user_input_request")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The pending user-input request was not found.",
    });
  return { ...context, request, item };
});
const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  operation: string,
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle, operation);

const pinSourcePoint = Effect.fn("mcp.pinThreadSourcePoint")(function* <
  P extends { readonly sourcePoint: OrchestrationV2ThreadForkSourcePoint },
>({ params, threadId }: { params: P; threadId: ThreadId | undefined }) {
  if (params.sourcePoint.type !== "latest_stable") return params;
  const { projection } = yield* readThread(threadId, ["runs", "checkpoints"]);
  const run = runForSourcePoint(projection, params.sourcePoint);
  if (run === null) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "No stable source run was found for the context transfer.",
    });
  }
  return { ...params, sourcePoint: { type: "run", runId: run.id } as const };
});

export const layer = McpToolAccess.toLayer(ThreadToolkit, {
  run_scheduled_task_now: McpToolAccess.writesEnvironment(
    (input, check) =>
      Effect.gen(function* () {
        const caller = yield* check;
        const scheduler = yield* ScheduledTasks.ScheduledTaskService;
        const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
        const saved = tasks.find((task) => task.id === input.taskId);
        if (saved === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The scheduled task was not found.",
          });
        }
        if (saved.schedule.type === "webhook") {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Webhook tasks run when their URL receives a request.",
          });
        }
        const target =
          saved.threadId === null
            ? null
            : yield* caller.threads
                .getThreadShell(ThreadId.make(saved.threadId))
                .pipe(Effect.mapError(unavailable));
        if (saved.threadId !== null && (target === null || target.deletedAt !== null)) {
          return yield* new OrchestratorMcpFailure({
            code: "thread_not_found",
            message: "The scheduled task's target thread was not found.",
          });
        }
        const approvedTarget =
          target === null
            ? undefined
            : {
                threadId: target.id,
                runtimeMode: target.runtimeMode,
                interactionMode: target.interactionMode,
              };
        const auto = caller.limits.runtimeMode === "auto";
        const execute = Effect.gen(function* () {
          yield* check;
          if (auto && approvedTarget !== undefined) {
            const current = yield* caller.threads
              .getThreadShell(approvedTarget.threadId)
              .pipe(Effect.mapError(unavailable));
            if (
              current === null ||
              current.deletedAt !== null ||
              current.runtimeMode !== approvedTarget.runtimeMode ||
              current.interactionMode !== approvedTarget.interactionMode
            ) {
              return yield* new OrchestratorMcpFailure({
                code: "capability_denied",
                message:
                  "The scheduled task's target changed after approval. Request approval again.",
              });
            }
          }
          const result = yield* scheduler
            .runNow({ id: input.taskId, ...(auto ? { expectedTask: saved } : {}) })
            .pipe(Effect.mapError(unavailable));
          if (auto && result.task.lastRunStatus === "failed") {
            return yield* new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The approved scheduled task could not be dispatched.",
            });
          }
          return result;
        });
        const limited = auto
          ? execute.pipe(
              Effect.provideService(DispatchModeLimit, {
                runtimeMode: saved.runtimeMode,
                interactionMode: saved.interactionMode,
                approvedTargets: approvedTarget === undefined ? [] : [approvedTarget],
              }),
            )
          : execute;
        const { task } = !auto
          ? yield* limited
          : caller.scope.thread === undefined
            ? yield* new OrchestratorMcpFailure({
                code: "capability_denied",
                message:
                  "Run a scheduled task from an active auto-mode thread to request user approval.",
              })
            : yield* withOperationPermission(
                { ...caller.scope, thread: caller.scope.thread },
                {
                  operation: "run_scheduled_task_now",
                  summary: [
                    McpToolAccess.operationSummary("run_scheduled_task_now", {
                      title: saved.title,
                      projectId: saved.projectId,
                      message: saved.prompt,
                      modelSelection: saved.modelSelection,
                    }),
                    `taskId: ${saved.id}`,
                    `runtimeMode: ${saved.runtimeMode}`,
                    `interactionMode: ${saved.interactionMode}`,
                    McpToolAccess.operationSummary("실행 위치", {
                      text: encodeJson(saved.workspaceStrategy),
                    }),
                  ].join("\n"),
                  reason:
                    "저장된 예약 작업을 지금 한 번 실행합니다. 표시된 프롬프트와 실행 설정에만 승인합니다.",
                  targetDescription:
                    target === null
                      ? `새 스레드 (${saved.projectId})`
                      : `${target.title} (${target.id}, ${target.runtimeMode}/${target.interactionMode})`,
                  fingerprint: encodeJson({ task: saved, target: approvedTarget ?? null }),
                },
                limited,
              );
        return {
          taskId: task.id,
          threadId: task.threadId,
          lastRunStatus: task.lastRunStatus,
          runCount: task.runCount,
          nextRunAt: task.nextRunAt,
        };
      }),
    { operation: "run_scheduled_task_now", routine: () => true },
  ),
  t3_thread_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const { projectId: requested, ...query } = input;
      const projectId = requested ?? caller?.projectId;
      const threadSearch = yield* ThreadSearch.ThreadSearch;
      const result = yield* threadSearch.search(query).pipe(Effect.mapError(unavailable));
      return {
        matches:
          projectId === undefined
            ? result.matches
            : result.matches.filter((match) => match.projectId === projectId),
      };
    }),
  ),
  t3_thread_fork: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { threads, projection } = yield* readThread(input.threadId);
        const commandId = yield* newCommandId();
        const targetThreadId = ThreadId.make(`${commandId}:fork`);
        const result = yield* threads
          .dispatch({
            type: "thread.fork",
            commandId,
            sourceThreadId: projection.thread.id,
            targetThreadId,
            sourcePoint: input.sourcePoint,
            ...(input.title === undefined ? {} : { title: input.title }),
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence, targetThreadId };
      }),
    "t3_thread_fork",
    { prepare: (params) => pinSourcePoint({ params, threadId: params.threadId }) },
  ),
  t3_thread_merge_back: McpToolAccess.writesThreads(
    (input) => [input.targetThreadId, input.sourceThreadId],
    (input) =>
      Effect.gen(function* () {
        const context = yield* readThread(input.targetThreadId);
        const source = yield* readThread(input.sourceThreadId);
        const result = yield* context.threads
          .dispatch({
            type: "thread.merge_back",
            commandId: yield* newCommandId(),
            sourceThreadId: source.projection.thread.id,
            targetThreadId: input.targetThreadId,
            sourcePoint: input.sourcePoint,
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence, targetThreadId: input.targetThreadId };
      }),
    "t3_thread_merge_back",
    { prepare: (params) => pinSourcePoint({ params, threadId: params.sourceThreadId }) },
  ),
  t3_thread_transfers: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["contextTransfers"]);
      return {
        transfers: projection.contextTransfers.map(
          ({ id, sourceThreadId, targetThreadId, status }) => ({
            id,
            sourceThreadId,
            targetThreadId,
            status,
          }),
        ),
      };
    }),
  ),
  t3_thread_configuration: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      return {
        threadId: thread.id,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      };
    }),
  ),
  t3_thread_configure: writesThread("t3_thread_configure", (input) =>
    Effect.gen(function* () {
      const {
        threads,
        projection: { thread },
      } = yield* readThread(input.threadId);
      const type = modelSelectionCommandType(thread.providerInstanceId, input.modelSelection);
      const result = yield* threads
        .dispatch({
          type,
          threadId: thread.id,
          commandId: yield* newCommandId(),
          modelSelection: input.modelSelection,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  t3_pending_request_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runtimeRequests"]);
      return {
        requestIds: projection.runtimeRequests
          .filter((request) => request.kind === "user_input" && request.status === "pending")
          .map((request) => request.id),
      };
    }),
  ),
  t3_pending_request_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { item } = yield* readQuestion(input);
      return { requestId: input.requestId, questions: item.questions };
    }),
  ),
  t3_pending_request_respond: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { threads, projection } = yield* readQuestion(input);
        const result = yield* threads
          .dispatch({
            type: "runtime-request.respond",
            threadId: projection.thread.id,
            commandId: yield* newCommandId(),
            requestId: input.requestId,
            answers: input.answers,
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence };
      }),
    "t3_pending_request_respond",
    {
      snapshot: (input) =>
        readQuestion(input).pipe(
          Effect.map(({ item, request }) => ({
            requestId: request.id,
            questions: item.questions,
          })),
        ),
    },
  ),
  t3_queue_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const runs = queuedRunsInDeliveryOrder(projection);
      const cursor = input.cursor ?? 0;
      const end = cursor + (input.limit ?? 20);
      return {
        items: runs.slice(cursor, end).flatMap((run) => {
          const entry = queueEntry(projection, run.id, 1000);
          return entry === undefined ? [] : [entry];
        }),
        nextCursor: end < runs.length ? end : null,
      };
    }),
  ),
  t3_queue_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const entry = queueEntry(projection, input.queuedRunId, 16000);
      return (
        entry ??
        (yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The queued message was not found.",
        }))
      );
    }),
  ),
  t3_queue_edit: writesThread("t3_queue_edit", (input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.edit",
      runId: input.queuedRunId,
      text: input.text,
    })),
  ),
  t3_queue_cancel: writesThread("t3_queue_cancel", (input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.cancel",
      runId: input.queuedRunId,
    })),
  ),
  t3_queue_reorder: writesThread("t3_queue_reorder", (input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.reorder",
      runId: input.queuedRunId,
      beforeRunId: input.beforeRunId,
    })),
  ),
  t3_queue_promote_to_steer: writesThread("t3_queue_promote_to_steer", (input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-message.promote-to-steer",
      queuedRunId: input.queuedRunId,
      targetRunId: input.targetRunId,
    })),
  ),
  // Pinning, archiving and marking unread run nothing on the target, so a
  // caller may organize threads whose modes are broader than its own.
  t3_thread_organize: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readThread(input.threadId);
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      const command: OrchestrationV2Command =
        input.action === "mark_unread"
          ? { ...common, type: "thread.mark-unread" }
          : { ...common, type: `thread.${input.action}` };
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
});
