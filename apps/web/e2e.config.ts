import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { web } from "@e2e-dev/web";
import { gateway } from "ai";
import type { E2EConfig } from "e2e";

export default {
  agents: {
    default: { model: gateway(process.env.E2E_MODEL || "openai/gpt-6-luna-fast") },
  },
  targets: [
    {
      engine: web(),
      app: {
        url: "http://127.0.0.1:0",
        command: {
          executable: "pnpm",
          args: ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", "{port}"],
          env: { BUSYBOY_HOME: mkdtempSync(join(tmpdir(), "busyboy-e2e-")) },
          startupTimeout: 120_000,
        },
      },
    },
  ],
} satisfies E2EConfig;
