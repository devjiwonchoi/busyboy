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
  return {
    /** Live attention for every project with a PM, refreshed after each change on the server. */
    attention: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:project-team:attention",
      tag: WS_METHODS.projectTeamSubscribeAttention,
      transform: Stream.map(indexProjectTeamAttention),
    }),
    // The attention stream carries the result, so neither command updates state itself.
    requestSitrep: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-team:request-sitrep",
      tag: WS_METHODS.projectTeamRequestSitrep,
      scheduler: commandScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.projectId]),
      },
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
