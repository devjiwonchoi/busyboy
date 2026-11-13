import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { prepareDefaultHome } from './tests/support/test-home'

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100)
const baseURL = `http://127.0.0.1:${port}`

// The server never sees the real ~/.busyboy, ~/.claude, or ~/.codex. Journeys
// that need their own data folder set one per browser context (tests/support/test-home.ts).
const defaultHome = join(tmpdir(), `busyboy-e2e-default-home-${port}`)
prepareDefaultHome(defaultHome)

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
    command: 'pnpm build && node .next/standalone/server.js',
    url: baseURL,
    // Agents replay recorded provider scripts instead of calling a model.
    env: {
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      BUSYBOY_PROVIDER_SCRIPTS: join(__dirname, 'tests/provider-scripts'),
      BUSYBOY_TEST_MODE: '1',
      BUSYBOY_HOME: defaultHome,
      CLAUDE_CONFIG_DIR: join(defaultHome, 'claude-config'),
      CODEX_HOME: join(defaultHome, 'codex-home'),
    },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
