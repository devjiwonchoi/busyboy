import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["apps/web", "apps/native", "scripts"];
const extra = ["apps/web/next.config.ts", "apps/web/proxy.ts"];

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      found.push(...filesUnder(path));
      continue;
    }
    // why: next typegen writes next-env.d.ts, and that file is not product code.
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

function isAllowed(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("#!")) return true;
  const body = commentBody(trimmed);
  if (body === null) return true;
  const text = body
    .replace(/^\*+\s*/, "")
    .replace(/\*\/\}?$/, "")
    .trim();
  if (text === "" || text === "/") return true;
  if (text.startsWith("why:")) return true;
  if (/^@ts-(?:expect-error|ignore|nocheck|check)\b/.test(text)) return true;
  if (trimmed.startsWith("///") && text.startsWith("<reference")) return true;
  if (/^(?:eslint|oxlint)-(?:disable|enable)(?:-next-line|-line)?\b/.test(text)) return true;
  return false;
}

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
    if (isAllowed(line)) return;
    failures.push(`${path}:${index + 1}: ${line.trim()}`);
  });
}

if (failures.length === 0) {
  console.log(`Comments are either \`// why:\` notes or tool directives (${paths.length} files).`);
  process.exit(0);
}

console.error(
  "Delete the comment, or mark a non-obvious reason with `// why:`. A tool directive (`// @ts-expect-error`, `/// <reference`, an eslint/oxlint disable line, or a shebang) can stay.",
);
for (const failure of failures) console.error(failure);
process.exit(1);
