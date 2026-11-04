import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  MessageId,
  NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  ProjectId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AttentionRouter from "./AttentionRouter.ts";
import * as DefaultManagerReactor from "./defaultManagerReactor.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import * as SitrepScheduler from "./SitrepScheduler.ts";
import * as StalledTaskSweep from "./StalledTaskSweep.ts";
import * as TaskOutcomeReactor from "./taskOutcomeReactor.ts";

export const START = "2026-11-04T00:00:00.000Z";
export const PROJECT_ID = ProjectId.make("project-1");

export interface FakeThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  activeRunId: string | null;
  deletedAt: string | null;
  archivedAt: string | null;
  messages: Array<OrchestrationV2ConversationMessage>;
  /** Delegated children; only `origin` and `status` matter to the team services. */
  subagents?: Array<Pick<OrchestrationV2Subagent, "origin" | "status">>;
}

export interface TeamHarness {
  readonly dispatched: Ref.Ref<ReadonlyArray<OrchestrationV2ServerCommand>>;
  readonly sent: Ref.Ref<ReadonlyArray<ThreadManagement.ThreadManagementSendInput>>;
  readonly threads: Map<ThreadId, FakeThread>;
  readonly projects: Map<ProjectId, ProjectStore.ProjectRow>;
  readonly delegated: Ref.Ref<ReadonlyArray<OrchestratorMcpDelegateTaskInput>>;
  /** How many of the next sendToThread calls fail. */
  readonly sendFailures: { remaining: number };
  /** Provider snapshots the registry reports; empty unless a test fills it. */
  readonly providers: Array<ServerProvider>;
  /** Starts every task lead on a thread named lead-<n>. */
  readonly delegate: ProjectTeamService.DelegateTaskLead;
  readonly addProject: (projectId: ProjectId, title: string) => void;
  /** Registers a fake thread for a lead started by `delegate` so tests can set its state. */
  readonly addThread: (threadId: ThreadId) => FakeThread;
  /** Server messages dispatched to a thread. */
  readonly messagesTo: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<string>>;
}

export type TeamServices =
  | ProjectTeamService.ProjectTeamService
  | SitrepScheduler.SitrepScheduler
  | AttentionRouter.AttentionRouter
  | ProjectTeamRepository.ProjectTeamRepository
  | TaskOutcomeReactor.TaskOutcomeReactor
  | StalledTaskSweep.StalledTaskSweep
  | DefaultManagerReactor.DefaultManagerReactor;

export function assistantMessage(input: {
  readonly threadId: ThreadId;
  readonly runId: string;
  readonly text: string;
}): OrchestrationV2ConversationMessage {
  const at = DateTime.makeUnsafe(START);
  return {
    createdBy: "agent",
    creationSource: "provider",
    id: MessageId.make(`message:${input.runId}`),
    threadId: input.threadId,
    runId: input.runId as never,
    nodeId: null,
    role: "assistant",
    text: input.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
}

const makeProject = (projectId: ProjectId, title: string): ProjectStore.ProjectRow => ({
  projectId,
  title,
  workspaceRoot: `/workspace/${projectId}`,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: START,
  updatedAt: START,
  deletedAt: null,
});

/** Runs `body` against the team services with in-memory storage and fake threads. */
export const withTeam = <A, E>(
  body: (harness: TeamHarness) => Effect.Effect<A, E, TeamServices>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(START));
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const sent = yield* Ref.make<ReadonlyArray<ThreadManagement.ThreadManagementSendInput>>([]);
    const delegated = yield* Ref.make<ReadonlyArray<OrchestratorMcpDelegateTaskInput>>([]);
    const threads = new Map<ThreadId, FakeThread>();
    const projects = new Map<ProjectId, ProjectStore.ProjectRow>([
      [PROJECT_ID, makeProject(PROJECT_ID, "Demo")],
    ]);

    const threadManagement = Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) =>
        Effect.sync(() => {
          if (command.type === "thread.create") {
            threads.set(command.threadId, {
              id: command.threadId,
              projectId: command.projectId,
              title: command.title,
              activeRunId: null,
              deletedAt: null,
              archivedAt: null,
              messages: [],
            });
          }
        }).pipe(
          Effect.andThen(Ref.update(dispatched, (all) => [...all, command])),
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
      getThreadShell: (threadId) =>
        Effect.sync(() => {
          const thread = threads.get(threadId);
          if (thread === undefined) return null;
          return {
            id: thread.id,
            projectId: thread.projectId,
            title: thread.title,
            activeRunId: thread.activeRunId,
            deletedAt: thread.deletedAt === null ? null : DateTime.makeUnsafe(thread.deletedAt),
            archivedAt: thread.archivedAt === null ? null : DateTime.makeUnsafe(thread.archivedAt),
          } as unknown as OrchestrationV2ThreadShell;
        }),
      sendToThread: (input) =>
        Effect.suspend(() => {
          if (sendFailures.remaining > 0) {
            sendFailures.remaining -= 1;
            return Effect.fail(
              new ThreadManagement.ThreadManagementThreadNotFoundError({
                projectId: input.projectId,
                threadId: input.threadId,
              }),
            );
          }
          return Ref.update(sent, (all) => [...all, input]).pipe(
            Effect.as({} as ThreadManagement.ThreadManagementSendResult),
          );
        }),
      getThreadRecords: ((
        threadId: ThreadId,
        _fields: unknown,
        filter?: { messageRunIds?: ReadonlyArray<string> },
      ) =>
        Effect.sync(() => {
          const thread = threads.get(threadId);
          const messages = (thread?.messages ?? []).filter(
            (message) =>
              filter?.messageRunIds === undefined ||
              (message.runId !== null && filter.messageRunIds.includes(message.runId)),
          );
          return { thread, messages, subagents: thread?.subagents ?? [] };
        })) as never,
    });

    const providers: Array<ServerProvider> = [];
    const sendFailures = { remaining: 0 };
    const providerRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.sync(() => [...providers]),
      refresh: () => Effect.sync(() => [...providers]),
    });

    const projectStore = Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (projectId) => Effect.sync(() => Option.fromNullishOr(projects.get(projectId))),
      list: () => Effect.sync(() => [...projects.values()].filter((row) => row.deletedAt === null)),
    });

    const layer = Layer.mergeAll(
      TaskOutcomeReactor.layer,
      StalledTaskSweep.layer,
      DefaultManagerReactor.layer,
    ).pipe(
      Layer.provideMerge(ProjectTeamService.layerWithDependencies),
      Layer.provideMerge(ProjectTeamRepository.layer),
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(
        Layer.mergeAll(
          threadManagement,
          projectStore,
          providerRegistry,
          ServerSettings.layerTest(),
          NodeCrypto.layer,
        ),
      ),
    );

    let leadCount = 0;
    const harness: TeamHarness = {
      dispatched,
      sent,
      threads,
      projects,
      delegated,
      sendFailures,
      providers,
      delegate: (input) =>
        Effect.gen(function* () {
          yield* Ref.update(delegated, (all) => [...all, input]);
          leadCount += 1;
          const childThreadId = ThreadId.make(`lead-${leadCount}`);
          return {
            taskId: NodeId.make(`node-${leadCount}`),
            childThreadId,
          } as OrchestratorMcpDelegateTaskResult;
        }),
      addProject: (projectId, title) => {
        projects.set(projectId, makeProject(projectId, title));
      },
      addThread: (threadId) => {
        const thread: FakeThread = {
          id: threadId,
          projectId: PROJECT_ID,
          title: threadId,
          activeRunId: null,
          deletedAt: null,
          archivedAt: null,
          messages: [],
        };
        threads.set(threadId, thread);
        return thread;
      },
      messagesTo: (threadId) =>
        Ref.get(dispatched).pipe(
          Effect.map((commands) =>
            commands.flatMap((command) =>
              command.type === "message.dispatch" && command.threadId === threadId
                ? [command.text]
                : [],
            ),
          ),
        ),
    };
    return yield* body(harness).pipe(Effect.provide(Layer.orDie(layer)));
  });

/** Creates the default project's PM and returns its thread id. */
export const setUpManager = Effect.gen(function* () {
  const team = yield* ProjectTeamService.ProjectTeamService;
  const manager = yield* team.ensureManager(PROJECT_ID);
  return manager.threadId;
});

export const startLead = (
  pm: ThreadId,
  title: string,
  delegate: ProjectTeamService.DelegateTaskLead,
) =>
  Effect.gen(function* () {
    const team = yield* ProjectTeamService.ProjectTeamService;
    const { task } = yield* team.createTask(pm, { title, request: `${title}.` });
    return yield* team.startTask(pm, { taskId: task.id }, delegate);
  });
