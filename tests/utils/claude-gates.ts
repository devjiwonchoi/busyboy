import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

type Gate = "first-text" | "turn-end";

const GATE_POLL_MS = 50;
const GATE_TIMEOUT_MS = 60_000;

function gatesFolder() {
  const home = process.env.BUSYBOY_E2E_HOME;
  if (!home) throw new Error("BUSYBOY_E2E_HOME is not set. Run the tests through e2e.config.ts.");
  return join(home, "claude-gates");
}

function turnFolder(prompt: string) {
  return join(gatesFolder(), encodeURIComponent(prompt));
}

export async function waitForClaudeAt(prompt: string, gate: Gate) {
  const reached = join(turnFolder(prompt), `${gate}.reached`);
  const deadline = Date.now() + GATE_TIMEOUT_MS;
  while (!existsSync(reached)) {
    if (Date.now() > deadline) throw new Error(`Claude never reached ${gate} for "${prompt}".`);
    await sleep(GATE_POLL_MS);
  }
}

export function releaseClaudeAt(prompt: string, gate: Gate) {
  writeFileSync(join(turnFolder(prompt), `${gate}.release`), "");
}

export function releaseClaude() {
  if (!existsSync(gatesFolder())) return;
  for (const turn of readdirSync(gatesFolder())) {
    for (const gate of ["first-text", "turn-end"] satisfies Gate[]) {
      writeFileSync(join(gatesFolder(), turn, `${gate}.release`), "");
    }
  }
}
