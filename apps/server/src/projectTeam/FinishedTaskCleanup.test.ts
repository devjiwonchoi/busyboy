// @effect-diagnostics nodeBuiltinImport:off - fixture setup builds a real git repository synchronously.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadWorktreeService from "../orchestration-v2/ThreadWorktreeService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { FinishedTaskCleanup } from "./FinishedTaskCleanup.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import { type TeamHarness, setUpManager, startLead, withTeam } from "./testkit.ts";

const REPOSITORY = "acme/demo";
const prUrl = (number: number) => `https://github.com/${REPOSITORY}/pull/${number}`;

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    stdio: "pipe",
  });

/**
 * A real repository with the server's managed worktrees folder, and the server's
 * real archive cleanup (ThreadWorktreeService) wired to the harness's fake threads.
 */
const makeRepository = (harness: TeamHarness) => {
  const base = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "t3-task-cleanup-")));
  const workspaceRoot = nodePath.join(base, "repo");
  const worktreesDir = nodePath.join(base, "worktrees");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  git(workspaceRoot, "init", "-b", "main");
  git(workspaceRoot, "commit", "--allow-empty", "-m", "init");

  const shell = (threadId: ThreadId) => {
    const thread = harness.threads.get(threadId);
    if (thread === undefined) return null;
    return {
      id: thread.id,
      projectId: thread.projectId,
      worktreePath: thread.worktreePath ?? null,
      branch: thread.branch ?? null,
      archivedAt: thread.archivedAt === null ? null : DateTime.makeUnsafe(thread.archivedAt),
    } as never;
  };

  const worktreeLayer = ThreadWorktreeService.layer.pipe(
    Layer.provide(
      GitWorkflowService.layer.pipe(
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            detect: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
          }),
        ),
        Layer.provide(
          Layer.mock(GitManager.GitManager)({
            invalidateLocalStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            localStatus: (input) =>
              Effect.sync(
                () =>
                  ({
                    refName: git(input.cwd, "rev-parse", "--abbrev-ref", "HEAD").toString().trim(),
                  }) as never,
              ),
            deleteMergedBranch: () => Effect.succeed(false),
          }),
        ),
        Layer.provide(GitVcsDriver.layer),
        Layer.provide(VcsProcess.layer),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ServerConfig.ServerConfig)({ worktreesDir } as never),
        ServerSettings.layerTest(),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: (threadId) => Effect.sync(() => shell(threadId)),
          getThreadWorktreePaths: () =>
            Effect.sync(() =>
              [...harness.threads.values()].flatMap((thread) =>
                thread.archivedAt === null && thread.deletedAt === null && thread.worktreePath
                  ? [{ threadId: thread.id, worktreePath: thread.worktreePath }]
                  : [],
              ),
            ),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () => Effect.succeed(Option.some({ workspaceRoot } as never)),
        }),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

  // Like the server's worktree.cleanup effect, which runs after every archive.
  harness.onArchive = (threadId) =>
    ThreadWorktreeService.ThreadWorktreeService.pipe(
      Effect.flatMap((service) => service.removeForArchive(threadId)),
      Effect.provide(worktreeLayer),
      Effect.orDie,
    );

  return {
    /** A lead thread working in its own worktree on its own branch. */
    addLead: (threadId: ThreadId, prNumber: number | null) => {
      const branch = `task/${threadId}`;
      const worktreePath = nodePath.join(worktreesDir, "repo", threadId);
      git(workspaceRoot, "worktree", "add", "-b", branch, worktreePath);
      const thread = harness.addThread(threadId);
      thread.worktreePath = worktreePath;
      thread.branch = branch;
      thread.pullRequests =
        prNumber === null
          ? []
          : [
              {
                host: "github.com",
                repository: REPOSITORY,
                number: prNumber,
                url: prUrl(prNumber),
              },
            ];
      return worktreePath;
    },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
};

const isArchived = (harness: TeamHarness, threadId: ThreadId) =>
  harness.threads.get(threadId)?.archivedAt !== null;

describe("FinishedTaskCleanup", () => {
  it.effect(
    "archives a finished task's lead and removes its worktree, and keeps it while the PR is open",
    () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const cleanup = yield* FinishedTaskCleanup;
          const team = yield* ProjectTeamService.ProjectTeamService;
          const repo = makeRepository(harness);
          yield* Effect.addFinalizer(() => Effect.sync(repo.cleanup));
          const pm = yield* setUpManager;

          const merged = yield* startLead(pm, "Merged", harness.delegate);
          const mergedWorktree = repo.addLead(merged.leadThreadId, 1);
          // A provider subagent of the lead shares its worktree.
          const helper = harness.addThread(ThreadId.make("lead-1-helper"));
          helper.worktreePath = mergedWorktree;
          helper.parentThreadId = merged.leadThreadId;

          const reviewing = yield* startLead(pm, "Reviewing", harness.delegate);
          const reviewingWorktree = repo.addLead(reviewing.leadThreadId, 2);

          // Both leads open a PR; the first is merged and its lead marks the task done.
          yield* team.updateTask(merged.leadThreadId, { stage: "in_review", prUrl: prUrl(1) });
          yield* team.updateTask(merged.leadThreadId, { stage: "done" });
          yield* team.updateTask(reviewing.leadThreadId, { stage: "in_review", prUrl: prUrl(2) });
          harness.pullRequestStates.set(1, "merged");
          harness.pullRequestStates.set(2, "open");

          yield* cleanup.sweep;

          assert.isTrue(isArchived(harness, merged.leadThreadId));
          assert.isTrue(isArchived(harness, helper.id));
          assert.isFalse(fs.existsSync(mergedWorktree));
          // The branch is kept for the merged-branch check; only the folder goes.
          assert.isFalse(isArchived(harness, reviewing.leadThreadId));
          assert.isTrue(fs.existsSync(reviewingWorktree));

          // The second PR is merged while the task is still in review.
          harness.pullRequestStates.set(2, "merged");
          yield* TestClock.adjust("5 minutes");
          yield* cleanup.sweep;
          assert.isTrue(isArchived(harness, reviewing.leadThreadId));
          assert.isFalse(fs.existsSync(reviewingWorktree));
        }).pipe(Effect.scoped),
      ),
  );

  it.effect(
    "cleans up cancelled and PR-less done tasks, keeps uncommitted work and busy leads",
    () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const cleanup = yield* FinishedTaskCleanup;
          const team = yield* ProjectTeamService.ProjectTeamService;
          const repo = makeRepository(harness);
          yield* Effect.addFinalizer(() => Effect.sync(repo.cleanup));
          const pm = yield* setUpManager;

          const noPr = yield* startLead(pm, "Research", harness.delegate);
          const noPrWorktree = repo.addLead(noPr.leadThreadId, null);
          yield* team.updateTask(noPr.leadThreadId, { stage: "done" });

          const cancelled = yield* startLead(pm, "Dropped", harness.delegate);
          const cancelledWorktree = repo.addLead(cancelled.leadThreadId, null);
          fs.writeFileSync(nodePath.join(cancelledWorktree, "draft.txt"), "unsaved");
          yield* team.updateTask(pm, { taskId: cancelled.task.id, stage: "cancelled" });

          const busy = yield* startLead(pm, "Busy", harness.delegate);
          const busyWorktree = repo.addLead(busy.leadThreadId, null);
          yield* team.updateTask(busy.leadThreadId, { stage: "done" });
          harness.threads.get(busy.leadThreadId)!.activeRunId = "run-busy";

          const unknownPr = yield* startLead(pm, "Unknown PR", harness.delegate);
          const unknownWorktree = repo.addLead(unknownPr.leadThreadId, 9);
          yield* team.updateTask(unknownPr.leadThreadId, { stage: "done", prUrl: prUrl(9) });

          yield* cleanup.sweep;

          assert.isTrue(isArchived(harness, noPr.leadThreadId));
          assert.isFalse(fs.existsSync(noPrWorktree));
          // Archived, but git refuses to drop the uncommitted file without force.
          assert.isTrue(isArchived(harness, cancelled.leadThreadId));
          assert.isTrue(fs.existsSync(nodePath.join(cancelledWorktree, "draft.txt")));
          // A running lead and a PR whose state cannot be read are left alone.
          assert.isFalse(isArchived(harness, busy.leadThreadId));
          assert.isTrue(fs.existsSync(busyWorktree));
          assert.isFalse(isArchived(harness, unknownPr.leadThreadId));
          assert.isTrue(fs.existsSync(unknownWorktree));

          // A thread the user unarchives after cleanup is not archived again.
          const archiveCount = Ref.get(harness.dispatched).pipe(
            Effect.map((commands) => commands.filter((c) => c.type === "thread.archive").length),
          );
          const before = yield* archiveCount;
          harness.threads.get(noPr.leadThreadId)!.archivedAt = null;
          yield* cleanup.sweep;
          assert.strictEqual(yield* archiveCount, before);
        }).pipe(Effect.scoped),
      ),
  );
});
