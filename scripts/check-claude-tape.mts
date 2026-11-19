import { readFileSync } from "node:fs";

const TAPE = "tests/utils/claude-tape.ndjson";

const [firstLine] = readFileSync(TAPE, "utf8").split("\n");
const header = JSON.parse(firstLine ?? "{}") as { sdkVersion?: string };
const manifest = JSON.parse(readFileSync("apps/web/package.json", "utf8")) as {
  dependencies: Record<string, string>;
};
const installed = manifest.dependencies["@anthropic-ai/claude-agent-sdk"];

if (header.sdkVersion !== installed) {
  console.error(
    `${TAPE} was recorded with @anthropic-ai/claude-agent-sdk ${header.sdkVersion}, but apps/web uses ${installed}. Re-record it with pnpm record:claude.`,
  );
  process.exit(1);
}
console.log(`${TAPE} matches @anthropic-ai/claude-agent-sdk ${installed}.`);
