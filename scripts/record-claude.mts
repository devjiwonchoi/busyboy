import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const TAPE = "tests/utils/claude-tape.ndjson";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function sdkVersion() {
  const manifest = JSON.parse(readFileSync("apps/web/package.json", "utf8")) as {
    dependencies: Record<string, string>;
  };
  return manifest.dependencies["@anthropic-ai/claude-agent-sdk"];
}

function redact(value: Json, home: string): Json {
  if (typeof value === "string") return value.split(home).join("<home>");
  if (Array.isArray(value)) return value.map((item) => redact(item, home));
  if (value === null || typeof value !== "object") return value;
  const result: { [key: string]: Json } = {};
  for (const [key, item] of Object.entries(value)) result[key] = redact(item, home);
  return result;
}

const raw = join(mkdtempSync(join(tmpdir(), "busyboy-claude-tape-")), "raw.ndjson");
writeFileSync(raw, "");
const run = spawnSync("pnpm", ["exec", "e2e", "run", "--reporter", "list"], {
  stdio: "inherit",
  env: { ...process.env, E2E_CLAUDE_MODE: "record", E2E_CLAUDE_TAPE: raw },
});
if (run.status !== 0) {
  console.error(`The e2e run failed, so ${TAPE} was left as it was.`);
  process.exit(run.status ?? 1);
}

const header = {
  type: "tape",
  claudeVersion: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
  sdkVersion: sdkVersion(),
  recordedAt: new Date().toISOString(),
};
const entries = readFileSync(raw, "utf8")
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.stringify(redact(JSON.parse(line) as Json, homedir())));
writeFileSync(TAPE, `${[JSON.stringify(header), ...entries].join("\n")}\n`);
console.log(`Recorded ${entries.length} lines to ${TAPE}.`);
