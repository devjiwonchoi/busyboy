import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  PLAN_APPROVAL_START,
  ProjectId,
  type ProjectTaskSpec,
  type ServerProvider,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import type * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AttentionRouter from "./AttentionRouter.ts";
import * as ContextCare from "./ContextCare.ts";
import * as DefaultManagerReactor from "./defaultManagerReactor.ts";
import * as FinishedTaskCleanup from "./FinishedTaskCleanup.ts";
import type { PullRequestText } from "./pullRequestFormat.ts";
import * as PullRequestShipGate from "./PullRequestShipGate.ts";
import * as PullRequestTextReader from "./PullRequestTextReader.ts";
import * as WorktreeHeadReader from "./WorktreeHeadReader.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import * as ShipWakeReactor from "./ShipWakeReactor.ts";
import * as SitrepScheduler from "./SitrepScheduler.ts";
import * as StalledTaskSweep from "./StalledTaskSweep.ts";
import * as TaskOutcomeReactor from "./taskOutcomeReactor.ts";

export const START = "2026-11-04T00:00:00.000Z";
export const PROJECT_ID = ProjectId.make("project-1");
export const SCRATCH_ROOT = "/data/scratch";

export interface FakeThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  title: string;
  activeRunId: string | null;
  deletedAt: string | null;
  archivedAt: string | null;
  messages: Array<OrchestrationV2ConversationMessage>;
  /** Delegated children; only `origin` and `status` matter to the team services. */
  subagents?: Array<Pick<OrchestrationV2Subagent, "origin" | "status">>;
  /** Provider turns; only `id`, `status` and `tokenUsage` matter to the team services. */
  providerTurns?: Array<Pick<OrchestrationV2ProviderTurn, "id" | "status" | "tokenUsage">>;
  worktreePath?: string | null;
  branch?: string | null;
  /** Parent in the thread lineage, e.g. the lead of a provider subagent. */
  parentThreadId?: ThreadId | null;
  pullRequests?: Array<Pick<ThreadPullRequestLink, "host" | "repository" | "number" | "url">>;
  /** Shell fields a test sets directly, e.g. `status` or `pendingRuntimeRequest`. */
  shell?: Partial<OrchestrationV2ThreadShell>;
  /** Turn items; only `user_input_request` and `approval_request` matter to the team services. */
  turnItems?: Array<OrchestrationV2TurnItem>;
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
  /** The branch checked out in a worktree; null when unknown. */
  checkedOutBranch: (worktreePath: string) => string | null;
  /** The commit checked out in a worktree, read by the review gate; null when unknown. */
  worktreeHead: (worktreePath: string) => string | null;
  /** Runs after a thread is archived, like the server's worktree cleanup effect. */
  onArchive: (threadId: ThreadId) => Effect.Effect<void>;
  /** Runs after a thread is unarchived with restoreWorktree, like the restore effect. */
  onRestore: (threadId: ThreadId) => Effect.Effect<void>;
  /** Starts every task lead on a thread named lead-<n>. */
  readonly delegate: ProjectTeamService.DelegateTaskLead;
  readonly addProject: (projectId: ProjectId, title: string) => void;
  /** Adds "No project": the Scratch project, whose folder is the scratch root. */
  readonly addScratchProject: (projectId: ProjectId) => void;
  /** Registers a fake thread for a lead started by `delegate` so tests can set its state. */
  readonly addThread: (threadId: ThreadId) => FakeThread;
  /** Pull requests the In Review gate reads, by URL; one missing here can't be read. */
  readonly pullRequests: Map<string, PullRequestText>;
  /** Pull request states the Ready gate reads, by URL; one missing here can't be read. */
  readonly shipStates: Map<string, PullRequestShipGate.PullRequestShipState>;
  /** URLs the Ready gate marked ready for review, in order. */
  readonly markedReady: Array<string>;
  /** When set, marking a pull request ready for review fails with this message. */
  markReadyRefusal: string | null;
  /** Server messages dispatched to a thread. */
  readonly messagesTo: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<string>>;
}

export type TeamServices =
  | ProjectTeamService.ProjectTeamService
  | SitrepScheduler.SitrepScheduler
  | AttentionRouter.AttentionRouter
  | ProjectTeamRepository.ProjectTeamRepository
  | TaskOutcomeReactor.TaskOutcomeReactor
  | ShipWakeReactor.ShipWakeReactor
  | StalledTaskSweep.StalledTaskSweep
  | DefaultManagerReactor.DefaultManagerReactor
  | ContextCare.ContextCare
  | FinishedTaskCleanup.FinishedTaskCleanup
  | SqlClient.SqlClient
  | ServerConfig.ServerConfig;

export function assistantMessage(input: {
  readonly threadId: ThreadId;
  readonly runId: string;
  readonly text: string;
  readonly id?: string;
  readonly createdAt?: string;
}): OrchestrationV2ConversationMessage {
  const at = DateTime.makeUnsafe(input.createdAt ?? START);
  return {
    createdBy: "agent",
    creationSource: "provider",
    id: MessageId.make(input.id ?? `message:${input.runId}`),
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

/** A message the user typed in a thread, such as the PM's chat. */
export function userMessage(input: {
  readonly threadId: ThreadId;
  readonly text: string;
  readonly id?: string;
  readonly createdAt?: string;
  readonly createdBy?: OrchestrationV2ConversationMessage["createdBy"];
  readonly creationSource?: OrchestrationV2ConversationMessage["creationSource"];
}): OrchestrationV2ConversationMessage {
  const at = DateTime.makeUnsafe(input.createdAt ?? START);
  return {
    createdBy: input.createdBy ?? "user",
    creationSource: input.creationSource ?? "web",
    id: MessageId.make(input.id ?? `user-message:${input.text}`),
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: "user",
    text: input.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
}

/** Adds a message the user typed in `threadId`'s chat. */
export const userSays = (
  harness: TeamHarness,
  threadId: ThreadId,
  text: string,
  options: Omit<Parameters<typeof userMessage>[0], "threadId" | "text"> = {},
) => {
  const thread = harness.threads.get(threadId);
  if (thread === undefined) throw new Error(`No fake thread ${threadId}.`);
  thread.messages.push(userMessage({ threadId, text, ...options }));
};

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

const toShell = (thread: FakeThread): OrchestrationV2ThreadShell =>
  ({
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    activeRunId: thread.activeRunId,
    worktreePath: thread.worktreePath ?? null,
    branch: thread.branch ?? null,
    pullRequests: thread.pullRequests ?? [],
    lineage: {
      parentThreadId: thread.parentThreadId ?? null,
      relationshipToParent: thread.parentThreadId == null ? null : "subagent",
      rootThreadId: thread.id,
    },
    deletedAt: thread.deletedAt === null ? null : DateTime.makeUnsafe(thread.deletedAt),
    archivedAt: thread.archivedAt === null ? null : DateTime.makeUnsafe(thread.archivedAt),
    status: thread.activeRunId === null ? "idle" : "running",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    createdAt: DateTime.makeUnsafe(START),
    updatedAt: DateTime.makeUnsafe(START),
    ...thread.shell,
  }) as unknown as OrchestrationV2ThreadShell;

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
          const target =
            "threadId" in command && command.threadId !== undefined
              ? threads.get(command.threadId)
              : undefined;
          if (target === undefined) return;
          if (command.type === "thread.metadata.update" && command.title !== undefined) {
            target.title = command.title;
          }
          if (command.type === "thread.metadata.update" && command.branch !== undefined) {
            target.branch = command.branch;
          }
          if (command.type === "thread.archive") target.archivedAt = START;
          if (command.type === "thread.unarchive") target.archivedAt = null;
          if (command.type === "thread.delete") target.deletedAt = START;
        }).pipe(
          Effect.andThen(Ref.update(dispatched, (all) => [...all, command])),
          Effect.andThen(
            Effect.suspend(() =>
              command.type === "thread.archive"
                ? harness.onArchive(command.threadId)
                : command.type === "thread.unarchive" && command.restoreWorktree === true
                  ? harness.onRestore(command.threadId)
                  : Effect.void,
            ),
          ),
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
      hasReceipt: (commandId) =>
        Ref.get(dispatched).pipe(
          Effect.map((commands) => commands.some((command) => command.commandId === commandId)),
        ),
      getThreadShell: (threadId) =>
        Effect.sync(() => {
          const thread = threads.get(threadId);
          return thread === undefined ? null : toShell(thread);
        }),
      listProjectThreads: ({ projectId, includeSubagents }) =>
        Effect.sync(() =>
          [...threads.values()]
            .filter(
              (thread) =>
                thread.projectId === projectId &&
                (includeSubagents || thread.parentThreadId == null) &&
                thread.archivedAt === null &&
                thread.deletedAt === null,
            )
            .map(toShell),
        ),
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
          return {
            thread,
            messages,
            subagents: thread?.subagents ?? [],
            providerTurns: thread?.providerTurns ?? [],
            turnItems: thread?.turnItems ?? [],
          };
        })) as never,
    });

    const providers: Array<ServerProvider> = [];
    const gitWorkflow = Layer.mock(GitWorkflowService.GitWorkflowService)({
      invalidateLocalStatus: () => Effect.void,
      localStatus: (input) =>
        Effect.sync(() => ({ refName: harness.checkedOutBranch(input.cwd) }) as never),
    });
    const sendFailures = { remaining: 0 };
    const pullRequests = new Map<string, PullRequestText>();
    const shipStates = new Map<string, PullRequestShipGate.PullRequestShipState>();
    const providerRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.sync(() => [...providers]),
      refresh: () => Effect.sync(() => [...providers]),
    });

    const projectStore = Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (projectId) => Effect.sync(() => Option.fromNullishOr(projects.get(projectId))),
      list: () => Effect.sync(() => [...projects.values()].filter((row) => row.deletedAt === null)),
    });

    const managedProjectFolders = Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      scratchRoot: Effect.succeed(Option.some(SCRATCH_ROOT)),
      namedProjectsRoot: "/data/projects",
    });

    const layer = Layer.mergeAll(
      TaskOutcomeReactor.layer,
      ShipWakeReactor.layer,
      StalledTaskSweep.layer,
      DefaultManagerReactor.layer,
      ContextCare.layer,
    ).pipe(
      Layer.provideMerge(ProjectTeamService.layerWithDependencies),
      Layer.provideMerge(ProjectTeamRepository.layer),
      Layer.provideMerge(SqlitePersistence.layerMemory),
      Layer.provide(
        Layer.mergeAll(
          threadManagement,
          gitWorkflow,
          projectStore,
          providerRegistry,
          ServerSettings.layerTest(),
          NodeCrypto.layer,
          managedProjectFolders,
          Path.layer,
          PullRequestTextReader.layerTest((url) => Option.fromNullishOr(pullRequests.get(url))),
          WorktreeHeadReader.layerTest((worktreePath) =>
            Option.fromNullishOr(harness.worktreeHead(worktreePath)),
          ),
          PullRequestShipGate.layerTest({
            read: (url) => Option.fromNullishOr(shipStates.get(url)),
            markReady: (url) => {
              if (harness.markReadyRefusal !== null) return harness.markReadyRefusal;
              harness.markedReady.push(url);
              const state = shipStates.get(url);
              if (state !== undefined) shipStates.set(url, { ...state, isDraft: false });
              return null;
            },
          }),
        ),
      ),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-team-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
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
      pullRequests,
      shipStates,
      markedReady: [],
      markReadyRefusal: null,
      checkedOutBranch: () => null,
      worktreeHead: () => null,
      onArchive: () => Effect.void,
      onRestore: () => Effect.void,
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
      addScratchProject: (projectId) => {
        projects.set(projectId, {
          ...makeProject(projectId, "No project"),
          workspaceRoot: SCRATCH_ROOT,
        });
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
    const { task } = yield* team.createTask(pm, {
      intake: "New work.",
      title,
      request: `${title}.`,
    });
    return yield* team.startTask(pm, { taskId: task.id }, delegate);
  });

/** A plan that meets the Definition of Ready: an end state, a proven criterion, a linked step, a file. */
export const readyPlan = (spec: ProjectTaskSpec): ProjectTaskSpec => ({
  ...spec,
  summary: "hello.sh prints hello when you run it.",
  goal: spec.goal.trim().length > 0 ? spec.goal : "hello.sh prints hello.",
  criteria: [{ id: "c1", text: "hello.sh prints hello", provenBy: "a unit test", evidence: null }],
  todos: [
    {
      id: "t1",
      text: "Write hello.sh",
      done: false,
      subtaskId: null,
      criteria: ["c1"],
      dependsOn: [],
      doneWhen: "the test passes",
    },
  ],
  files: [{ path: "hello.sh", change: "new", why: "the script", todos: ["t1"] }],
});

/** The lead writes a plan that meets the Definition of Ready. */
export const writeReadyPlan = (lead: ThreadId) =>
  Effect.gen(function* () {
    const team = yield* ProjectTeamService.ProjectTeamService;
    const read = yield* team.readSpec(lead, {});
    return yield* team.writeSpec(lead, {
      baseVersion: read.current.version,
      spec: readyPlan(read.current.spec),
      note: "Plan",
    });
  });

/** The lead writes a ready plan and the user approves it, so the task is running. */
export const approvePlan = (lead: ThreadId) =>
  Effect.gen(function* () {
    const team = yield* ProjectTeamService.ProjectTeamService;
    yield* writeReadyPlan(lead);
    const { item } = yield* team.askUser(lead, {
      kind: "approval",
      question: "Approve the plan?",
    });
    yield* team.answerDecision({
      projectId: item.projectId,
      attentionItemId: item.id,
      answer: PLAN_APPROVAL_START,
    });
    return item;
  });

/** The lead records a clean self-review, which In Review needs. */
export const reviewClean = (lead: ThreadId, head = "abc1234") =>
  Effect.flatMap(ProjectTeamService.ProjectTeamService, (team) =>
    team.setReview(lead, { clean: true, findings: "", head }),
  );
