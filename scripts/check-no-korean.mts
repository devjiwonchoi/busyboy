import { readFileSync, statSync } from "node:fs";

import { gitText } from "./git-text.mts";

const HANGUL = /\p{Script=Hangul}/u;

const problems: string[] = [];

function scan(label: string, text: string): void {
  text.split("\n").forEach((line, index) => {
    if (HANGUL.test(line)) problems.push(`${label}:${index + 1}: ${line.trim()}`);
  });
}

function trackedFiles(): string[] {
  return gitText(["ls-files", "-z"]).split("\0").filter(Boolean);
}

function isRegularFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

function isBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

for (const file of trackedFiles()) {
  if (!isRegularFile(file)) continue;
  const buffer = readFileSync(file);
  if (isBinary(buffer)) continue;
  scan(file, buffer.toString("utf8"));
}

if (problems.length > 0) {
  console.error("Write committed text in English. Korean text found:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
