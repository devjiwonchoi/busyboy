import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { readSettingsAt } from "../config";
import { containsPath, pathKey } from "../paths";
import { repositoryDirectory, repoSegments } from "./record-path";
import { rememberRoot } from "./remember-root";

const APPROVED = /^(?:\W*Version:[^·\n]*·)?\W*Status:\s*approved\b/im;
const FENCE = /^\s*(```|~~~)/;
const NUMBERED = /^(\d+[a-z]?)\s*·\s*(.+)$/i;
const MET = /^(met|pass(?:ed)?|ok|proven|yes|done)\b/i;
const UNMET = /^(not met|unmet|fail(?:ed)?|no|missing)\b/i;

type Line = { text: string; inFence: boolean };

export type TaskAchievement = {
  project: string;
  taskId: string;
  title: string;
  met: number;
  agreed: number;
  at: string;
  done: boolean;
};

export type WeekAchievement = {
  start: string;
  label: string;
  met: number;
  agreed: number;
  tasks: { project: string; taskId: string; title: string; met: number; agreed: number }[];
};

export type AchievementResult =
  | { ok: true; tasks: TaskAchievement[]; weeks: WeekAchievement[] }
  | { ok: false; error: string };

type Cache = Map<string, { key: string; result: AchievementResult }>;
const CACHE_KEY = Symbol.for("busyboy.end-state");
const globalStore = globalThis as typeof globalThis & { [CACHE_KEY]?: Cache };
const cache: Cache = (globalStore[CACHE_KEY] ??= new Map());

export function weekStart(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay();
  utc.setUTCDate(utc.getUTCDate() - (day === 0 ? 6 : day - 1));
  return utc.toISOString().slice(0, 10);
}

const weekFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export function weekLabel(start: string) {
  const [year, month, day] = start.split("-").map(Number);
  const monday = new Date(Date.UTC(year, month - 1, day));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return `${weekFormat.format(monday)} – ${weekFormat.format(sunday)}`;
}

function toLines(text: string): Line[] {
  let inFence = false;
  return text.split(/\r?\n/).map((text) => {
    const isFence = FENCE.test(text);
    const line = { text, inFence: inFence || isFence };
    if (isFence) inFence = !inFence;
    return line;
  });
}

function headingOf(line: Line) {
  if (line.inFence) return null;
  const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line.text);
  return match ? { level: match[1].length, title: match[2].trim() } : null;
}

const sectionName = (title: string) =>
  title
    .replace(/^\d+[a-z]?\s*·\s*/i, "")
    .trim()
    .toLowerCase();

function section(lines: Line[], name: string) {
  const start = lines.findIndex((line) => {
    const heading = headingOf(line);
    return heading?.level === 1 && sectionName(heading.title) === name;
  });
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => headingOf(line)?.level === 1);
  return end === -1 ? rest : rest.slice(0, end);
}

function tableCells(text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("|")) return null;
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const isSeparator = (cells: string[]) => cells.every((cell) => /^:?-{3,}:?$/.test(cell));

function tableRows(lines: Line[]) {
  const rows: { header: string[]; cells: string[] }[] = [];
  let header: string[] | null = null;
  lines.forEach((line, index) => {
    const cells = line.inFence ? null : tableCells(line.text);
    if (!cells || isSeparator(cells)) return;
    const next = lines[index + 1];
    const nextCells = next && !next.inFence ? tableCells(next.text) : null;
    if (nextCells && isSeparator(nextCells)) header = cells;
    else if (header) rows.push({ header, cells });
  });
  return rows;
}

type Item = { id: string; title: string };

function endStateItems(text: string): Item[] {
  const lines = section(toLines(text), "end state");
  if (!lines) return [];
  const numbered: Item[] = [];
  for (const line of lines) {
    const heading = headingOf(line);
    if (heading?.level !== 2) continue;
    const match = NUMBERED.exec(heading.title);
    if (match) numbered.push({ id: match[1].toLowerCase(), title: match[2].trim() });
  }
  if (numbered.length > 0) return numbered;
  const bullets: Item[] = [];
  for (const line of lines) {
    if (line.inFence) continue;
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line.text);
    if (!bullet || /^[^:]{0,40}:\s/.test(bullet[1])) continue;
    bullets.push({ id: String(bullets.length + 1), title: bullet[1].trim() });
  }
  return bullets;
}

function itemId(text: string) {
  const match = /^\s*(?:end state\s+)?(\d+[a-z]?)\b/i.exec(text.replace(/[*`]/g, ""));
  return match ? match[1].toLowerCase() : null;
}

function verdictOf(text: string): "met" | "unmet" | null {
  const value = text.trim();
  if (UNMET.test(value)) return "unmet";
  if (MET.test(value)) return "met";
  return null;
}

function readVerdicts(remember: string | null, status: string | null) {
  const verdicts = new Map<string, "met" | "unmet">();
  const set = (id: string | null, verdict: "met" | "unmet" | null) => {
    if (!id || !verdict) return;
    if (verdicts.get(id) === "unmet") return;
    verdicts.set(id, verdict);
  };
  const linesOf = (text: string | null) => (text === null ? [] : toLines(text));
  for (const line of [...linesOf(remember), ...linesOf(status)]) {
    if (line.inFence) continue;
    const bullet = /^\s*-\s+(.+?):\s*(.+)$/.exec(line.text);
    if (!bullet || !/end state|^\d/i.test(bullet[1])) continue;
    set(itemId(bullet[1]), verdictOf(bullet[2]));
  }
  const tables = (text: string | null, endStateOnly: boolean) => {
    for (const { header, cells } of tableRows(linesOf(text))) {
      const item = header.findIndex((cell) =>
        (endStateOnly ? /^end state$/i : /^(item|end state|criterion|id)$/i).test(cell),
      );
      const result = header.findIndex((cell) => /^(result|status|met)$/i.test(cell));
      if (item === -1 || result === -1) continue;
      set(itemId(cells[item] ?? ""), verdictOf(cells[result] ?? ""));
    }
  };
  tables(remember, false);
  tables(status, true);
  return verdicts;
}

function stateText(status: string | null) {
  if (status === null) return null;
  const states = [
    ...new Set(
      toLines(status).flatMap((line) => {
        if (line.inFence) return [];
        const match = /^\s*(?:-\s*)?State:\s*(.+?)\s*$/i.exec(line.text);
        return match ? [match[1]] : [];
      }),
    ),
  ];
  return states.length === 1 ? states[0] : null;
}

const isDoneState = (text: string | null) =>
  text !== null && /^(done|complete|completed|finished|merged|shipped)\b/i.test(text);

function achievementOf({
  project,
  taskId,
  align,
  remember,
  status,
  at,
}: {
  project: string;
  taskId: string;
  align: string;
  remember: string | null;
  status: string | null;
  at: string;
}): TaskAchievement | null {
  if (!APPROVED.test(align)) return null;
  const items = endStateItems(align);
  if (items.length === 0 || !weekStart(at)) return null;
  const verdicts = readVerdicts(remember, status);
  const title = /^#\s+ALIGN:\s*(.+?)\s*$/m.exec(align)?.[1] ?? taskId;
  let met = 0;
  for (const item of items) {
    if (verdicts.get(item.id) === "met") met += 1;
  }
  return {
    project,
    taskId,
    title,
    met,
    agreed: items.length,
    at,
    done: isDoneState(stateText(status)),
  };
}

function weeksOf(tasks: TaskAchievement[]): WeekAchievement[] {
  const weeks = new Map<string, WeekAchievement>();
  for (const task of tasks) {
    const start = weekStart(task.at);
    if (!start) continue;
    let week = weeks.get(start);
    if (!week) {
      week = { start, label: weekLabel(start), met: 0, agreed: 0, tasks: [] };
      weeks.set(start, week);
    }
    week.met += task.met;
    week.agreed += task.agreed;
    week.tasks.push({
      project: task.project,
      taskId: task.taskId,
      title: task.title,
      met: task.met,
      agreed: task.agreed,
    });
  }
  for (const week of weeks.values())
    week.tasks.sort((a, b) => a.title.localeCompare(b.title) || a.taskId.localeCompare(b.taskId));
  return [...weeks.values()].sort((a, b) => (a.start < b.start ? 1 : -1));
}

const ACHIEVEMENT_FILES = ["ALIGN.approved.md", "ALIGN.md", "REMEMBER.md", "STATUS.md"] as const;

async function readText(path: string): Promise<{ text: string; mtimeMs: number } | null> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) return null;
    return { text: await readFile(path, "utf8"), mtimeMs: stats.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function projectTasks(
  dataFolder: string,
  project: string,
  repo: string,
): Promise<{ tasks: TaskAchievement[]; key: string }> {
  const root = rememberRoot(dataFolder);
  const repoDir = repositoryDirectory(root, await repoSegments({ project, worktree: repo }));
  if (!repoDir) return { tasks: [], key: "" };
  let names: string[];
  try {
    const stats = await lstat(repoDir);
    if (stats.isSymbolicLink() || !stats.isDirectory())
      return { tasks: [], key: `${pathKey(repoDir)}:missing` };
    names = (await readdir(repoDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { tasks: [], key: `${pathKey(repoDir)}:missing` };
    throw error;
  }
  const tasks: TaskAchievement[] = [];
  const stamps: string[] = [];
  for (const taskId of names.sort()) {
    const taskDir = join(/*turbopackIgnore: true*/ repoDir, taskId);
    if (!containsPath(repoDir, taskDir)) continue;
    const files = await Promise.all(
      ACHIEVEMENT_FILES.map(
        async (file) =>
          [file, await readText(join(/*turbopackIgnore: true*/ taskDir, file))] as const,
      ),
    );
    for (const [file, body] of files) {
      if (body) stamps.push(`${taskId}/${file}@${body.mtimeMs}`);
    }
    const byName = new Map(files);
    const approved = byName.get("ALIGN.approved.md");
    const align = approved ?? byName.get("ALIGN.md");
    if (!align) continue;
    const at = new Date(
      Math.max(...files.flatMap(([, body]) => (body ? [body.mtimeMs] : []))),
    ).toISOString();
    const task = achievementOf({
      project,
      taskId,
      align: align.text,
      remember: byName.get("REMEMBER.md")?.text ?? null,
      status: byName.get("STATUS.md")?.text ?? null,
      at,
    });
    if (task) tasks.push(task);
  }
  return { tasks, key: `${pathKey(repoDir)}\n${stamps.join("\n")}` };
}

export async function readEndStateAchievement(folder: string): Promise<AchievementResult> {
  let projects: { name: string; path: string }[];
  try {
    const settings = await readSettingsAt(folder);
    projects = settings.projects.flatMap((project) =>
      typeof project?.name === "string" && typeof project.path === "string"
        ? [{ name: project.name, path: project.path }]
        : [],
    );
  } catch (error) {
    return {
      ok: false,
      error: `Settings could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const found = await Promise.all(
      projects.map((project) => projectTasks(folder, project.name, project.path)),
    );
    const key = found.map((entry) => entry.key).join("\n");
    const cached = cache.get(pathKey(folder));
    if (cached?.key === key) return cached.result;
    const tasks = found.flatMap((entry) => entry.tasks);
    tasks.sort((a, b) => a.project.localeCompare(b.project) || a.taskId.localeCompare(b.taskId));
    const result: AchievementResult = { ok: true, tasks, weeks: weeksOf(tasks) };
    cache.set(pathKey(folder), { key, result });
    return result;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
