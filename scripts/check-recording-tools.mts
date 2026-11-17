import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

function toolNames(file: string, marker: string, until?: string): string[] {
  const source = readFileSync(join(root, file), "utf8");
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`${file} has no ${marker}.`);
  const end = until ? source.indexOf(until, start + marker.length) : -1;
  const slice = source.slice(start, end < 0 ? undefined : end);
  return [...slice.matchAll(/name: '([a-z0-9_]+)'/g)].map((match) => match[1]);
}

const expected = [
  ...toolNames("src/server/mcp-tools.ts", "export const MCP_TOOLS", "export function toolsFor"),
  ...toolNames("src/server/memory-tools.ts", "export const MEMORY_TOOLS"),
].sort();
const standIn = toolNames(
  "scripts/record-claude-script.mts",
  "const tools = [",
  "const call",
).sort();

function missing(left: string[], right: string[]) {
  const have = new Set(right);
  return left.filter((name) => !have.has(name));
}

const absent = missing(expected, standIn);
const extra = missing(standIn, expected);
if (absent.length > 0 || extra.length > 0) {
  throw new Error(
    `The Director recording stand-in is out of step with the MCP tools.\nMissing: ${absent.join(", ") || "none"}\nExtra: ${extra.join(", ") || "none"}`,
  );
}

console.log(`Recording stand-in matches ${expected.length} MCP tool names.`);
