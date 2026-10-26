import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

/**
 * Archiving a thread removes its worktree, and unarchiving can restore it.
 * The thread keeps its branch and worktree path, so a restore checks the same
 * branch out at the same path.
 */
export class ThreadWorktreeService extends Context.Reference<{
  readonly removeForArchive: (threadId: ThreadId) => Effect.Effect<void>;
  readonly restore: (threadId: ThreadId) => Effect.Effect<void>;
}>("t3/orchestration-v2/ThreadWorktreeService", {
  defaultValue: () => ({
    removeForArchive: () => Effect.void,
    restore: () => Effect.void,
  }),
}) {}

// Both operations are best effort: a kept or missing worktree must not block
// the thread's later effects, and turn start recreates a missing worktree.
const logFailure =
  (message: string, threadId: ThreadId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(message, { threadId, cause: Cause.pretty(cause) }),
      ),
    );

export const layer = Layer.effect(
  ThreadWorktreeService,
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

    // Only worktrees the server made, so a folder the user picked is never removed.
    const readManagedWorktree = Effect.fn("ThreadWorktreeService.readManagedWorktree")(function* (
      threadId: ThreadId,
    ) {
      const thread = yield* projections.getThreadShell(threadId);
      if (thread === null || thread.worktreePath === null || thread.branch === null) {
        return null;
      }
      if (!(yield* isManagedWorktreePath(thread.worktreePath))) {
        return null;
      }

      const project = yield* projects.get(thread.projectId);
      if (Option.isNone(project)) {
        return null;
      }

      return {
        thread,
        worktreePath: thread.worktreePath,
        branch: thread.branch,
        workspaceRoot: project.value.workspaceRoot,
      };
    });

    const removeForArchive = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const worktree = yield* readManagedWorktree(threadId);
        // The thread may have been unarchived before this ran.
        if (worktree === null || worktree.thread.archivedAt === null) {
          return;
        }
        const { worktreePath, branch, workspaceRoot } = worktree;
        if (!(yield* fileSystem.exists(worktreePath))) {
          return;
        }

        // Active threads still working in this worktree keep it.
        const activeWorktreePaths = yield* projections.getThreadWorktreePaths();
        if (
          activeWorktreePaths.some(
            (entry) => path.resolve(entry.worktreePath) === path.resolve(worktreePath),
          )
        ) {
          return;
        }

        // Restore checks out the thread's branch, so a worktree on another
        // branch or a detached HEAD would not come back the same.
        yield* gitWorkflow.invalidateLocalStatus(worktreePath);
        const status = yield* gitWorkflow.localStatus({ cwd: worktreePath });
        if (status.refName !== branch) {
          return yield* Effect.logInfo("Kept archived thread worktree on a different branch", {
            threadId,
            worktreePath,
            branch,
            checkedOut: status.refName,
          });
        }

        // Without force, git refuses to remove a worktree with uncommitted or
        // untracked files, so unsaved work stays on disk.
        yield* withWorkspaceLease(
          worktreePath,
          gitWorkflow.removeWorktree({ cwd: workspaceRoot, path: worktreePath }),
        );
        yield* gitWorkflow.invalidateStatus(workspaceRoot);
      }).pipe(logFailure("Failed to remove archived thread worktree", threadId));

    const restore = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const worktree = yield* readManagedWorktree(threadId);
        // The thread may have been archived again before this ran.
        if (worktree === null || worktree.thread.archivedAt !== null) {
          return;
        }
        const { thread, worktreePath, branch, workspaceRoot } = worktree;
        if (yield* fileSystem.exists(worktreePath)) {
          return;
        }

        // Git still lists a removed worktree until it is pruned, and refuses
        // to add a new one at that path.
        yield* gitWorkflow.pruneWorktrees({ cwd: workspaceRoot });
        yield* gitWorkflow.createWorktree({
          cwd: workspaceRoot,
          refName: branch,
          path: worktreePath,
        });

        // A fresh checkout has no ignored files such as installed
        // dependencies, so it gets the same setup as a new worktree.
        yield* setupScripts.runForThread({
          threadId,
          projectId: thread.projectId,
          projectCwd: workspaceRoot,
          worktreePath,
        });
      }).pipe(logFailure("Failed to restore thread worktree", threadId));

    return { removeForArchive, restore };
  }),
);
