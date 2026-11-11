import {
  WS_METHODS,
  type ProjectId,
  type ProjectTeamAttentionSnapshot,
  type ProjectTeamAttentionSummary,
  type ThreadId,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** One environment's team attention, keyed for lookups by project and by PM thread. */
export interface ProjectTeamAttentionIndex {
  readonly byProjectId: ReadonlyMap<ProjectId, ProjectTeamAttentionSummary>;
  readonly byPmThreadId: ReadonlyMap<ThreadId, ProjectTeamAttentionSummary>;
}

export const EMPTY_PROJECT_TEAM_ATTENTION_INDEX: ProjectTeamAttentionIndex = {
  byProjectId: new Map(),
  byPmThreadId: new Map(),
};

export function indexProjectTeamAttention(
  snapshot: ProjectTeamAttentionSnapshot,
): ProjectTeamAttentionIndex {
  const byProjectId = new Map<ProjectId, ProjectTeamAttentionSummary>();
  const byPmThreadId = new Map<ThreadId, ProjectTeamAttentionSummary>();
  for (const summary of snapshot.projects) {
    byProjectId.set(summary.projectId, summary);
    byPmThreadId.set(summary.pmThreadId, summary);
  }
  return { byProjectId, byPmThreadId };
}

export function createProjectTeamEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  /** Live attention for every project with a PM, refreshed after each change on the server. */
  const attention = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:project-team:attention",
    tag: WS_METHODS.projectTeamSubscribeAttention,
    transform: Stream.map(indexProjectTeamAttention),
  });
  // Every task write ends with a fresh attention snapshot, which refetches open task details.
  const taskCommand = <
    Tag extends
      | typeof WS_METHODS.projectTeamUpdateTaskSpec
      | typeof WS_METHODS.projectTeamRestoreTaskSpec
      | typeof WS_METHODS.projectTeamSplitTaskTodo
      | typeof WS_METHODS.projectTeamSetTaskRoleModels
      | typeof WS_METHODS.projectTeamMoveTask,
  >(
    label: string,
    tag: Tag,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:project-team:${label}`,
      tag,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.projectId]),
      },
    });
  return {
    attention,
    /** One task's spec versions, sessions, subtasks and open questions. */
    taskDetail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:project-team:task-detail",
      tag: WS_METHODS.projectTeamGetTask,
      refreshTrigger: ({ environmentId }) => attention({ environmentId, input: {} }),
    }),
    updateTaskSpec: taskCommand("update-task-spec", WS_METHODS.projectTeamUpdateTaskSpec),
    restoreTaskSpec: taskCommand("restore-task-spec", WS_METHODS.projectTeamRestoreTaskSpec),
    splitTaskTodo: taskCommand("split-task-todo", WS_METHODS.projectTeamSplitTaskTodo),
    setTaskRoleModels: taskCommand("set-task-role-models", WS_METHODS.projectTeamSetTaskRoleModels),
    // Moves the lead between the Mac and a cloud sandbox; resolves once the move is done.
    moveTask: taskCommand("move-task", WS_METHODS.projectTeamMoveTask),
    // The attention stream carries the result, so no command updates state itself.
    requestSitrep: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-team:request-sitrep",
      tag: WS_METHODS.projectTeamRequestSitrep,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.projectId]),
      },
    }),
    // The answer goes straight to the task lead; the attention stream then shows the card answered.
    answerDecision: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-team:answer-decision",
      tag: WS_METHODS.projectTeamAnswerDecision,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.attentionItemId]),
      },
    }),
    // Sets a card aside with the user's reason; the attention stream then shows it snoozed.
    snoozeDecision: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-team:snooze-decision",
      tag: WS_METHODS.projectTeamSnoozeDecision,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.attentionItemId]),
      },
    }),
    unsnoozeDecision: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-team:unsnooze-decision",
      tag: WS_METHODS.projectTeamUnsnoozeDecision,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.attentionItemId]),
      },
    }),
    // A side chat question for the card's lead; the card itself stays as it is.
    askLead: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-team:ask-lead",
      tag: WS_METHODS.projectTeamAskLead,
      scheduler: commandScheduler,
    }),
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-team:update-settings",
      tag: WS_METHODS.projectTeamUpdateSettings,
      scheduler: commandScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.projectId]),
      },
    }),
  };
}
