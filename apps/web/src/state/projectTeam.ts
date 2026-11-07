import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopeProjectRef,
  scopedProjectKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  createProjectTeamEnvironmentAtoms,
  EMPTY_PROJECT_TEAM_ATTENTION_INDEX,
  type ProjectTeamAttentionIndex,
} from "@t3tools/client-runtime/state/project-team";
import type {
  EnvironmentId,
  ProjectDecisionCard,
  ProjectId,
  ProjectTeamAnswerDecisionInput,
  ProjectTeamRestoreTaskSpecInput,
  ProjectTeamSetTaskRoleModelsInput,
  ProjectTeamSplitTaskTodoInput,
  ProjectTeamTaskRefInput,
  ProjectTeamUpdateTaskSpecInput,
  ProjectTaskReference,
  ProjectTeamAttentionSummary,
  ProjectTeamUpdateSettingsInput,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useThreadShell } from "./entities";
import {
  decisionCardsForThread,
  type LeadThreadTask,
  taskForLeadThread,
  taskReferencesForThread,
} from "./projectTeam.logic";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export const projectTeamEnvironment = createProjectTeamEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_SUMMARY_ATOM = Atom.make<ProjectTeamAttentionSummary | null>(null).pipe(
  Atom.withLabel("web-project-team:empty"),
);

const EMPTY_ATTENTION_INDEX_ATOM = Atom.make<ProjectTeamAttentionIndex>(
  EMPTY_PROJECT_TEAM_ATTENTION_INDEX,
).pipe(Atom.withLabel("web-project-team:empty-index"));

/** Every project manager in one environment, keyed by project and by PM thread. */
export const environmentProjectTeamAttentionAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ProjectTeamAttentionIndex => {
    const result = get(projectTeamEnvironment.attention({ environmentId, input: {} }));
    return Option.getOrElse(AsyncResult.value(result), () => EMPTY_PROJECT_TEAM_ATTENTION_INDEX);
  }).pipe(Atom.withLabel(`web-project-team:attention:${environmentId}`)),
);

const projectManagerAtom = Atom.family((key: string) => {
  const ref = parseScopedProjectKey(key);
  return Atom.make((get): ProjectTeamAttentionSummary | null => {
    if (ref === null) return null;
    return (
      get(environmentProjectTeamAttentionAtom(ref.environmentId)).byProjectId.get(ref.projectId) ??
      null
    );
  }).pipe(Atom.withLabel(`web-project-team:project:${key}`));
});

const projectManagerByThreadAtom = Atom.family((key: string) => {
  const ref = parseScopedThreadKey(key);
  return Atom.make((get): ProjectTeamAttentionSummary | null => {
    if (ref === null) return null;
    return (
      get(environmentProjectTeamAttentionAtom(ref.environmentId)).byPmThreadId.get(ref.threadId) ??
      null
    );
  }).pipe(Atom.withLabel(`web-project-team:thread:${key}`));
});

const projectManagerThreadKeysAtom = Atom.family((environmentIdsKey: string) =>
  Atom.make((get): ReadonlySet<string> => {
    const keys = new Set<string>();
    for (const environmentId of environmentIdsKey.split(",") as EnvironmentId[]) {
      if (environmentId === "") continue;
      for (const threadId of get(
        environmentProjectTeamAttentionAtom(environmentId),
      ).byPmThreadId.keys()) {
        keys.add(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
      }
    }
    return keys;
  }).pipe(Atom.withLabel(`web-project-team:pm-thread-keys:${environmentIdsKey}`)),
);

export interface ProjectManagerEntry {
  readonly environmentId: EnvironmentId;
  readonly summary: ProjectTeamAttentionSummary;
}

const projectManagerEntriesAtom = Atom.family((environmentIdsKey: string) =>
  Atom.make((get): readonly ProjectManagerEntry[] =>
    (environmentIdsKey.split(",") as EnvironmentId[]).flatMap((environmentId) =>
      environmentId === ""
        ? []
        : [...get(environmentProjectTeamAttentionAtom(environmentId)).byProjectId.values()].map(
            (summary) => ({ environmentId, summary }),
          ),
    ),
  ).pipe(Atom.withLabel(`web-project-team:entries:${environmentIdsKey}`)),
);

/** Every project manager across these environments. */
export function useProjectManagerEntries(
  environmentIds: readonly EnvironmentId[],
): readonly ProjectManagerEntry[] {
  return useAtomValue(projectManagerEntriesAtom(environmentIds.join(",")));
}

export const PROJECT_MANAGER_ARCHIVE_BLOCKED_REASON =
  "The project manager stays for the life of the project.";

/** Reads outside React whether this thread is a project's manager. */
export function readIsProjectManagerThread(ref: ScopedThreadRef): boolean {
  return appAtomRegistry
    .get(environmentProjectTeamAttentionAtom(ref.environmentId))
    .byPmThreadId.has(ref.threadId);
}

/** Scoped keys of every PM thread across these environments. */
export function useProjectManagerThreadKeys(
  environmentIds: readonly EnvironmentId[],
): ReadonlySet<string> {
  return useAtomValue(projectManagerThreadKeysAtom(environmentIds.join(",")));
}

export function useEnvironmentProjectTeamAttention(
  environmentId: EnvironmentId,
): ProjectTeamAttentionIndex {
  return useAtomValue(environmentProjectTeamAttentionAtom(environmentId));
}

/** The project's manager summary, or null when the project has no PM yet. */
export function useProjectManager(
  ref: ScopedProjectRef | null,
): ProjectTeamAttentionSummary | null {
  return useAtomValue(
    ref === null ? EMPTY_SUMMARY_ATOM : projectManagerAtom(scopedProjectKey(ref)),
  );
}

/** The summary of the project this thread manages, or null when it is not a PM thread. */
export function useProjectManagerForThread(
  ref: ScopedThreadRef | null,
): ProjectTeamAttentionSummary | null {
  return useAtomValue(
    ref === null ? EMPTY_SUMMARY_ATOM : projectManagerByThreadAtom(scopedThreadKey(ref)),
  );
}

/** The question cards this thread shows inline, open or closed, oldest first. */
export function useThreadDecisionCards(
  ref: ScopedThreadRef | null,
): ReadonlyArray<ProjectDecisionCard> {
  const index = useAtomValue(
    ref === null
      ? EMPTY_ATTENTION_INDEX_ATOM
      : environmentProjectTeamAttentionAtom(ref.environmentId),
  );
  if (ref === null) return [];
  return decisionCardsForThread(index.byProjectId.values(), ref.threadId);
}

export function useIsProjectManagerThread(ref: ScopedThreadRef | null): boolean {
  return useProjectManagerForThread(ref) !== null;
}

export function useRequestSitrep() {
  const requestSitrep = useAtomCommand(projectTeamEnvironment.requestSitrep);
  return (ref: ScopedProjectRef) =>
    requestSitrep({ environmentId: ref.environmentId, input: { projectId: ref.projectId } });
}

/** Answers a decision card; the server sends it straight to the task lead that asked. */
export function useAnswerDecision() {
  const answerDecision = useAtomCommand(projectTeamEnvironment.answerDecision);
  return (environmentId: EnvironmentId, input: ProjectTeamAnswerDecisionInput) =>
    answerDecision({ environmentId, input });
}

export type ProjectTeamSettingsPatch = Omit<ProjectTeamUpdateSettingsInput, "projectId">;

/** Saves the user's PM settings; the server then holds sitrep values for 24 hours before adjusting. */
export function useUpdateTeamSettings() {
  const updateSettings = useAtomCommand(projectTeamEnvironment.updateSettings);
  return (ref: ScopedProjectRef, patch: ProjectTeamSettingsPatch) =>
    updateSettings({
      environmentId: ref.environmentId,
      input: { ...patch, projectId: ref.projectId },
    });
}

export function useUpdateTaskSpec() {
  const updateTaskSpec = useAtomCommand(projectTeamEnvironment.updateTaskSpec);
  return (environmentId: EnvironmentId, input: ProjectTeamUpdateTaskSpecInput) =>
    updateTaskSpec({ environmentId, input });
}

export function useRestoreTaskSpec() {
  const restoreTaskSpec = useAtomCommand(projectTeamEnvironment.restoreTaskSpec);
  return (environmentId: EnvironmentId, input: ProjectTeamRestoreTaskSpecInput) =>
    restoreTaskSpec({ environmentId, input });
}

export function useSplitTaskTodo() {
  const splitTaskTodo = useAtomCommand(projectTeamEnvironment.splitTaskTodo);
  return (environmentId: EnvironmentId, input: ProjectTeamSplitTaskTodoInput) =>
    splitTaskTodo({ environmentId, input });
}

/** Overrides the project's role models for one task; null in the patch clears a role. */
export function useSetTaskRoleModels() {
  const setTaskRoleModels = useAtomCommand(projectTeamEnvironment.setTaskRoleModels);
  return (environmentId: EnvironmentId, input: ProjectTeamSetTaskRoleModelsInput) =>
    setTaskRoleModels({ environmentId, input });
}

/** One task's detail, refetched whenever the team's attention changes. */
export function useTaskDetail(environmentId: EnvironmentId, input: ProjectTeamTaskRefInput) {
  return useEnvironmentQuery(projectTeamEnvironment.taskDetail({ environmentId, input }));
}

/** The project's tasks by number in a PM or task-lead thread; see taskReferencesForThread. */
export function useThreadTaskReferences(
  ref: ScopedThreadRef | null,
): ReadonlyMap<number, ProjectTaskReference> | null {
  const projectId = useThreadShell(ref)?.projectId ?? null;
  const summary = useProjectManager(
    ref === null || projectId === null ? null : scopeProjectRef(ref.environmentId, projectId),
  );
  return taskReferencesForThread(summary, ref?.threadId ?? null);
}

/** The task this thread leads, with whether it waits on the user; null for other threads. */
export function useLeadThreadTask(
  ref: ScopedThreadRef | null,
  projectId: ProjectId | null,
): LeadThreadTask | null {
  const summary = useProjectManager(
    ref === null || projectId === null ? null : scopeProjectRef(ref.environmentId, projectId),
  );
  return ref === null ? null : taskForLeadThread(summary, ref.threadId);
}
