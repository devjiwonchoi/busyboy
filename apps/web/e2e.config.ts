import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createAnthropic } from "@ai-sdk/anthropic";
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

const anthropic = createAnthropic({
  authToken: process.env.ANTHROPIC_AUTH_TOKEN,
});

export default {
  agents: {
    default: { model: anthropic("claude-sonnet-5-5") },
  },
  targets: [
    {
      engine: web(),
      app: {
        url: "http://127.0.0.1:0",
        command: {
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
            BUSYBOY_HOME: mkdtempSync(join(tmpdir(), "busyboy-e2e-")),
            // A scripted `claude` that streams a fixed reply word by word.
            BUSYBOY_CLAUDE_PATH: resolve("tests/fixtures/fake-claude"),
          },
          startupTimeout: 120_000,
          log: ".e2e/logs/app.log",
        },
      },
    },
  ],
} satisfies E2EConfig;
