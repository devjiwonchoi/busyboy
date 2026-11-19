import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createAnthropic } from "@ai-sdk/anthropic";
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

const home = (process.env.BUSYBOY_E2E_HOME ??= mkdtempSync(join(tmpdir(), "busyboy-e2e-")));

const anthropic = createAnthropic({
  authToken: process.env.ANTHROPIC_AUTH_TOKEN,
});

export default {
  tests: "tests/e2e/*.e2e.ts",
  workers: 1,
  agents: {
    default: { model: anthropic("claude-haiku-5-5") },
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
            BUSYBOY_CLAUDE_PATH: resolve("tests/e2e/utils/fake-claude.mjs"),
          },
          startupTimeout: 120_000,
          log: ".e2e/logs/app.log",
        },
      },
    },
  ],
} satisfies E2EConfig;
