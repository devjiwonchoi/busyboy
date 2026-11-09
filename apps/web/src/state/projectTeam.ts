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
  ProjectTeamAskLeadInput,
  ProjectTeamRestoreTaskSpecInput,
  ProjectTeamSetTaskRoleModelsInput,
  ProjectTeamSplitTaskTodoInput,
  ProjectTeamTaskRefInput,
  ProjectTeamUpdateTaskSpecInput,
  ProjectTaskReference,
  ProjectTeamAttentionSummary,
  ProjectTeamUpdateSettingsInput,
  ProjectWaitingThread,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useMemo } from "react";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useProjects, useThreadShell } from "./entities";
import { environmentThreadShells } from "./threads";
import {
  buildTaskReferenceCatalog,
  type TaskReferenceCatalog,
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

/** How long a view waits for the PM data before it shows anyway. */
export const PROJECT_TEAM_ATTENTION_GRACE_MS = 3000;

// Turns true once, a fixed time after the first view asked, so a stream that never
// answers (an unreachable environment) cannot keep views blank. It only covers startup:
// an environment that connects later is not held back, so its PM chat may still flash.
const attentionGraceExpiredAtom = Atom.make((get) => {
  const timer = setTimeout(() => get.setSelf(true), PROJECT_TEAM_ATTENTION_GRACE_MS);
  get.addFinalizer(() => clearTimeout(timer));
  return false;
}).pipe(Atom.keepAlive, Atom.withLabel("web-project-team:attention-grace-expired"));

// Whether a thread is a PM chat is only known once the attention stream sends its first
// value. Until then a PM chat and the sidebar would render as ordinary threads and then
// switch to the PM layout, so views that depend on it wait. A failed stream is no longer
// pending, since waiting on it would never end.
const environmentAttentionPendingAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): boolean =>
      !get(attentionGraceExpiredAtom) &&
      AsyncResult.isInitial(get(projectTeamEnvironment.attention({ environmentId, input: {} }))),
  ).pipe(Atom.withLabel(`web-project-team:attention-pending:${environmentId}`)),
);

const NOT_PENDING_ATOM = Atom.make(false).pipe(
  Atom.withLabel("web-project-team:attention-pending:none"),
);

// A PM always has its own thread, so only environments with threads can hold one.
const anyAttentionPendingAtom = Atom.make((get): boolean => {
  const environmentIds = new Set(
    get(environmentThreadShells.threadShellsAtom).map((thread) => thread.environmentId),
  );
  return [...environmentIds].some((environmentId) =>
    get(environmentAttentionPendingAtom(environmentId)),
  );
}).pipe(Atom.withLabel("web-project-team:attention-pending:any"));

/** True while this environment has not yet said which of its threads are PM chats. */
export function useProjectTeamAttentionPending(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId === null ? NOT_PENDING_ATOM : environmentAttentionPendingAtom(environmentId),
  );
}

/** True while any environment with threads has not yet said which threads are PM chats. */
export function useAnyProjectTeamAttentionPending(): boolean {
  return useAtomValue(anyAttentionPendingAtom);
}

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

const NO_WAITING_THREADS: ReadonlyArray<ProjectWaitingThread> = [];

/** Other threads waiting on the user; only the PM chat lists them. */
export function useThreadWaitingThreads(
  ref: ScopedThreadRef | null,
): ReadonlyArray<ProjectWaitingThread> {
  return useProjectManagerForThread(ref)?.waitingThreads ?? NO_WAITING_THREADS;
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

/** Asks the lead that raised a card a question from the card's side chat. */
export function useAskLead() {
  const askLead = useAtomCommand(projectTeamEnvironment.askLead);
  return (environmentId: EnvironmentId, input: ProjectTeamAskLeadInput) =>
    askLead({ environmentId, input });
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

const NO_THREAD_TITLES: ReadonlyArray<string> = [];
const EMPTY_THREAD_TITLES_ATOM = Atom.make(NO_THREAD_TITLES).pipe(
  Atom.withLabel("web-project-team:numbered-thread-titles:empty"),
);

/**
 * Titles of the project's threads that contain "#N", such as "CU eval chrome-form #1".
 * The same titles keep the same array, so markdown doesn't re-render on unrelated changes.
 */
const numberedThreadTitlesAtom = Atom.family((key: string) => {
  const ref = parseScopedProjectKey(key);
  let previous = NO_THREAD_TITLES;
  return Atom.make((get): ReadonlyArray<string> => {
    if (ref === null) return NO_THREAD_TITLES;
    const titles = get(environmentThreadShells.threadShellsAtom)
      .filter(
        (shell) =>
          shell.environmentId === ref.environmentId &&
          shell.projectId === ref.projectId &&
          /#\d/u.test(shell.title),
      )
      .map((shell) => shell.title)
      .toSorted();
    if (previous.join("\0") !== titles.join("\0")) previous = titles;
    return previous;
  }).pipe(Atom.withLabel(`web-project-team:numbered-thread-titles:${key}`));
});

/** What the task-reference linker needs besides the tasks: the key prefix and thread titles. */
export function useTaskReferenceLinkContext(
  ref: ScopedThreadRef | null,
  explicitEnvironmentId?: EnvironmentId | null,
): {
  readonly taskKeyPrefix: string | null;
  readonly threadTitles: ReadonlyArray<string>;
  readonly catalog: TaskReferenceCatalog;
} {
  const projectId = useThreadShell(ref)?.projectId ?? null;
  const projectRef =
    ref === null || projectId === null ? null : scopeProjectRef(ref.environmentId, projectId);
  const summary = useProjectManager(projectRef);
  const threadTitles = useAtomValue(
    projectRef === null
      ? EMPTY_THREAD_TITLES_ATOM
      : numberedThreadTitlesAtom(scopedProjectKey(projectRef)),
  );
  const environmentId = ref?.environmentId ?? explicitEnvironmentId ?? null;
  const entries = useProjectManagerEntries(environmentId === null ? [] : [environmentId]);
  const projects = useProjects();
  const catalog = useMemo(
    () =>
      buildTaskReferenceCatalog({
        environmentId,
        contextualProjectId: summary?.kind === "director" ? null : projectId,
        entries,
        projects,
      }),
    [environmentId, summary?.kind, projectId, entries, projects],
  );
  return { taskKeyPrefix: summary?.taskKeyPrefix ?? null, threadTitles, catalog };
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
