import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { readDraftPlan } from "./cards/plan";
import { parsePullRequests } from "./cards/work-cards";
import { runWithDataFolder } from "./config";
import { pathKey } from "./paths";
import { getProject } from "./projects";
import { parseRecords } from "./records/parse-records";
import { locateTaskRecords } from "./records/record-location";
import { getAgent, isStoppingAllAgents } from "./runner/agent-runner";
import { findExecutable } from "./runner/find-executable";
import { onServerShutdown } from "./shutdown";
import { autoArchiveDecision, type AutoArchiveFacts } from "./task-lifecycle";
import { archiveTask, readTasksAt, TaskError, taskView, type TaskRecord } from "./tasks";

const run = promisify(execFile);

const PULL_CHECK_MS = 15_000;

const SETTLED = new Set(["MERGED", "CLOSED"]);

type Watch = { ids: Set<string>; timer: ReturnType<typeof setInterval> | null };

const WATCHES_KEY = Symbol.for("busyboy.auto-archive-watches");
const watchStore = globalThis as typeof globalThis & { [WATCHES_KEY]?: Map<string, Watch> };
const watches = (watchStore[WATCHES_KEY] ??= new Map());

const reported = new Set<string>();

function reportOnce(key: string, message: string) {
  if (reported.has(key)) return;
  reported.add(key);
  console.error(message);
}

function watchFor(folder: string) {
  const key = pathKey(folder);
  let watch = watches.get(key);
  if (!watch) {
    watch = { ids: new Set(), timer: null };
    watches.set(key, watch);
  }
  return watch;
}

function forgetPullWatch(folder: string, taskId: string) {
  const watch = watches.get(pathKey(folder));
  if (!watch) return;
  watch.ids.delete(taskId);
  if (watch.ids.size === 0 && watch.timer) {
    clearInterval(watch.timer);
    watch.timer = null;
  }
}

// A pull request can merge after the agent has already finished.
function watchPulls(folder: string, taskId: string) {
  const watch = watchFor(folder);
  watch.ids.add(taskId);
  if (watch.timer) return;
  const timer = setInterval(() => {
    if (isStoppingAllAgents() || watch.ids.size === 0) {
      clearInterval(timer);
      watch.timer = null;
      return;
    }
    for (const id of watch.ids) void considerAutoArchive(folder, id);
  }, PULL_CHECK_MS);
  // The process can exit while a finished task is waiting on its pull requests.
  timer.unref();
  watch.timer = timer;
}

onServerShutdown(() => {
  for (const watch of watches.values()) {
    if (watch.timer) clearInterval(watch.timer);
    watch.timer = null;
  }
});

// A live idle agent just ended its turn. With no process, only a stored `idle`
// counts: that turn finished before this process started. A task with no
// activity was never run, so it stays.
function turnFinished(task: TaskRecord) {
  const agent = getAgent(task.agentId);
  if (agent && agent.status !== "stopped") return agent.status === "idle";
  return task.activity === "idle";
}

async function readStatus(folder: string, task: Pick<TaskRecord, "id" | "project" | "worktree">) {
  const located = await locateTaskRecords(folder, task);
  if (!located || !("folder" in located)) return null;
  const path = join(/*turbopackIgnore: true*/ located.folder, "STATUS.md");
  try {
    if ((await lstat(/*turbopackIgnore: true*/ path)).isSymbolicLink()) return null;
    const text = await readFile(/*turbopackIgnore: true*/ path, "utf8");
    return { state: parseRecords({ "STATUS.md": text }).state, pulls: parsePullRequests(text) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function githubCli() {
  return process.env.BUSYBOY_GH_PATH || findExecutable("gh");
}

async function pullState(gh: string, checkout: string, number: number): Promise<string | null> {
  try {
    const { stdout } = await run(gh, ["pr", "view", String(number), "--json", "state"], {
      cwd: checkout,
      timeout: 20_000,
    });
    const state = (JSON.parse(stdout) as { state?: unknown }).state;
    return typeof state === "string" ? state.toUpperCase() : null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    reportOnce(
      `pr:${checkout}:${number}`,
      `busyboy: could not read pull request #${number}: ${detail}`,
    );
    return null;
  }
}

// An unreadable state is not closed. Guessing would put the task away too soon.
async function pullRequestsSettled(checkout: string, numbers: number[]) {
  const gh = githubCli();
  if (!gh) {
    reportOnce(
      "gh-missing",
      "busyboy: the GitHub CLI (gh) is not installed, so a finished task with pull requests stays until it is.",
    );
    return false;
  }
  const states = await Promise.all(numbers.map((number) => pullState(gh, checkout, number)));
  return states.every((state) => state !== null && SETTLED.has(state));
}

function archiveFacts(
  task: TaskRecord | undefined,
  extra: Pick<
    AutoArchiveFacts,
    "stoppingAll" | "draft" | "recordDone" | "openPulls" | "pullsSettled"
  >,
): AutoArchiveFacts {
  const view = task ? taskView(task) : null;
  return {
    stoppingAll: extra.stoppingAll,
    present: Boolean(task),
    archived: Boolean(task?.archivedAt),
    subagent: task?.kind === "subagent",
    turnFinished: task ? turnFinished(task) : false,
    runningOrNeedsYou: view?.status === "running" || view?.status === "needs-you",
    draft: extra.draft,
    recordDone: extra.recordDone,
    openPulls: extra.openPulls,
    pullsSettled: extra.pullsSettled,
  };
}

function readyToRead(task: TaskRecord | undefined) {
  if (!task || task.archivedAt || task.kind === "subagent" || !turnFinished(task)) return false;
  const { status } = taskView(task);
  return status !== "running" && status !== "needs-you";
}

async function consider(folder: string, taskId: string) {
  const stoppingAll = isStoppingAllAgents();
  const task = stoppingAll
    ? undefined
    : (await readTasksAt(folder)).find(({ id }) => id === taskId);
  const readable = !stoppingAll && readyToRead(task);
  const draft = readable && task ? Boolean(await readDraftPlan(folder, task)) : false;
  const status = readable && task && !draft ? await readStatus(folder, task) : null;
  const openPulls = (status?.pulls.length ?? 0) > 0;
  let pullsSettled = false;
  if (readable && task && status?.state === "done" && openPulls) {
    const project = await getProject(task.project);
    if (project) {
      pullsSettled = await pullRequestsSettled(
        project.path,
        status.pulls.map((pull) => pull.number),
      );
    }
  }
  const decision = autoArchiveDecision(
    archiveFacts(task, {
      stoppingAll,
      draft,
      recordDone: status?.state === "done",
      openPulls,
      pullsSettled,
    }),
  );
  if (decision === "forget") {
    forgetPullWatch(folder, taskId);
    return;
  }
  if (decision === "watch") {
    watchPulls(folder, taskId);
    return;
  }
  if (decision !== "archive") return;

  // Read again: a message can start the agent while the pull requests are checked.
  const latest = (await readTasksAt(folder)).find(({ id }) => id === taskId);
  const latestReadable = readyToRead(latest);
  const latestDraft =
    latestReadable && latest ? Boolean(await readDraftPlan(folder, latest)) : false;
  const again = autoArchiveDecision(
    archiveFacts(latest, {
      stoppingAll: false,
      draft: latestDraft,
      recordDone: true,
      openPulls: false,
      pullsSettled: true,
    }),
  );
  if (again !== "archive") return;
  try {
    await archiveTask(taskId);
  } catch (error) {
    // It started working again, or it is already archived. The next finish decides.
    if (error instanceof TaskError) return;
    throw error;
  }
  forgetPullWatch(folder, taskId);
}

// A turn ends outside a request, so the data folder is the one the task was created in.
export function considerAutoArchive(folder: string, taskId: string) {
  return runWithDataFolder(folder, () => consider(folder, taskId)).catch((error: unknown) => {
    console.error(`busyboy: could not archive finished task ${taskId}`, error);
  });
}

export async function archiveFinishedTasks(folder: string) {
  if (isStoppingAllAgents()) return;
  const tasks = await readTasksAt(folder).catch(() => [] as TaskRecord[]);
  for (const task of tasks) {
    if (isStoppingAllAgents()) return;
    await considerAutoArchive(folder, task.id);
  }
}
