import { useAtomValue } from "@effect/atom-react";
import {
  createProjectTeamEnvironmentAtoms,
  EMPTY_PROJECT_TEAM_ATTENTION_INDEX,
  type ProjectTeamAttentionIndex,
} from "@t3tools/client-runtime/state/project-team";
import type { EnvironmentId } from "@t3tools/contracts";
import type { GoalMapEntry } from "@t3tools/shared/goalMap";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";

export const projectTeamEnvironment = createProjectTeamEnvironmentAtoms(connectionAtomRuntime);

// One subscription per environment, shared by every view of the goal map.
export const environmentProjectTeamAttentionAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ProjectTeamAttentionIndex => {
    const result = get(projectTeamEnvironment.attention({ environmentId, input: {} }));
    return Option.getOrElse(AsyncResult.value(result), () => EMPTY_PROJECT_TEAM_ATTENTION_INDEX);
  }).pipe(Atom.withLabel(`mobile-project-team:attention:${environmentId}`)),
);

const projectManagerEntriesAtom = Atom.family((environmentIdsKey: string) =>
  Atom.make((get): ReadonlyArray<GoalMapEntry> =>
    (environmentIdsKey.split(",") as EnvironmentId[]).flatMap((environmentId) =>
      environmentId === ""
        ? []
        : [...get(environmentProjectTeamAttentionAtom(environmentId)).byProjectId.values()].map(
            (summary) => ({ environmentId, summary }),
          ),
    ),
  ).pipe(Atom.withLabel(`mobile-project-team:entries:${environmentIdsKey}`)),
);

/** Every project manager's attention snapshot across the given environments. */
export function useProjectManagerEntries(environmentIds: ReadonlyArray<EnvironmentId>) {
  return useAtomValue(projectManagerEntriesAtom(environmentIds.join(",")));
}
