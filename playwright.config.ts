import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { fakeClaudePidFile, fakeClaudePort, fakeClaudeURL } from './tests/fake-claude/fake-claude'
import { fakeCodexPidFile } from './tests/fake-codex/fake-codex'
import { prepareDefaultHome } from './tests/support/test-home'

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100)
const baseURL = `http://127.0.0.1:${port}`

// The servers never see the real ~/.busyboy, ~/.claude, or ~/.codex. Each gets
// a data folder where setup is complete; journeys that need their own data
// folder set one per browser context (tests/support/test-home.ts).
function testHome(serverPort: number) {
  const home = join(tmpdir(), `busyboy-e2e-default-home-${serverPort}`)
  prepareDefaultHome(home)
  return {
    BUSYBOY_HOME: home,
    CLAUDE_CONFIG_DIR: join(home, 'claude-config'),
    CODEX_HOME: join(home, 'codex-home'),
  }
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Journeys run against the production standalone server, as the desktop app does.
  // Playwright starts these in order, so the second reuses the first one's build.
  webServer: [
    {
      command: 'pnpm build && pnpm start',
      url: baseURL,
      // Test mode lets the server run without the desktop app's token (see src/proxy.ts).
      // Agents replay recorded provider scripts instead of calling a model. Codex runs its real
      // adapter against a fake `codex` that replays tests/provider-scripts/codex/.
      env: {
        PORT: String(port),
        BUSYBOY_TEST_MODE: '1',
        BUSYBOY_TEST_SHELL: '/bin/sh',
        BUSYBOY_PROVIDER_SCRIPTS: join(__dirname, 'tests/provider-scripts'),
        // Messages sent within 2 s go to the Director as one turn.
        BUSYBOY_DIRECTOR_BATCH_MS: '2000',
        // Compact the Director after 1.5 s of idle time once a chat passes 1000 characters.
        BUSYBOY_DIRECTOR_IDLE_COMPACT_MS: '1500',
        BUSYBOY_DIRECTOR_COMPACT_CHARS: '1000',
        ...testHome(port),
        BUSYBOY_CODEX_PATH: join(__dirname, 'tests/fake-codex/codex.mjs'),
        FAKE_CODEX_PID_FILE: fakeCodexPidFile,
      },
      // Never reuse: another worktree may be serving a different build on the same port, or a
      // server that is not in test mode could write to the real data folder.
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      // The real Claude adapter, with a fake `claude` that starts child processes.
      command: 'pnpm start',
      url: fakeClaudeURL,
      env: {
        PORT: String(fakeClaudePort),
        BUSYBOY_TEST_MODE: '1',
        BUSYBOY_CLAUDE_PATH: join(__dirname, 'tests/fake-claude/claude.sh'),
        FAKE_CLAUDE_PID_FILE: fakeClaudePidFile,
        ...testHome(fakeClaudePort),
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
})
