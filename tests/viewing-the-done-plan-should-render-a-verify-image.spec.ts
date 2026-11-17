import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { expect as baseExpect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'

// The agent writes ALIGN.md, STATUS.md, and VERIFY.md. The screenshots and the
// trace are files the note cites. The script is tests/provider-scripts/verify-artifacts.json.
const REQUEST = 'Finish the footer and record the verification.'
const TRACE = Buffer.from('PK\u0003\u0004busyboy-trace')

const expect = baseExpect.configure({ timeout: 15_000 })

test.use({ colorScheme: 'dark' })

/** A solid PNG the note can cite. The bytes are the picture, not a screenshot baseline. */
function png(width: number, height: number, rgb: [number, number, number]) {
  const chunk = (type: string, data: Buffer) => {
    const name = Buffer.from(type)
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0)
    return Buffer.concat([length, name, data, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.alloc(1 + width * 3)
  const pixel = Buffer.from(rgb)
  for (let x = 0; x < width; x += 1) pixel.copy(row, 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function createTask(request: APIRequestContext, home: string, title: string, text: string) {
  const response = await request.post('/api/mcp', {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { project: 'web', title, request: text } } },
  })
  expect(response.status()).toBe(200)
  const body = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } }
  expect(body.result.isError ?? false, body.result.content[0]?.text).toBe(false)
  const { tasks } = JSON.parse(readFileSync(join(home, 'task-list.json'), 'utf8')) as { tasks: { title: string; worktree: string; id: string }[] }
  return tasks.find((task) => task.title === title)!
}

async function openChat(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('log', { name: 'Transcript' })).toHaveAttribute('data-connected', 'true')
}

const transcript = (page: Page) => page.getByRole('log', { name: 'Transcript' })

async function showsPicture(image: Locator) {
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => (node.complete ? node.naturalWidth : 0))).toBeGreaterThan(0)
}

let home: string

test.beforeEach(async ({ context, baseURL }) => {
  ;({ home } = await useProjectsHome(context, baseURL!, ['web']))
})

test('viewing the done plan should render a verify image and its trace link', async ({ page, context }) => {
  await openChat(page)
  const task = await createTask(context.request, home, 'Show the footer', REQUEST)

  const done = transcript(page).getByRole('group', { name: 'Done from web · Show the footer' })
  await expect(done).toHaveAttribute('data-variant', 'line')
  await expect(done).toContainText('Show the footer')
  await expect(done).toContainText('· Done')
  await expect(done.getByRole('button')).toHaveText('View plan')
  await expect(done.getByRole('img')).toHaveCount(0)

  const record = join(task.worktree, '.jwn', task.id)
  mkdirSync(record, { recursive: true })
  writeFileSync(join(record, 'footer-before.png'), png(320, 140, [48, 64, 82]))
  writeFileSync(join(record, 'footer-after.png'), png(320, 140, [22, 140, 72]))
  writeFileSync(join(record, 'trace.zip'), TRACE)

  await done.getByRole('button', { name: 'View plan' }).click()
  const details = page.getByRole('dialog', { name: 'Show the footer' })
  await expect(details).toContainText('Every page ends with a footer that shows the project name.')
  await expect(details.getByRole('heading', { name: 'VERIFY: Show the footer' })).toBeVisible()
  await expect(details).toContainText('Pass. The footer is on every page.')
  await showsPicture(details.getByRole('img', { name: 'Footer before the change' }))
  await showsPicture(details.getByRole('img', { name: 'Footer after the change' }))

  const trace = details.getByRole('link', { name: 'Playwright trace' })
  await expect(trace).toBeVisible()
  const href = await trace.getAttribute('href')
  expect(href).toContain('trace.zip')
  const response = await page.request.get(new URL(href!, page.url()).toString())
  expect(response.status()).toBe(200)
  expect(Buffer.from(await response.body()).equals(TRACE)).toBe(true)

  // The dialog hides the page behind it. The card underneath is still the one line.
  await page.keyboard.press('Escape')
  await expect(details).toBeHidden()
  await expect(done.getByRole('button')).toHaveText('View plan')
})
