import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { locateTaskRecords } from "../records/record-location";

// The align template writes status after Version:, so prose that mentions an approval never counts.
const APPROVED = /^(?:\W*Version:[^·\n]*·)?\W*Status:\s*approved\b/im;

const FENCE = /^\s*(```|~~~)/;

const CRITERION = /^##\s+\d+[a-z]?\s*·\s*(.+?)\s*#*\s*$/i;

const DONE_WHEN = /^\s*-\s*Done when:\s*(.*?)\s*$/i;

type PlanTask = { id: string; title: string; project: string; worktree: string };

function headingOf(line: string) {
  const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  return match ? { level: match[1].length, title: match[2].trim() } : null;
}

// Fenced code is left out, so a heading inside a diagram is not an end-state item.
function sectionLines(text: string, name: string) {
  const lines = text.split(/\r?\n/);
  const wanted = name.toLowerCase();
  let inFence = false;
  let start = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = headingOf(line);
    if (heading?.level === 1 && heading.title.toLowerCase() === wanted) {
      start = index + 1;
      break;
    }
  }
  if (start === -1) return [];

  const body: string[] = [];
  inFence = false;
  for (let index = start; index < lines.length; index++) {
    const line = lines[index];
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (headingOf(line)?.level === 1) break;
    body.push(line);
  }
  return body;
}

function captured(lines: string[], pattern: RegExp) {
  return lines
    .map((line) => pattern.exec(line)?.[1].trim() ?? "")
    .filter((item) => item.length > 0);
}

export function alignCriteria(plan: string) {
  const criteria = captured(sectionLines(plan, "Success criteria"), CRITERION);
  if (criteria.length > 0) return criteria;
  return captured(sectionLines(plan, "Todos"), DONE_WHEN);
}

// A # comment line in a fence can end the section early; View details still shows the whole plan.
function topSection(text: string, name: string) {
  const match = new RegExp(`^#\\s+${name}\\s*$([\\s\\S]*?)(?=^#\\s|(?![\\s\\S]))`, "im").exec(text);
  return match?.[1] ?? "";
}

export function alignSummary(plan: string) {
  const goal = topSection(plan, "Goal")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph && !/^(intention:|---)/i.test(paragraph))
    .join(" ");
  const what = /^\s*-\s*What:\s*(.+)$/im.exec(topSection(plan, "Summary"))?.[1].trim();
  const sentences = [goal, what ? `When done: ${what}` : ""]
    .join(" ")
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  const summary = sentences.slice(0, 3).join(" ");
  return /[.!?]$/.test(summary) || !summary ? summary : `${summary}.`;
}

export async function readDraftPlan(dataFolder: string, task: PlanTask) {
  const located = await locateTaskRecords(dataFolder, task);
  if (!located || !("folder" in located)) return null;
  const path = join(located.folder, "ALIGN.md");
  const plan = await lstat(path)
    .then(async (stats) => (stats.isSymbolicLink() ? null : readFile(path, "utf8")))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (plan === null || APPROVED.test(plan)) {
    return null;
  }

  const title = /^#\s+ALIGN:\s*(.+?)\s*$/m.exec(plan)?.[1] ?? task.title;
  return { title, plan, summary: alignSummary(plan), criteria: alignCriteria(plan) };
}
