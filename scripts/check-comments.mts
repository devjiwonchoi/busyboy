import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["apps/web", "apps/native", "scripts"];
const extra = ["apps/web/next.config.ts"];
const link = /https?:\/\/\S+/;
const reasonRequiredRule = "busyboy/no-unreasoned-effect";

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      found.push(...filesUnder(path));
      continue;
    }
    if (entry === "next-env.d.ts") continue;
    if (/\.(?:tsx?|mts)$/.test(path)) found.push(path);
  }
  return found;
}

function commentBody(trimmed: string): string | null {
  if (trimmed.startsWith("///")) return trimmed.slice(3).trim();
  if (trimmed.startsWith("//")) return trimmed.slice(2).trim();
  if (trimmed.startsWith("{/*")) return trimmed.slice(3).trim();
  if (trimmed.startsWith("/*")) return trimmed.slice(2).trim();
  if (trimmed.startsWith("*")) return trimmed.slice(1).trim();
  return null;
}

export function commentIsAllowed(line: string, lineIndex: number): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("#!")) return true;
  const body = commentBody(trimmed);
  if (body === null) return true;
  const text = body
    .replace(/^\*+\s*/, "")
    .replace(/\*\/\}?$/, "")
    .trim();
  if (text === "" || text === "/") return true;
  if (lineIndex < 8 && /\b(?:copyright|spdx-license-identifier|@license)\b/i.test(text))
    return true;
  if (trimmed.startsWith("///") && text.startsWith("<reference")) return true;
  if (/^@ts-(?:nocheck|check)\b/.test(text)) return true;
  if (/^@ts-(?:expect-error|ignore)\b/.test(text)) return link.test(text);
  if (/^(?:eslint|oxlint)-(?:disable|enable)(?:-next-line|-line)?\b/.test(text)) {
    return !text.includes(reasonRequiredRule) || /\s--\s+\S/.test(text);
  }
  if (/^(?:prettier|oxfmt)-ignore\b/.test(text)) return true;
  if (/^turbopackIgnore\b/.test(text)) return true;
  return link.test(text);
}

const failureMessage =
  "Delete the comment and make the code self-explanatory: rename, extract, or type the surprise. A constraint from Electron, the operating system, Next.js, or a harness CLI stays only with the issue or vendor doc link. A formatter ignore, shebang, triple-slash reference, or oxlint disable for a pedantic rule can stay. A busyboy/no-unreasoned-effect disable says what the effect keeps in step after `--`.";

function main() {
  const failures: string[] = [];
  const paths = [
    ...roots.flatMap((root) => filesUnder(root)),
    ...extra.filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    }),
  ];

  for (const path of paths) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (commentIsAllowed(line, index)) return;
      failures.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }

  if (failures.length === 0) {
    console.log(`Comments follow the no-comments policy (${paths.length} files).`);
    process.exit(0);
  }

  console.error(failureMessage);
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

if (process.argv[1]?.endsWith("check-comments.mts")) main();
