import { useAtomValue } from "@effect/atom-react";
import {
  createProjectTeamEnvironmentAtoms,
  EMPTY_PROJECT_TEAM_ATTENTION_INDEX,
  type ProjectTeamAttentionIndex,
} from "@t3tools/client-runtime/state/project-team";
import type {
  EnvironmentId,
  ProjectId,
  ProjectTaskReference,
  ProjectTeamAnswerDecisionInput,
  ProjectTeamSnoozeDecisionInput,
  ProjectTeamUnsnoozeDecisionInput,
  ProjectTeamMoveTaskInput,
  ThreadId,
} from "@t3tools/contracts";
import type { GoalMapEntry } from "@t3tools/shared/goalMap";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "./use-atom-command";

export const projectTeamEnvironment = createProjectTeamEnvironmentAtoms(connectionAtomRuntime);

// Only successful streams establish an alert baseline, including after reconnects.
const loadedAttentionEnvironmentsAtom = Atom.family((environmentIdsKey: string) =>
  Atom.make((get) =>
    (environmentIdsKey.split(",") as EnvironmentId[]).filter(
      (environmentId) =>
        environmentId !== "" &&
        AsyncResult.isSuccess(get(projectTeamEnvironment.attention({ environmentId, input: {} }))),
    ),
  ),
);

export function useLoadedProjectTeamEnvironmentIds(environmentIds: ReadonlyArray<EnvironmentId>) {
  return useAtomValue(loadedAttentionEnvironmentsAtom(environmentIds.join(",")));
}

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

/** One environment's project manager summaries, for the cards a thread shows. */
export function useEnvironmentProjectTeamAttention(environmentId: EnvironmentId) {
  return useAtomValue(environmentProjectTeamAttentionAtom(environmentId));
}

/** Answers a blocker or decision card; the server relays it to the thread that asked. */
export function useAnswerDecision() {
  const answerDecision = useAtomCommand(projectTeamEnvironment.answerDecision);
  return (environmentId: EnvironmentId, input: ProjectTeamAnswerDecisionInput) =>
    answerDecision({ environmentId, input });
}

/** Sets a card aside with the user's reason; it leaves the waiting list until brought back. */
export function useSnoozeDecision() {
  const snoozeDecision = useAtomCommand(projectTeamEnvironment.snoozeDecision);
  return (environmentId: EnvironmentId, input: ProjectTeamSnoozeDecisionInput) =>
    snoozeDecision({ environmentId, input });
}

/** Brings a snoozed card back to the waiting list. */
export function useUnsnoozeDecision() {
  const unsnoozeDecision = useAtomCommand(projectTeamEnvironment.unsnoozeDecision);
  return (environmentId: EnvironmentId, input: ProjectTeamUnsnoozeDecisionInput) =>
    unsnoozeDecision({ environmentId, input });
}

const NO_ATTENTION_ATOM = Atom.make(EMPTY_PROJECT_TEAM_ATTENTION_INDEX);

/** The task this thread leads, or null when it leads none. */
export function useLeadThreadTask(
  thread: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly id: ThreadId;
  } | null,
): ProjectTaskReference | null {
  const attention = useAtomValue(
    thread === null ? NO_ATTENTION_ATOM : environmentProjectTeamAttentionAtom(thread.environmentId),
  );
  if (thread === null) return null;
  return (
    attention.byProjectId
      .get(thread.projectId)
      ?.tasks.find((task) => task.leadThreadId === thread.id) ?? null
  );
}

/** Moves a task's lead between the Mac and a cloud sandbox; resolves once the move is done. */
export function useMoveTask() {
  const moveTask = useAtomCommand(projectTeamEnvironment.moveTask, { reportFailure: false });
  return (environmentId: EnvironmentId, input: ProjectTeamMoveTaskInput) =>
    moveTask({ environmentId, input });
}
