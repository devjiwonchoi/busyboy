// @effect-diagnostics nodeBuiltinImport:off globalDate:off - bridges the promise-based sandbox runtime to team services.
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { createHash } from "node:crypto";
import {
  CommandId,
  MessageId,
  NodeId,
  ThreadId,
  ProjectTaskId,
  ProviderDriverKind,
  ProviderInstanceId,
  OrchestratorMcpFailure,
  ProjectTeamTaskTodoSetInput,
  ProjectTeamTaskEvidenceSetInput,
  ProjectTeamTaskUpdateInput,
  ProjectTeamTaskReviewSetInput,
  ProjectTeamTaskReadyInput,
  ProjectTeamMemoryWriteInput,
  ProjectTeamAskUserInput,
  type ProjectTask,
  type ProjectTaskModelTarget,
  type ServerProvider,
  type ProjectTeamError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import type {
  CloudLeadOfflineHandler,
  OfflineJournalEntry,
} from "../cloudLead/CloudLeadRuntime.ts";
import type * as Repository from "../persistence/ProjectTeamRepository.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { ProjectTeamService, DelegateStep } from "./ProjectTeamService.ts";
import type { ResolvedRoleModels } from "./roleModels.ts";

export const offlineChildThreadId = (worktreeKey: string, id: string) =>
  ThreadId.make(
    `offline-${createHash("sha256").update(`${worktreeKey}\0${id}`).digest("hex").slice(0, 32)}`,
  );

const servable = new Set([
  "task_todo_set",
  "task_evidence_set",
  "task_update",
  "task_review_set",
  "task_ready",
  "link_pull_request",
  "memory_write",
  "task_spec_read",
  "ask_user",
  "task_delegate",
]);

/** Uses the normal service gates; only creating the already-run child skips a new run. */
export const makeOfflineJournalReplay = (deps: {
  team: ProjectTeamService["Service"];
  repository: Repository.ProjectTeamRepository["Service"];
  threads: ThreadManagement.ThreadManagementService["Service"];
  models: (task: ProjectTask) => Effect.Effect<ResolvedRoleModels, ProjectTeamError>;
  providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
}): CloudLeadOfflineHandler => {
  const { team, repository, threads } = deps;
  const callerOf = (worktreeKey: string, threadId: string) =>
    threadId.startsWith("offline-child:")
      ? offlineChildThreadId(worktreeKey, threadId.slice("offline-child:".length))
      : ThreadId.make(threadId);

  const importDelegate =
    (worktreeKey: string, entry: OfflineJournalEntry): DelegateStep =>
    (input) =>
      Effect.gen(function* () {
        const child = entry.child;
        if (child === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Missing offline child.",
          });
        }
        const task = Option.getOrNull(yield* repository.getTask(ProjectTaskId.make(entry.taskId)));
        if (task === null || (child.leadThreadId ?? task.leadThreadId) == null) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The offline child's task or lead is missing.",
          });
        }
        const lead = ThreadId.make(child.leadThreadId ?? task.leadThreadId!);
        const parent = yield* threads.getThreadShell(lead);
        if (parent === null) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The offline child's lead is missing.",
          });
        }
        const childThreadId = offlineChildThreadId(worktreeKey, child.id);
        // What the sandbox actually ran, not what the role would pick on the Mac now.
        const providerInstanceId = ProviderInstanceId.make(
          child.providerInstanceId ?? parent.modelSelection.instanceId,
        );
        const model = child.model ?? parent.modelSelection.model;
        if ((yield* threads.getThreadShell(childThreadId)) === null) {
          yield* threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`${childThreadId}:create`),
            threadId: childThreadId,
            projectId: task.projectId,
            launchedByThreadId: lead,
            title: child.title ?? input.title ?? "Offline child",
            modelSelection: { ...parent.modelSelection, instanceId: providerInstanceId, model },
            runtimeMode: parent.runtimeMode,
            interactionMode: parent.interactionMode,
            branch: parent.branch,
            worktreePath: parent.worktreePath,
            importedNativeThread: {
              ref: {
                driver: ProviderDriverKind.make("claudeAgent"),
                nativeId: child.claudeSessionId,
                strength: "strong",
              },
            },
            createdBy: "agent",
            creationSource: "server",
          });
        }
        return {
          taskId: NodeId.make(childThreadId),
          childThreadId,
          childRunId: null,
          childNodeId: NodeId.make(childThreadId),
          // It may still be running in the sandbox; child-finished records its end.
          status: "running" as const,
          workState: "working" as const,
          hasPendingChildRuns: false,
          latestTerminalRunId: null,
          latestTerminalStatus: null,
          latestTerminalSummary: null,
          latestTerminalResultContextTransferId: null,
          providerInstanceId,
          model,
          summary: null,
          resultContextTransferId: null,
          hasPendingQuestion: false,
          waitTimedOut: false,
        };
      }).pipe(
        // Typed failures are refusals; defects stay defects so the replay retries later.
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
        ),
      );

  return {
    kit: ({ threads: tokens }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const registered: Awaited<ReturnType<CloudLeadOfflineHandler["kit"]>>["threads"] = [];
          const specs: Record<string, unknown> = {};
          const models: Awaited<ReturnType<CloudLeadOfflineHandler["kit"]>>["models"] = {};
          const providers = yield* deps.providers;
          for (const token of tokens) {
            yield* Effect.gen(function* () {
              const caller = ThreadId.make(token.threadId);
              const role = yield* team.roleOf(caller);
              const session =
                role.type === "lead"
                  ? null
                  : Option.getOrNull(yield* repository.findTaskSessionByThreadId(caller));
              const run =
                role.type === "lead"
                  ? null
                  : Option.getOrNull(yield* repository.findModelRunByThreadId(caller));
              const taskId = role.type === "lead" ? role.taskId : (session?.taskId ?? run?.taskId);
              if (taskId === undefined) {
                return;
              }
              const task = Option.getOrNull(yield* repository.getTask(taskId));
              if (task === null || task.leadThreadId === null) {
                yield* Effect.logWarning(
                  `Skipping offline kit token ${token.threadId}: task or lead missing`,
                );
                return;
              }
              // Read as the lead: implementation children have no independent spec-reading role.
              specs[taskId] = yield* team.readSpec(ThreadId.make(task.leadThreadId!), { taskId });
              const resolved = yield* deps.models(task);
              const shell = yield* deps.threads.getThreadShell(ThreadId.make(task.leadThreadId!));
              if (shell === null) {
                yield* Effect.logWarning(
                  `Skipping offline kit token ${token.threadId}: lead missing`,
                );
                return;
              }
              const claudeModel = (target: ProjectTaskModelTarget | null) => {
                if (
                  target === null ||
                  providers.find((provider) => provider.instanceId === target.providerInstanceId)
                    ?.driver !== "claudeAgent"
                ) {
                  return null;
                }
                const effort = target.options?.find(
                  (option) => option.id === "effort" || option.id === "reasoningEffort",
                )?.value;
                return {
                  model: target.model,
                  providerInstanceId: target.providerInstanceId,
                  ...(typeof effort === "string" ? { effort } : {}),
                };
              };
              const plan = claudeModel(
                resolved.plan?.target ??
                  (shell === null
                    ? null
                    : {
                        providerInstanceId: shell.modelSelection.instanceId,
                        model: shell.modelSelection.model,
                      }),
              );
              models[taskId] = {
                plan,
                review: claudeModel(resolved.review?.target ?? null),
                implement: claudeModel(resolved.implement?.target ?? null),
                fix: claudeModel(resolved.fix?.target ?? null),
              };
              registered.push({
                ...token,
                taskId,
                role:
                  role.type === "lead"
                    ? "lead"
                    : session?.role === "reviewer"
                      ? "reviewer"
                      : "child",
              });
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning(`Skipping offline kit token ${token.threadId}: ${error.message}`),
              ),
            );
          }
          const [{ ProjectTeamToolkit }, { PullRequestsToolkit }] = yield* Effect.promise(() =>
            Promise.all([
              import("../mcp/toolkits/projectTeam/tools.ts"),
              import("../mcp/toolkits/pullRequests/tools.ts"),
            ]),
          );
          const tools = Object.values({ ...ProjectTeamToolkit.tools, ...PullRequestsToolkit.tools })
            .filter((tool) => servable.has(tool.name))
            .map((tool) => ({
              name: tool.name,
              description: Tool.getDescription(tool) ?? "",
              inputSchema: Tool.getJsonSchema(tool),
            }));
          return { threads: registered, specs, models, tools };
        }),
      ),
    apply: ({ worktreeKey, entry }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const caller = callerOf(worktreeKey, entry.threadId);
          const task = Option.getOrNull(
            yield* repository.getTask(ProjectTaskId.make(entry.taskId)),
          );
          if (task === null || task.leadThreadId === null) {
            yield* Effect.logWarning(`Skipping offline entry ${entry.seq}: task or lead missing`);
            return;
          }
          const lead = ThreadId.make(task.leadThreadId!);
          if ((yield* threads.getThreadShell(lead)) === null) {
            yield* Effect.logWarning(`Skipping offline entry ${entry.seq}: lead missing`);
            return;
          }
          const apply = Effect.gen(function* () {
            if (entry.kind === "child-started") {
              const child = entry.child!;
              if (!["review", "implement", "fix"].includes(child.role)) {
                return yield* new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: `Unknown offline child role ${String(child.role)}.`,
                });
              }
              if (
                (yield* threads.getThreadShell(offlineChildThreadId(worktreeKey, child.id))) !==
                null
              ) {
                return;
              }
              yield* team.delegateStep(
                lead,
                {
                  role: child.role,
                  task: child.task ?? "Offline delegated task",
                  ...(child.title === undefined ? {} : { title: child.title }),
                },
                importDelegate(worktreeKey, entry),
              );
              return;
            }
            if (entry.kind === "child-finished") {
              const heading = `Offline child ${entry.child!.id} finished`;
              // A replay retried after a crash must not write the note twice.
              const events = yield* repository.listTaskEvents({ taskId: task.id, limit: 200 });
              if (events.some((event) => event.kind === "note" && event.body.startsWith(heading))) {
                return;
              }
              yield* team.updateTask(lead, {
                note: `${heading} (exit ${entry.child!.exitCode}):\n${entry.child!.result ?? ""}`,
              });
              return;
            }
            switch (entry.tool) {
              case "task_todo_set":
                yield* team.setTodo(
                  caller,
                  yield* Schema.decodeUnknownEffect(ProjectTeamTaskTodoSetInput)(entry.args),
                );
                break;
              case "task_evidence_set":
                yield* team.setEvidence(
                  caller,
                  yield* Schema.decodeUnknownEffect(ProjectTeamTaskEvidenceSetInput)(entry.args),
                );
                break;
              case "task_update":
                yield* team.updateTask(
                  caller,
                  yield* Schema.decodeUnknownEffect(ProjectTeamTaskUpdateInput)(entry.args),
                );
                break;
              case "task_review_set":
                yield* team.setReview(
                  caller,
                  yield* Schema.decodeUnknownEffect(ProjectTeamTaskReviewSetInput)(entry.args),
                );
                break;
              case "task_ready":
                yield* team.markTaskReady(
                  caller,
                  yield* Schema.decodeUnknownEffect(ProjectTeamTaskReadyInput)(entry.args),
                );
                break;
              case "memory_write":
                yield* team.writeMemory(
                  caller,
                  yield* Schema.decodeUnknownEffect(ProjectTeamMemoryWriteInput)(entry.args),
                );
                break;
              case "ask_user": {
                const input = yield* Schema.decodeUnknownEffect(ProjectTeamAskUserInput)(
                  entry.args,
                );
                if (input.kind === "approval") {
                  // Approval still goes through the plan-check gate and starts its normal checker.
                  const delegate: DelegateStep = (request, onChildCreated) =>
                    Effect.gen(function* () {
                      const parent = yield* threads.getThreadProjection(lead);
                      const shell = yield* threads.getThreadShell(lead);
                      const run =
                        parent.runs.find((run) => run.id === shell?.activeRunId) ??
                        parent.runs.at(-1);
                      if (run === undefined || run.rootNodeId === null) {
                        return yield* new OrchestratorMcpFailure({
                          code: "invalid_request",
                          message: "The lead has no run for a plan checker.",
                        });
                      }
                      const modelSelection = {
                        ...parent.thread.modelSelection,
                        instanceId:
                          request.target?.providerInstanceId ??
                          parent.thread.modelSelection.instanceId,
                        model: request.target?.model ?? parent.thread.modelSelection.model,
                      };
                      const result = yield* threads.dispatch({
                        type: "delegated_task.request",
                        commandId: CommandId.make(`offline:${worktreeKey}:${entry.seq}:plan-check`),
                        parentThreadId: lead,
                        parentRunId: run.id,
                        parentNodeId: run.rootNodeId,
                        task: request.task,
                        title: request.title,
                        modelSelection,
                        runtimeMode: parent.thread.runtimeMode,
                        interactionMode: parent.thread.interactionMode,
                        location: "cloud",
                        completionWake: "always",
                        createdBy: "agent",
                        creationSource: "server",
                      });
                      const event = result.storedEvents.find(
                        ({ event }) => event.type === "subagent.updated",
                      );
                      if (
                        event?.event.type !== "subagent.updated" ||
                        event.event.payload.childThreadId === null
                      ) {
                        return yield* new OrchestratorMcpFailure({
                          code: "orchestration_error",
                          message: "The plan checker was not created.",
                        });
                      }
                      const child = event.event.payload;
                      const childThreadId = child.childThreadId!;
                      if (onChildCreated !== undefined) {
                        yield* onChildCreated({
                          childThreadId,
                          providerInstanceId: child.providerInstanceId,
                          model: child.model,
                        });
                      }
                      return {
                        taskId: child.id,
                        childThreadId,
                        childRunId: null,
                        childNodeId: child.id,
                        status: "running" as const,
                        workState: "working" as const,
                        hasPendingChildRuns: true,
                        latestTerminalRunId: null,
                        latestTerminalStatus: null,
                        latestTerminalSummary: null,
                        latestTerminalResultContextTransferId: null,
                        providerInstanceId: child.providerInstanceId,
                        model: child.model,
                        summary: null,
                        resultContextTransferId: null,
                        hasPendingQuestion: false,
                        waitTimedOut: false,
                      };
                    }).pipe(
                      Effect.mapError(
                        (error) =>
                          new OrchestratorMcpFailure({
                            code: "orchestration_error",
                            message: error.message,
                          }),
                      ),
                    );
                  yield* team.requestPlanApproval(caller, input, delegate);
                  break;
                }
                yield* team.askUser(caller, input);
                break;
              }
              case "link_pull_request": {
                const input = entry.args as { url: string };
                const target = parseChangeRequestUrl(input.url);
                if (target === null) {
                  return yield* new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: "Invalid pull request URL.",
                  });
                }
                yield* threads.dispatch({
                  type: "thread.pull-request.link",
                  commandId: CommandId.make(`offline:${worktreeKey}:${entry.seq}`),
                  threadId: lead,
                  host: target.host,
                  repository: target.repository,
                  number: target.number,
                  url: input.url,
                  source: "agent",
                });
                break;
              }
              default:
                return yield* new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: `Unsupported offline tool ${entry.tool}.`,
                });
            }
          });
          yield* apply.pipe(
            // Any typed failure (a gate, a rejected command, bad input) is a refusal the
            // lead hears about; defects and interrupts propagate and the entry is retried.
            Effect.catch((error) =>
              threads.sendToThread({
                projectId: task.projectId,
                commandId: CommandId.make(`offline:${worktreeKey}:${entry.seq}:refused`),
                messageId: MessageId.make(`offline:${worktreeKey}:${entry.seq}:refused`),
                threadId: lead,
                text: `[Offline replay] ${entry.tool ?? entry.kind} from ${new Date(entry.at).toISOString()} was refused: ${error.message}. Fix it and call it again.`,
                attachments: [],
                mode: "auto",
                createdBy: "agent",
                creationSource: "server",
              }),
            ),
          );
        }),
      ),
  };
};
