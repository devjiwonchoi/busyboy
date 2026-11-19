import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createAnthropic } from "@ai-sdk/anthropic";
import { claudeCode } from "@e2e-dev/acp";
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

const home = (process.env.BUSYBOY_E2E_HOME ??= mkdtempSync(join(tmpdir(), "busyboy-e2e-")));

const anthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
if (process.env.CI && !anthropicAuthToken)
  throw new Error("CI runs e2e on Anthropic. Set ANTHROPIC_AUTH_TOKEN.");

const defaultAgent = anthropicAuthToken
  ? { model: createAnthropic({ authToken: anthropicAuthToken })("claude-haiku-5-5") }
  : { executor: claudeCode({ model: "haiku" }) };

const slowestLiveActMs = 25_000;
const fakeClaudeThinkMs = slowestLiveActMs + 10_000;

export default {
  tests: "tests/*.e2e.ts",
  workers: 1,
  assertionTimeout: fakeClaudeThinkMs + 30_000,
  agents: {
    default: defaultAgent,
  },
  targets: [
    {
      engine: web(),
      app: {
        url: "http://127.0.0.1:0",
        command: {
          cwd: "apps/web",
          executable: "node",
          args: [
            "node_modules/next/dist/bin/next",
            "dev",
            "--hostname",
            "127.0.0.1",
            "--port",
            "{port}",
          ],
          env: {
            BUSYBOY_HOME: home,
            BUSYBOY_CLAUDE_PATH: resolve("tests/utils/fake-claude.mjs"),
            FAKE_CLAUDE_THINK_MS: String(fakeClaudeThinkMs),
            FAKE_CLAUDE_DELAY_MS: "500",
          },
          startupTimeout: 120_000,
          log: ".e2e/logs/app.log",
        },
      },
    },
  ],
} satisfies E2EConfig;
