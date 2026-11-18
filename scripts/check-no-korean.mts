import { readFileSync } from "node:fs";

import { gitText } from "./git-text.mts";

// Hangul syllables, Jamo, and compatibility Jamo.
const KOREAN = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]/;

const problems: string[] = [];

function scan(label: string, text: string): void {
  text.split("\n").forEach((line, index) => {
    if (KOREAN.test(line)) problems.push(`${label}:${index + 1}: ${line.trim()}`);
  });
}

// Every tracked file, not only what oxlint reads, so Markdown, JSON, YAML, and CSS are covered too.
for (const file of gitText(["ls-files", "-z"]).split("\0").filter(Boolean)) {
  let buffer: Buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    // A file deleted in the working tree but still in the index has nothing to check.
    continue;
  }
  if (buffer.includes(0)) continue;
  scan(file, buffer.toString("utf8"));
}

// With a base ref, also check the messages of commits this branch adds.
const base = process.argv[2];
if (base) {
  for (const commit of gitText(["rev-list", `${base}..HEAD`])
    .split("\n")
    .filter(Boolean)) {
    scan(`commit ${commit.slice(0, 9)}`, gitText(["log", "-1", "--format=%B", commit]));
  }
}

// CI passes the pull request title and description through the environment.
if (process.env.PR_TITLE) scan("pull request title", process.env.PR_TITLE);
if (process.env.PR_BODY) scan("pull request description", process.env.PR_BODY);

if (problems.length > 0) {
  console.error("Write committed text in English. Korean text found:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
