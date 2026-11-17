import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import { SERVER_TOKEN_ENV, TEST_MODE_ENV } from "@/lib/server-token";

import { dataFolder } from "./config";
import { samePath } from "./paths";
import { readTasksAt, TaskError, WORKTREES_FOLDER, type TaskRecord } from "./tasks";

// Never while the server has a launch token, which the desktop app always sets.
export function isTestMode() {
  return process.env[TEST_MODE_ENV] === "1" && !process.env[SERVER_TOKEN_ENV];
}

function isDirectory(path: string) {
  return existsSync(path) && statSync(path).isDirectory();
}

export type WorkingDirectory = {
  cwd: string;
  task: Pick<TaskRecord, "id" | "project" | "title"> | null;
};

// The client names a task, never a folder. An edited task list must not point a shell anywhere else.
export async function currentWorkingDirectory({
  taskId,
  testOverride,
}: {
  taskId: string | null;
  testOverride: string | null;
}): Promise<WorkingDirectory> {
  if (testOverride && isTestMode() && isAbsolute(testOverride) && isDirectory(testOverride)) {
    return { cwd: testOverride, task: null };
  }
  if (!taskId) {
    return { cwd: homedir(), task: null };
  }

  const folder = await dataFolder();
  const tasks = await readTasksAt(folder).catch((error: unknown) => {
    throw new TaskError(
      `The task list could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const task = tasks.find(({ id }) => id === taskId);
  if (!task) {
    throw new TaskError("That task no longer exists.");
  }
  if (!isDirectory(task.worktree)) {
    throw new TaskError(`The worktree of "${task.title}" is gone: ${task.worktree}`);
  }

  // A link inside the worktrees folder must not lead out, and a link put in the task's own place must fail.
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  };
  const worktree = real(task.worktree);
  const isSegment = (name: string) => basename(name) === name && name !== "." && name !== "..";
  const worktrees = real(join(folder, WORKTREES_FOLDER));
  const inPlace = isSegment(task.project) && isSegment(task.id) && worktrees !== null;
  // Without the ignore comment Turbopack traces the whole project for a path built at run time.
  if (
    !worktree ||
    !inPlace ||
    !samePath(worktree, join(/*turbopackIgnore: true*/ worktrees, task.project, task.id))
  ) {
    throw new TaskError(`The worktree of "${task.title}" is not one of BusyBoy's task worktrees.`);
  }

  return { cwd: worktree, task: { id: task.id, project: task.project, title: task.title } };
}
