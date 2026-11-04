import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
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
  ProjectTeamAttentionSummary,
  ProjectTeamUpdateSettingsInput,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "./use-atom-command";

export const projectTeamEnvironment = createProjectTeamEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_SUMMARY_ATOM = Atom.make<ProjectTeamAttentionSummary | null>(null).pipe(
  Atom.withLabel("web-project-team:empty"),
);

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

export function useIsProjectManagerThread(ref: ScopedThreadRef | null): boolean {
  return useProjectManagerForThread(ref) !== null;
}

export function useRequestSitrep() {
  const requestSitrep = useAtomCommand(projectTeamEnvironment.requestSitrep);
  return (ref: ScopedProjectRef) =>
    requestSitrep({ environmentId: ref.environmentId, input: { projectId: ref.projectId } });
}

export type ProjectTeamSettingsPatch = Omit<ProjectTeamUpdateSettingsInput, "projectId">;

/** Saves the user's sitrep settings; the server then holds them for 24 hours before adjusting. */
export function useUpdateTeamSettings() {
  const updateSettings = useAtomCommand(projectTeamEnvironment.updateSettings);
  return (ref: ScopedProjectRef, patch: ProjectTeamSettingsPatch) =>
    updateSettings({
      environmentId: ref.environmentId,
      input: { ...patch, projectId: ref.projectId },
    });
}
