import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect as baseExpect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

// The harness config the test server reads (playwright.config.ts). A fake HTTP
// MCP server stands in for Slack and notes. A fake stdio server, built with the
// MCP SDK, stands in for a local connector.
const port = process.env.PLAYWRIGHT_PORT ?? '3100'
const harnessHome = join(tmpdir(), `busyboy-e2e-default-home-${port}`)
const claudeConfig = join(harnessHome, 'claude-config')
const codexConfig = join(harnessHome, 'codex-home')

const expect = baseExpect.configure({ timeout: 15_000 })

function startFakeMcp() {
  const server = createServer((request, response) => {
    const path = request.url ?? ''
    if (path.startsWith('/login')) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    if (path.startsWith('/down')) {
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end('unavailable')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'notes', version: '0.0.0' } },
      }),
    )
  })
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const listenPort = typeof address === 'object' && address ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${listenPort}`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

function writeHarness(url: string) {
  mkdirSync(claudeConfig, { recursive: true })
  mkdirSync(codexConfig, { recursive: true })
  writeFileSync(
    join(claudeConfig, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        notes: { type: 'http', url: `${url}/notes` },
        slack: { type: 'http', url: `${url}/login` },
      },
    }),
  )
  writeFileSync(
    join(codexConfig, 'config.toml'),
    `[mcp_servers.notes]\nurl = "${url}/notes"\n\n[mcp_servers.broken]\nurl = "${url}/down"\n`,
  )
}

function writeLocalConnector() {
  mkdirSync(claudeConfig, { recursive: true })
  writeFileSync(
    join(claudeConfig, 'settings.json'),
    JSON.stringify({
      mcpServers: {
        local: { command: process.execPath, args: [join(process.cwd(), 'tests', 'fake-mcp', 'stdio-server.mjs')] },
      },
    }),
  )
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message' }).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

test('a local stdio connector should show as connected', async ({ page, context, baseURL }) => {
  writeLocalConnector()
  await useProjectsHome(context, baseURL!, ['web'], { claude: 'signed-in' })
  await page.goto('/')
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Connectors' }).click()

  const claude = page.getByRole('region', { name: 'Claude Code connectors' })
  await expect(claude.getByRole('listitem', { name: 'local' }).locator('[data-status]')).toHaveText('Connected')
})

test('inherited connectors should show their live status, and a missing one can be added from the harness command', async ({ page, context, baseURL }) => {
  const mcp = await startFakeMcp()
  writeHarness(mcp.url)
  try {
    await useProjectsHome(context, baseURL!, ['web'], { claude: 'signed-in' })
    await page.goto('/')
    await page.getByRole('link', { name: 'Settings' }).click()
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Connectors' }).click()

    const claude = page.getByRole('region', { name: 'Claude Code connectors' })
    await expect(claude.getByRole('listitem', { name: 'notes' }).locator('[data-status]')).toHaveText('Connected')
    const slack = claude.getByRole('listitem', { name: 'slack' })
    await expect(slack.locator('[data-status]')).toHaveText('Needs login')
    await expect(slack.getByRole('textbox', { name: 'slack login command' })).toHaveValue('claude mcp login slack')
    await expect(claude.getByRole('textbox', { name: 'Add Slack' })).toHaveCount(0)
    await expect(claude.getByRole('textbox', { name: 'Add Linear' })).toHaveValue(
      'claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp',
    )

    const codex = page.getByRole('region', { name: 'Codex connectors' })
    await expect(codex.getByRole('listitem', { name: 'notes' }).locator('[data-status]')).toHaveText('Connected')
    const broken = codex.getByRole('listitem', { name: 'broken' })
    await expect(broken.locator('[data-status]')).toHaveText('Failed')
    await expect(broken).toContainText('HTTP 500')
    await expect(codex.getByRole('textbox', { name: 'Add Slack' })).toHaveValue('codex mcp add slack --url https://mcp.slack.com/mcp')
    await expect(codex.getByRole('textbox', { name: 'Add Notion' })).toHaveValue(
      'codex mcp add notion --url https://mcp.notion.com/mcp',
    )
    await page.screenshot({ path: '/opt/cursor/artifacts/connectors-settings.png', fullPage: true })
  } finally {
    await mcp.close()
  }
})

test('a Director connector write should ask, run when allowed, and stay refused when denied', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'], { claude: 'signed-in' })
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
  await send(page, 'Post a note in Slack.')

  const card = page.getByRole('log', { name: 'Transcript' }).getByRole('group', { name: 'Approval from Director · slack' })
  await expect(card).toContainText('mcp__slack__post_message')
  await expect(card).toContainText('Ship it.')
  await expect(card).toContainText('Send, post, merge, publish, or delete through a connector')
  await page.screenshot({ path: '/opt/cursor/artifacts/connector-approval.png' })
  await card.getByRole('button', { name: 'A. Allow' }).click()

  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript.getByRole('group', { name: 'Reply' })).toHaveText('Posted to Slack.')
  await expect(page.getByRole('log', { name: 'Transcript' }).getByRole('group', { name: 'Approval from Director · slack' })).toHaveCount(0)

  await send(page, 'Post another note in Slack.')
  const denial = page.getByRole('log', { name: 'Transcript' }).getByRole('group', { name: 'Approval from Director · slack' })
  await denial.getByRole('button', { name: 'C. Deny' }).click()
  await expect(transcript.getByRole('group', { name: 'Reply' }).last()).toHaveText('I did not post to Slack.')
  await expect(page.getByRole('log', { name: 'Transcript' }).getByRole('group', { name: 'Approval from Director · slack' })).toHaveCount(0)
})

test('a user MCP server that fails to start in Codex should be reported', async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ['web'], { claude: 'signed-out' })
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
  await send(page, 'Check the Slack connector.')

  await expect(page.getByRole('log', { name: 'Transcript' }).getByRole('alert')).toHaveText(
    'The MCP server slack failed to start: connection refused',
  )
})
