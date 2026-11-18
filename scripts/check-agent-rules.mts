import { diffFromMergeBase } from "./git-text.mts";

const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const toolFiles = new Set(["README.md", "AGENTS.md", "DOMAIN.md"]);

export function segmentIsKebab(segment: string): boolean {
  if (toolFiles.has(segment)) return true;
  if (/^\([a-z0-9]+(?:-[a-z0-9]+)*\)$/.test(segment)) return true;
  if (/^@[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment)) return true;
  if (/^\[(?:\.\.\.)?[a-z0-9]+(?:-[a-z0-9]+)*\]$/.test(segment)) return true;
  if (/^\[\[\.\.\.[a-z0-9]+(?:-[a-z0-9]+)*\]\]$/.test(segment)) return true;
  if (/^\(\.{1,3}\)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment)) return true;
  const bare = segment.startsWith(".") ? segment.slice(1) : segment;
  if (!bare) return false;
  return bare.split(".").every((part) => kebab.test(part));
}

export function pathIsKebab(file: string): boolean {
  return file.split("/").every((segment) => segment.length > 0 && segmentIsKebab(segment));
}

function suggestedName(file: string): string {
  return file
    .split("/")
    .map((segment) =>
      segment
        .replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replaceAll(/[\s_]+/g, "-")
        .toLowerCase(),
    )
    .join("/");
}

function pathsOf(line: string): { status: string; paths: string[] } | null {
  if (!line) return null;
  const parts = line.split("\t");
  return { status: parts[0] ?? "", paths: parts.slice(1) };
}

function isTestPath(file: string) {
  return file === "playwright.config.ts" || file.startsWith("tests/");
}

type Pattern = {
  label: string;
  count: (line: string) => number;
  instead: string;
};

const patterns: Pattern[] = [
  {
    label: "test.skip, it.skip, or describe.skip",
    count: (line) => line.match(/\b(?:test|it|describe)\.skip\b/g)?.length ?? 0,
    instead: "Find the root cause, or delete the journey and say why in the commit message.",
  },
  {
    label: "test.fixme, it.fixme, or describe.fixme",
    count: (line) => line.match(/\b(?:test|it|describe)\.fixme\b/g)?.length ?? 0,
    instead: "Find the root cause, or delete the journey and say why in the commit message.",
  },
  {
    label: "waitForTimeout",
    count: (line) => line.match(/\bwaitForTimeout\b/g)?.length ?? 0,
    instead: "Find the root cause, or delete the journey and say why in the commit message.",
  },
  {
    label: "sleep",
    count: (line) => line.match(/\bsleep\b/g)?.length ?? 0,
    instead: "Find the root cause, or delete the journey and say why in the commit message.",
  },
  {
    label: "retries",
    count: (line) =>
      (line.match(/\bretries\b/g)?.length ?? 0) - (line.match(/\bretries\s*:\s*0\b/g)?.length ?? 0),
    instead:
      "Keep retries at 0. Find the root cause, or delete the journey and say why in the commit message.",
  },
  {
    label: "/opt/cursor/artifacts",
    count: (line) => line.match(/\/opt\/cursor\/artifacts/g)?.length ?? 0,
    instead:
      "Keep the journey's files in a temporary directory, and leave screenshots out of the committed test.",
  },
];

function snapshotFailure(file: string, failures: string[]) {
  if (!file.includes("-snapshots/")) return;
  const body = process.env.PULL_REQUEST_BODY ?? "";
  if (/screenshot/i.test(body)) return;
  failures.push(
    `This pull request changes a screenshot baseline (${file}). Say in the pull request description that the UI change is intentional, or revert the baseline.`,
  );
}

function main() {
  const base = process.argv[2];
  if (!base) {
    console.error("Usage: node scripts/check-agent-rules.mts <base-ref>");
    process.exit(1);
  }

  const nameStatus = diffFromMergeBase(base, ["--name-status", "--find-renames"]);
  const diff = diffFromMergeBase(base, ["--unified=0", "--no-color", "--find-renames"]);
  const failures: string[] = [];

  for (const line of nameStatus.split("\n")) {
    const entry = pathsOf(line);
    if (!entry) continue;
    if (entry.paths.includes("README.md")) {
      failures.push("README.md is maintained by its owner. Revert the README.md change.");
    }
    for (const file of entry.paths) snapshotFailure(file, failures);
    const added =
      entry.status.startsWith("A") || entry.status.startsWith("R") || entry.status.startsWith("C");
    if (!added) continue;
    const file = entry.paths[entry.paths.length - 1];
    if (!file) continue;
    if (!pathIsKebab(file)) {
      failures.push(
        `Rename "${file}" to kebab-case, for example "${suggestedName(file)}". Keep a tool-fixed name such as page.tsx, next.config.ts, README.md, AGENTS.md, or DOMAIN.md.`,
      );
    }
    if (
      /\.(?:md|mdx|rst)$/.test(file) &&
      !file.startsWith("tests/") &&
      !file.startsWith(".agents/skills/") &&
      file !== "AGENTS.md" &&
      file !== "DOMAIN.md"
    ) {
      failures.push(
        `Do not add "${file}". Put the note in the pull request description. A skill and its feature map belong under .agents/skills/.`,
      );
    }
    const unitTest =
      file.includes("/__tests__/") ||
      file.startsWith("__tests__/") ||
      (/\.(?:test|spec)\.(?:tsx?|mts|jsx?|mjs)$/.test(file) && !/^tests\/.*\.spec\.ts$/.test(file));
    if (unitTest) {
      failures.push(
        `Do not add a unit test at "${file}". Add a Playwright journey at tests/<action>-should-<outcome>.spec.ts.`,
      );
    }
  }

  const addedLines = new Map<string, string[]>();
  const nets = new Map<string, number>(patterns.map((pattern) => [pattern.label, 0]));
  let file: string | null = null;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4);
      let next = raw === "/dev/null" ? null : raw.startsWith("b/") ? raw.slice(2) : raw;
      if (next?.startsWith('"') && next.endsWith('"')) next = next.slice(1, -1);
      file = next && isTestPath(next) ? next : null;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || !file) continue;
    if (line.startsWith("\\")) continue;
    const added = line.startsWith("+");
    const removed = line.startsWith("-");
    if (!added && !removed) continue;
    const text = line.slice(1);
    if (added) {
      const lines = addedLines.get(file) ?? [];
      lines.push(text);
      addedLines.set(file, lines);
    }
    const sign = added ? 1 : -1;
    for (const pattern of patterns) {
      nets.set(pattern.label, (nets.get(pattern.label) ?? 0) + sign * pattern.count(text));
    }
  }

  for (const pattern of patterns) {
    if ((nets.get(pattern.label) ?? 0) <= 0) continue;
    const hits: string[] = [];
    for (const [path, lines] of addedLines) {
      for (const text of lines) {
        if (pattern.count(text) > 0) hits.push(`${path}: ${text.trim()}`);
      }
    }
    failures.push(
      `Do not add ${pattern.label}. ${pattern.instead}${hits.length > 0 ? `\n${hits.join("\n")}` : ""}`,
    );
  }

  const unique = [...new Set(failures)];
  if (unique.length === 0) {
    console.log(`Agent rules hold against ${base}.`);
    process.exit(0);
  }
  console.error(unique.join("\n\n"));
  process.exit(1);
}

if (process.argv[1]?.endsWith("check-agent-rules.mts")) main();
