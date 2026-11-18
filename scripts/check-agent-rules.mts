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

function main() {
  const base = process.argv[2];
  if (!base) {
    console.error("Usage: node scripts/check-agent-rules.mts <base-ref>");
    process.exit(1);
  }

  const nameStatus = diffFromMergeBase(base, ["--name-status", "--find-renames"]);
  const failures: string[] = [];

  for (const line of nameStatus.split("\n")) {
    const entry = pathsOf(line);
    if (!entry) continue;
    if (entry.paths.includes("README.md")) {
      failures.push("README.md is maintained by its owner. Revert the README.md change.");
    }
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
    if (/\.(?:md|mdx|rst)$/.test(file) && file !== "AGENTS.md" && file !== "DOMAIN.md") {
      failures.push(`Do not add "${file}". Put the note in the pull request description.`);
    }
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
