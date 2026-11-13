import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100)
const baseURL = `http://127.0.0.1:${port}`

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
  webServer: {
    command: 'pnpm build && pnpm start',
    url: baseURL,
    // Agents replay recorded provider scripts instead of calling a model. Codex runs its real
    // adapter against a fake `codex` that replays tests/provider-scripts/codex/.
    env: {
      PORT: String(port),
      BUSYBOY_TEST_MODE: '1',
      BUSYBOY_PROVIDER_SCRIPTS: join(__dirname, 'tests/provider-scripts'),
      BUSYBOY_CODEX_PATH: join(__dirname, 'tests/fake-codex.mjs'),
    },
    // Never reuse: another worktree may be serving a different build on the same port.
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
