// @effect-diagnostics nodeBuiltinImport:off - fixture setup builds a real git repository synchronously.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

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
import { START, type TeamHarness, setUpManager, startLead, withTeam } from "./testkit.ts";

const PR_URL = "https://github.com/acme/demo/pull/1";

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
            // GitManager adds hooks and caching around this one git call.
            createWorktree: (input) =>
              Effect.sync(() => {
                git(input.cwd, "worktree", "add", input.path!, input.refName);
                return {} as never;
              }),
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
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" } as const),
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

  // Like the server's worktree.cleanup and worktree.restore effects.
  const runWorktreeEffect = (operation: "removeForArchive" | "restore", threadId: ThreadId) =>
    ThreadWorktreeService.ThreadWorktreeService.pipe(
      Effect.flatMap((service) => service[operation](threadId)),
      Effect.provide(worktreeLayer),
      Effect.orDie,
    );
  harness.onArchive = (threadId) => runWorktreeEffect("removeForArchive", threadId);
  harness.onRestore = (threadId) => runWorktreeEffect("restore", threadId);
  harness.checkedOutBranch = (cwd) =>
    fs.existsSync(cwd) ? git(cwd, "rev-parse", "--abbrev-ref", "HEAD").toString().trim() : null;

  return {
    /** A lead thread working in its own worktree on its own branch. */
    addLead: (threadId: ThreadId) => {
      const branch = `task/${threadId}`;
      const worktreePath = nodePath.join(worktreesDir, "repo", threadId);
      git(workspaceRoot, "worktree", "add", "-b", branch, worktreePath);
      const thread = harness.addThread(threadId);
      thread.worktreePath = worktreePath;
      thread.branch = branch;
      return worktreePath;
    },
    hasBranch: (branch: string) =>
      git(workspaceRoot, "branch", "--list", branch).toString().trim() !== "",
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
};

const isArchived = (harness: TeamHarness, threadId: ThreadId) =>
  harness.threads.get(threadId)?.archivedAt !== null;

/** The event the server emits when a lead's turn ends. */
const turnEnded = (threadId: ThreadId, runId: string) =>
  ({
    type: "run.updated",
    threadId,
    payload: { id: runId, threadId, status: "completed", startedAt: DateTime.makeUnsafe(START) },
  }) as unknown as OrchestrationV2DomainEvent;

describe("FinishedTaskCleanup", () => {
  it.effect(
    "a done task's lead and worktree go once its turn ends, and reopening the task brings them back",
    () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const cleanup = yield* FinishedTaskCleanup;
          const team = yield* ProjectTeamService.ProjectTeamService;
          const repo = makeRepository(harness);
          yield* Effect.addFinalizer(() => Effect.sync(repo.cleanup));
          const pm = yield* setUpManager;

          const { task, leadThreadId: lead } = yield* startLead(pm, "Feature", harness.delegate);
          const worktree = repo.addLead(lead);
          // The lead works on its own branch name, not the thread's.
          git(worktree, "checkout", "-b", "feature-x");
          // A provider subagent of the lead shares its worktree.
          const helper = harness.addThread(ThreadId.make("lead-1-helper"));
          helper.worktreePath = worktree;
          helper.parentThreadId = lead;

          // The lead marks its own task done mid-turn; it keeps its worktree until the turn ends.
          harness.threads.get(lead)!.activeRunId = "run-1";
          yield* team.updateTask(lead, { stage: "done", prUrl: PR_URL });
          assert.isFalse(isArchived(harness, lead));
          assert.isTrue(fs.existsSync(worktree));

          harness.threads.get(lead)!.activeRunId = null;
          yield* cleanup.handleEvent(turnEnded(lead, "run-1"));
          assert.isTrue(isArchived(harness, lead));
          assert.isTrue(isArchived(harness, helper.id));
          assert.isFalse(fs.existsSync(worktree));
          assert.isTrue(repo.hasBranch("feature-x"));

          // The PM reopens the task, like moving it from Done back to In Progress.
          yield* team.updateTask(pm, { taskId: task.id, stage: "running" });
          assert.isFalse(isArchived(harness, lead));
          assert.isTrue(fs.existsSync(worktree));
          assert.strictEqual(harness.checkedOutBranch(worktree), "feature-x");
        }).pipe(Effect.scoped),
      ),
  );

  it.effect(
    "a PM cancel archives at once but keeps uncommitted work, and startup cleans up tasks already done",
    () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const cleanup = yield* FinishedTaskCleanup;
          const team = yield* ProjectTeamService.ProjectTeamService;
          const repo = makeRepository(harness);
          yield* Effect.addFinalizer(() => Effect.sync(repo.cleanup));
          const pm = yield* setUpManager;

          const dropped = yield* startLead(pm, "Dropped", harness.delegate);
          const droppedWorktree = repo.addLead(dropped.leadThreadId);
          fs.writeFileSync(nodePath.join(droppedWorktree, "draft.txt"), "unsaved");
          harness.threads.get(dropped.leadThreadId)!.activeRunId = "run-dropped";
          yield* team.updateTask(pm, { taskId: dropped.task.id, stage: "cancelled" });
          assert.isTrue(isArchived(harness, dropped.leadThreadId));
          // Git refuses to drop the uncommitted file without force.
          assert.isTrue(fs.existsSync(nodePath.join(droppedWorktree, "draft.txt")));

          // Two tasks finished before this change: their leads are idle but still active.
          const finished = yield* startLead(pm, "Finished", harness.delegate);
          const finishedWorktree = repo.addLead(finished.leadThreadId);
          const busy = yield* startLead(pm, "Busy", harness.delegate);
          const busyWorktree = repo.addLead(busy.leadThreadId);
          for (const { leadThreadId } of [finished, busy]) {
            harness.threads.get(leadThreadId)!.activeRunId = "run-old";
            yield* team.updateTask(leadThreadId, { stage: "done" });
          }
          harness.threads.get(finished.leadThreadId)!.activeRunId = null;

          yield* cleanup.sweep;
          assert.isTrue(isArchived(harness, finished.leadThreadId));
          assert.isFalse(fs.existsSync(finishedWorktree));
          // A lead still at work is left for the end of its turn.
          assert.isFalse(isArchived(harness, busy.leadThreadId));
          assert.isTrue(fs.existsSync(busyWorktree));
        }).pipe(Effect.scoped),
      ),
  );
});
