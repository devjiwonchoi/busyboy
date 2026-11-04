import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { releaseProjectDraftUploads } from "../lib/composerDraftUploads";
import { readLocalApi } from "../localApi";
import type { SidebarProjectGroupMember, SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { readThreadShells, waitForProjectRemoval } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { readEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

export function reportProjectCommandFailure(
  title: string,
  result: AtomCommandResult<void, unknown>,
): void {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/** Reports and returns a failure when the connection cannot operate one of the members' environments. */
export function checkProjectAccess(
  members: ReadonlyArray<SidebarProjectGroupMember>,
  failureTitle: string,
): AtomCommandResult<void, Error> | null {
  const denied = members.find(
    (member) => !readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
  );
  if (!denied) return null;
  const result = AsyncResult.failure<void, Error>(
    Cause.fail(
      new Error(
        `This connection cannot change projects in ${denied.environmentLabel ?? "this environment"}.`,
      ),
    ),
  );
  reportProjectCommandFailure(failureTitle, result);
  return result;
}

export interface RemoveProjectMembersInput {
  /** The project as the user sees it; `members` is all or part of its checkouts. */
  readonly group: SidebarProjectSnapshot;
  readonly members: ReadonlyArray<SidebarProjectGroupMember>;
  /** The group is a filtered view of a larger project whose other entries stay. */
  readonly hasOtherMembers: boolean;
}

export interface RemovedProjectMembers {
  /** The whole project went, so nothing of it is left to show. */
  readonly removedWholeProject: boolean;
  readonly removedThreadRefs: ReadonlyArray<ScopedThreadRef>;
}

/**
 * Confirms, then force-deletes the given project checkouts with their threads
 * and drafts. Resolves null when the user cancels or a step fails (failures
 * are reported as toasts).
 */
export function useRemoveProjectMembers() {
  const deleteProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });

  return async ({
    group,
    members,
    hasOtherMembers,
  }: RemoveProjectMembersInput): Promise<RemovedProjectMembers | null> => {
    if (checkProjectAccess(members, "Failed to remove project")) return null;
    const api = readLocalApi();
    if (!api) return null;

    const memberKeys = new Set(members.map((member) => `${member.environmentId}:${member.id}`));
    const projectThreads = readThreadShells().filter((thread) =>
      memberKeys.has(`${thread.environmentId}:${thread.projectId}`),
    );
    const isWholeGroup = members.length === group.memberProjects.length;
    const targetKind = hasOtherMembers || !isWholeGroup ? "checkout" : "project";
    const singleMember = members.length === 1 ? members[0]! : null;
    const targetLabel = singleMember?.title ?? group.displayName;
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(
        [
          projectThreads.length > 0
            ? `Remove ${targetKind} "${targetLabel}" and delete its ${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"}?`
            : `Remove ${targetKind} "${targetLabel}"?`,
          ...(singleMember
            ? [
                `Path: ${singleMember.workspaceRoot}`,
                ...(singleMember.environmentLabel
                  ? [`Environment: ${singleMember.environmentLabel}`]
                  : []),
              ]
            : [`This removes ${members.length} grouped project entries.`]),
          ...(projectThreads.length > 0
            ? [
                "This permanently clears conversation history for those threads and any archived threads.",
              ]
            : ["This permanently clears any archived conversation history."]),
          isWholeGroup && !hasOtherMembers
            ? "This removes only the project entries, not the files on disk."
            : "Other entries in this grouped project are unaffected.",
          "This action cannot be undone.",
        ].join("\n"),
        { variant: "destructive" },
      ),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return null;
    if (checkProjectAccess(members, "Failed to remove project")) return null;

    const draftStore = useComposerDraftStore.getState();
    for (const member of members) {
      if (checkProjectAccess([member], "Failed to remove project")) return null;
      const memberThreads = projectThreads.filter(
        (thread) => thread.environmentId === member.environmentId && thread.projectId === member.id,
      );
      const result = mapAtomCommandResult(
        await deleteProject({
          environmentId: member.environmentId,
          input: {
            projectId: member.id,
            force: true,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        reportProjectCommandFailure(`Failed to remove "${member.title}"`, result);
        return null;
      }
      const projectRef = scopeProjectRef(member.environmentId, member.id);
      await waitForProjectRemoval(projectRef);
      releaseProjectDraftUploads(
        projectRef,
        memberThreads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
      );
      const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
      if (projectDraftThread) {
        draftStore.clearDraftThread(projectDraftThread.draftId);
      }
      draftStore.clearProjectDraftThreadId(projectRef);
    }

    return {
      removedWholeProject: isWholeGroup && !hasOtherMembers,
      removedThreadRefs: projectThreads.map((thread) =>
        scopeThreadRef(thread.environmentId, thread.id),
      ),
    };
  };
}
