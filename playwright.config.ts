import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { fakeClaudePidFile, fakeClaudePort, fakeClaudeURL } from "./tests/fake-claude/fake-claude";
import { fakeCodexPidFile } from "./tests/fake-codex/fake-codex";
import { fakeGrokPort, fakeGrokURL } from "./tests/fake-grok/fake-grok";
import { prepareDefaultHome } from "./tests/support/test-home";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;

// Journeys never see the real ~/.busyboy, ~/.claude, or ~/.codex.
function testHome(serverPort: number) {
  const home = join(tmpdir(), `busyboy-e2e-default-home-${serverPort}`);
  prepareDefaultHome(home);
  return {
    BUSYBOY_HOME: home,
    CLAUDE_CONFIG_DIR: join(home, "claude-config"),
    CODEX_HOME: join(home, "codex-home"),
  };
}

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm build && pnpm start",
      url: baseURL,
      env: {
        PORT: String(port),
        BUSYBOY_TEST_MODE: "1",
        BUSYBOY_TEST_SHELL:
          process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh",
        BUSYBOY_PROVIDER_SCRIPTS: join(__dirname, "tests/provider-scripts"),
        BUSYBOY_DIRECTOR_BATCH_MS: "2000",
        BUSYBOY_DIRECTOR_IDLE_COMPACT_MS: "1500",
        BUSYBOY_DIRECTOR_COMPACT_CHARS: "1000",
        ...testHome(port),
        BUSYBOY_CODEX_PATH: join(__dirname, "tests/fake-codex/codex.mjs"),
        BUSYBOY_GH_PATH: join(__dirname, "tests/fake-gh/gh"),
        FAKE_CODEX_PID_FILE: fakeCodexPidFile,
      },
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: "pnpm start",
      url: fakeClaudeURL,
      env: {
        PORT: String(fakeClaudePort),
        BUSYBOY_TEST_MODE: "1",
        BUSYBOY_CLAUDE_PATH: join(__dirname, "tests/fake-claude/claude.sh"),
        FAKE_CLAUDE_PID_FILE: fakeClaudePidFile,
        ...testHome(fakeClaudePort),
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "pnpm start",
      url: fakeGrokURL,
      env: {
        PORT: String(fakeGrokPort),
        BUSYBOY_TEST_MODE: "1",
        BUSYBOY_GROK_PATH: join(__dirname, "tests/fake-grok/grok.mjs"),
        BUSYBOY_TEST_SHELL:
          process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh",
        BUSYBOY_DIRECTOR_BATCH_MS: "200",
        ...testHome(fakeGrokPort),
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
