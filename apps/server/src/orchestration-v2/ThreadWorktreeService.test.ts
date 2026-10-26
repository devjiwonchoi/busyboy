import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { GitCommandError, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadWorktreeService from "./ThreadWorktreeService.ts";

const threadId = ThreadId.make("thread-worktree");
const projectId = ProjectId.make("thread-worktree-project");
const branch = "feature/thread-worktree";

type Scenario = {
  readonly operation: "removeForArchive" | "restore";
  readonly archived: boolean;
  readonly worktreeExists: boolean;
  readonly managed?: boolean;
  readonly sharedWithActiveThread?: boolean;
  readonly checkedOut?: string | null;
  readonly removeFails?: boolean;
};

// Runs one operation against a temp worktree folder and records the git and
// setup calls it makes.
const run = (scenario: Scenario) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-worktree-" }),
    );
    const worktreesDir = path.join(workspaceRoot, "worktrees");
    const worktreePath =
      scenario.managed === false
        ? path.join(workspaceRoot, "elsewhere", "feature")
        : path.join(worktreesDir, "repo", "feature");
    if (scenario.worktreeExists) {
      yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
    }

    const calls: string[] = [];
    const thread = {
      id: threadId,
      projectId,
      worktreePath,
      branch,
      archivedAt: scenario.archived ? DateTime.makeUnsafe("2026-10-26T00:00:00.000Z") : null,
    };
    const testLayer = ThreadWorktreeService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ServerConfig.ServerConfig)({ worktreesDir } as never),
          ServerSettings.layerTest(),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: () => Effect.succeed(thread as never),
            getThreadWorktreePaths: () =>
              Effect.succeed(
                scenario.sharedWithActiveThread
                  ? [{ threadId: ThreadId.make("thread-worktree-sibling"), worktreePath }]
                  : [],
              ),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeed(Option.some({ workspaceRoot } as never)),
          }),
          Layer.mock(GitWorkflow.GitWorkflowService)({
            invalidateLocalStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            localStatus: () =>
              Effect.succeed({
                refName: scenario.checkedOut === undefined ? branch : scenario.checkedOut,
              } as never),
            removeWorktree: (input) =>
              Effect.gen(function* () {
                assert.deepEqual(input, { cwd: workspaceRoot, path: worktreePath });
                calls.push("remove");
                if (scenario.removeFails) {
                  return yield* new GitCommandError({
                    operation: "GitVcsDriver.removeWorktree",
                    command: "git worktree remove",
                    cwd: workspaceRoot,
                    detail: "git worktree remove failed",
                  });
                }
              }),
            deleteMergedBranch: (input) =>
              Effect.sync(() => {
                assert.deepEqual(input, { cwd: workspaceRoot, branch });
                calls.push("delete merged branch");
                return true;
              }),
            pruneWorktrees: (input) =>
              Effect.sync(() => {
                assert.deepEqual(input, { cwd: workspaceRoot });
                calls.push("prune");
              }),
            createWorktree: (input) =>
              Effect.sync(() => {
                assert.deepEqual(input, {
                  cwd: workspaceRoot,
                  refName: branch,
                  path: worktreePath,
                });
                calls.push("create");
                return {} as never;
              }),
          }),
          Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
            runForThread: (input) =>
              Effect.sync(() => {
                assert.deepEqual(input, {
                  threadId,
                  projectId,
                  projectCwd: workspaceRoot,
                  worktreePath,
                });
                calls.push("setup");
                return { status: "no-script" } as const;
              }),
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const service = yield* ThreadWorktreeService.ThreadWorktreeService;
      yield* service[scenario.operation](threadId);
    }).pipe(Effect.provide(testLayer));

    return calls;
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

it.effect.each([
  {
    name: "removes the worktree of an archived thread, then its branch if merged",
    scenario: { operation: "removeForArchive", archived: true, worktreeExists: true },
    expected: ["remove", "delete merged branch"],
  },
  {
    name: "keeps the worktree when the thread was unarchived first",
    scenario: { operation: "removeForArchive", archived: false, worktreeExists: true },
    expected: [],
  },
  {
    name: "keeps a worktree an active thread still uses",
    scenario: {
      operation: "removeForArchive",
      archived: true,
      worktreeExists: true,
      sharedWithActiveThread: true,
    },
    expected: [],
  },
  {
    name: "keeps a worktree on another branch",
    scenario: {
      operation: "removeForArchive",
      archived: true,
      worktreeExists: true,
      checkedOut: "other-branch",
    },
    expected: [],
  },
  {
    name: "keeps a folder the server did not make",
    scenario: {
      operation: "removeForArchive",
      archived: true,
      worktreeExists: true,
      managed: false,
    },
    expected: [],
  },
  {
    name: "keeps going when git refuses to remove a worktree with changes",
    scenario: {
      operation: "removeForArchive",
      archived: true,
      worktreeExists: true,
      removeFails: true,
    },
    expected: ["remove"],
  },
  {
    name: "restores a removed worktree and runs setup",
    scenario: { operation: "restore", archived: false, worktreeExists: false },
    expected: ["prune", "create", "setup"],
  },
  {
    name: "leaves an existing worktree alone on restore",
    scenario: { operation: "restore", archived: false, worktreeExists: true },
    expected: [],
  },
  {
    name: "does not restore for a thread archived again",
    scenario: { operation: "restore", archived: true, worktreeExists: false },
    expected: [],
  },
] satisfies ReadonlyArray<{
  readonly name: string;
  readonly scenario: Scenario;
  readonly expected: ReadonlyArray<string>;
}>)("$name", ({ scenario, expected }) =>
  Effect.gen(function* () {
    assert.deepEqual(yield* run(scenario), expected);
  }),
);
