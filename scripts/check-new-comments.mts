import { diffFromMergeBase } from "./git-text.mts";

const base = process.argv[2];
if (!base) {
  console.error("Usage: node scripts/check-new-comments.mts <base-ref>");
  process.exit(1);
}

const diff = diffFromMergeBase(base, ["--unified=0", "--no-color", "--diff-filter=ACMR"]);

const typescript = /\.(?:tsx?|mts)$/;

function isComment(text: string) {
  const trimmed = text.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

function isAllowed(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("#!")) return true;
  if (/^\/\/\s*why:/.test(trimmed) || /^\/\*\s*why:/.test(trimmed) || /^\*\s*why:/.test(trimmed))
    return true;
  if (trimmed.startsWith("/// <reference")) return true;
  if (/^\/\/\s*@ts-(?:expect-error|ignore|nocheck|check)\b/.test(trimmed)) return true;
  if (/^\/\/\s*(?:eslint|oxlint)-(?:disable|enable)(?:-next-line|-line)?\b/.test(trimmed))
    return true;
  if (/^\/\*\s*(?:eslint|oxlint)-(?:disable|enable)(?:-next-line|-line)?\b/.test(trimmed))
    return true;
  return false;
}

type Added = { file: string; line: number; text: string };

const added: Added[] = [];
const removed = new Map<string, Map<string, number>>();
let file: string | null = null;
let inHunk = false;
let newLine = 0;

function removedCount(path: string) {
  let counts = removed.get(path);
  if (!counts) {
    counts = new Map();
    removed.set(path, counts);
  }
  return counts;
}

for (const line of diff.split("\n")) {
  if (line.startsWith("diff --git ")) {
    file = null;
    inHunk = false;
    continue;
  }
  if (line.startsWith("+++ ")) {
    const raw = line.slice(4);
    file = raw === "/dev/null" ? null : raw.startsWith("b/") ? raw.slice(2) : raw;
    if (file?.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
    if (file && !typescript.test(file)) file = null;
    continue;
  }
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
  if (hunk) {
    newLine = Number(hunk[1]);
    inHunk = true;
    continue;
  }
  if (!inHunk || !file) continue;
  if (line.startsWith("\\")) continue;
  if (line.startsWith("+")) {
    const text = line.slice(1);
    if (isComment(text) && !isAllowed(text)) added.push({ file, line: newLine, text: text.trim() });
    newLine += 1;
    continue;
  }
  if (line.startsWith("-")) {
    const text = line.slice(1);
    if (isComment(text) && !isAllowed(text)) {
      const counts = removedCount(file);
      const key = text.trim();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
}

const fresh = added.filter((entry) => {
  const counts = removed.get(entry.file);
  const count = counts?.get(entry.text) ?? 0;
  if (count < 1) return true;
  counts?.set(entry.text, count - 1);
  return false;
});

if (fresh.length === 0) {
  console.log(`No new comments against ${base}.`);
  process.exit(0);
}

console.error(
  "Delete the comment, or mark a non-obvious reason with `// why:`. A tool directive (`// @ts-expect-error`, `/// <reference`, an eslint/oxlint disable line, or a shebang) can stay.",
);
for (const entry of fresh) console.error(`${entry.file}:${entry.line}: ${entry.text}`);
process.exit(1);
