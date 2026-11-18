import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const app = "apps/web/app";
const guard = "await requireTrustedRequest();";
const proxyFiles = ["proxy", "middleware"].flatMap((name) =>
  ["ts", "js", "mts", "mjs"].flatMap((extension) => [
    `apps/web/${name}.${extension}`,
    `apps/web/src/${name}.${extension}`,
  ]),
);

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path));
      continue;
    }
    if (/\.(?:tsx?|mts)$/.test(path)) found.push(path);
  }
  return found;
}

function isServerActionFile(source: string) {
  return /^\s*["']use server["'];?/.test(source);
}

function isEntryFile(path: string, source: string) {
  const name = basename(path);
  return (
    /^route\.(?:tsx?|mts)$/.test(name) ||
    /^(?:page|layout|default|template)\.tsx$/.test(name) ||
    isServerActionFile(source)
  );
}

function entryFunctions(path: string, source: string) {
  const name = basename(path);
  const pattern = /^(?:page|layout|default|template)\.tsx$/.test(name)
    ? /^(?:export\s+(?:default\s+)?)?async\s+function\s+(\w*)\s*\(/gm
    : /^export\s+(?:default\s+)?async\s+function\s+(\w*)\s*\(/gm;
  return [...source.matchAll(pattern)].map((match) => ({
    name: match[1] || "default",
    index: match.index,
  }));
}

function firstStatement(source: string, functionStart: number) {
  let depth = 0;
  let index = source.indexOf("(", functionStart);
  for (; index < source.length; index++) {
    if (source[index] === "(") depth++;
    else if (source[index] === ")" && --depth === 0) break;
  }
  const body = /\{[ \t]*\n/.exec(source.slice(index));
  if (!body) return "";
  return (
    source
      .slice(index + body.index + body[0].length)
      .trimStart()
      .split("\n")[0]
      ?.trim() ?? ""
  );
}

function lineOf(source: string, index: number) {
  return source.slice(0, index).split("\n").length;
}

const failures: string[] = [];

for (const path of proxyFiles) {
  if (existsSync(path)) failures.push(`${path}: BusyBoy has no proxy. Check each entry instead.`);
}

for (const path of filesUnder("apps/web")) {
  if (path.includes("node_modules") || path.includes(".next")) continue;
  const source = readFileSync(path, "utf8");
  if (/import\s*\{[^}]*\bconnection\b[^}]*\}\s*from\s*["']next\/server["']/.test(source)) {
    failures.push(`${path}: use requireTrustedRequest() instead of connection().`);
  }
}

for (const path of filesUnder(app)) {
  const source = readFileSync(path, "utf8");
  if (!isEntryFile(path, source)) continue;
  if (/^export\s+(?:const|let|var)\s+\w+\s*=\s*async\b/m.test(source)) {
    failures.push(`${path}: declare entries as async functions so this check can see them.`);
  }
  for (const entry of entryFunctions(path, source)) {
    if (firstStatement(source, entry.index) === guard) continue;
    failures.push(`${path}:${lineOf(source, entry.index)}: ${entry.name} must start with ${guard}`);
  }
}

if (failures.length === 0) {
  console.log("Every route handler, server action, and async server component checks the request.");
} else {
  console.error(failures.join("\n"));
  console.error(
    "\nBusyBoy has no proxy. Start each route handler, server action, and async server component in apps/web/app with `await requireTrustedRequest();`.",
  );
  process.exit(1);
}
