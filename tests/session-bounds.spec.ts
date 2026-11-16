import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { useProjectsHome } from './support/projects-home'
import { startStandaloneServer } from './support/standalone-server'

// Must match src/server/runner/agent-runner.ts.
const MAX_RETAINED_EVENTS = 5_000
// Must match src/server/director/transcript-log.ts.
const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024

const MAIN_MESSAGE = "Let's call the next release Bluebird."
const FLOOD = 'Count out six thousand marks.'
const FLOOD_FOLLOW_UP = 'Are the earliest marks still in memory?'
const ADD_LINE = 'Add one more line to the transcript.'
const REMEMBER = 'What word did I ask you to remember?'

type Envelope = { seq: number; event: { type?: string; label?: string; text?: string } }

function envelopes(body: string): Envelope[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .flatMap((line) => {
      const value = JSON.parse(line.slice('data: '.length)) as { seq?: unknown; event?: Envelope['event'] }
      return typeof value.seq === 'number' && value.event ? [{ seq: value.seq, event: value.event }] : []
    })
}

async function startMainChat(page: Page) {
  await page.goto('/')
  const transcript = page.getByRole('log', { name: 'Transcript' })
  await expect(transcript).toHaveAttribute('data-connected', 'true')
  await page.getByRole('textbox', { name: 'Message' }).fill(MAIN_MESSAGE)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('Noted: the next release is Bluebird.')
  await expect(transcript).toHaveAttribute('data-status', 'idle')
}

/** Asks in the open side chat tab and returns the side agent's event stream URL. */
async function askSide(page: Page, question: string) {
  await page.getByRole('tab', { name: 'Side chat', exact: true }).click()
  const stream = page.waitForRequest(/\/api\/side-chat\/[^/]+\/events/)
  await page.getByRole('textbox', { name: 'Side question' }).fill(question)
  await page.getByRole('button', { name: 'Ask' }).click()
  return (await stream).url()
}

test('flooding an agent with events should keep only the latest 5000 and still answer', async ({ page, context, baseURL }) => {
  test.setTimeout(60_000)
  await useProjectsHome(context, baseURL!, [])
  await startMainChat(page)
  const streamUrl = await askSide(page, FLOOD)

  const side = page.getByRole('log', { name: 'Side chat' })
  await expect(side.getByLabel('Side answer')).toHaveText('Counted six thousand marks.', { timeout: 20_000 })

  await page.getByRole('textbox', { name: 'Side question' }).fill(FLOOD_FOLLOW_UP)
  await page.getByRole('button', { name: 'Ask' }).click()
  await expect(side.getByLabel('Side answer').nth(1)).toHaveText('No. The latest marks are kept.')

  // Closing the tab stops the agent. A stream opened before that stop can contain the
  // replay plus the stop itself, so the replay is read again once the agent has stopped.
  await page.getByRole('button', { name: `Close ${FLOOD}` }).click()
  const replay = new URL(streamUrl)
  replay.searchParams.set('after', '0')
  await page.request.get(replay.toString(), { timeout: 20_000 }).then((response) => response.text())
  const body = await page.request.get(replay.toString(), { timeout: 20_000 }).then((response) => response.text())
  const events = envelopes(body)

  expect(events).toHaveLength(MAX_RETAINED_EVENTS)
  const seqs = events.map(({ seq }) => seq)
  expect(seqs).toEqual(Array.from({ length: MAX_RETAINED_EVENTS }, (_, index) => seqs[0] + index))
  expect(seqs[0]).toBeGreaterThan(1)
  expect(seqs.at(-1)).toBeGreaterThan(MAX_RETAINED_EVENTS)
  expect(events.some(({ event }) => event.label === 'mark-0')).toBe(false)
  expect(events.some(({ event }) => event.label === 'mark-5999')).toBe(true)
  expect(events.some(({ event }) => event.text === 'No. The latest marks are kept.')).toBe(true)
})

/**
 * Writes a transcript that is already past the rotation limit, plus the provider
 * session the resumed chat continues. The padding line is not a chat entry, so
 * the screen stays small while the file is large.
 */
function seedFullTranscript(home: string, sessionId: string) {
  const folder = join(home, 'director')
  mkdirSync(folder, { recursive: true })
  const early = [
    { id: 'early-user', at: '2026-01-01T00:00:00.000Z', kind: 'user', text: 'EARLY-MARKER' },
    { id: 'early-reply', at: '2026-01-01T00:00:01.000Z', kind: 'director', text: 'Saw the early marker.' },
  ]
  const head = `${early.map((entry) => JSON.stringify(entry)).join('\n')}\n`
  const prefix = '{"pad":"'
  const suffix = '"}\n'
  const padding = Math.max(0, MAX_TRANSCRIPT_BYTES - Buffer.byteLength(head) - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + 1
  writeFileSync(join(folder, 'transcript.jsonl'), Buffer.concat([Buffer.from(head + prefix), Buffer.alloc(padding, 'a'), Buffer.from(suffix)]))
  writeFileSync(join(folder, 'state.json'), `${JSON.stringify({ provider: 'claude', sessionId }, null, 2)}\n`)
  const historyFolder = join(tmpdir(), 'busyboy-scripted-sessions')
  mkdirSync(historyFolder, { recursive: true })
  const historyFile = join(historyFolder, `${sessionId}.json`)
  writeFileSync(historyFile, JSON.stringify(['Remember the word lighthouse.']))
  return historyFile
}

function transcriptNames(home: string) {
  return readdirSync(join(home, 'director'))
    .filter((name) => name.startsWith('transcript'))
    .sort()
}

/** The new line is on disk and the provider session is saved with no turn left open. */
function transcriptSettled(active: string, stateFile: string, sessionId: string) {
  try {
    const text = readFileSync(active, 'utf8')
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { sessionId?: string; turnOpen?: boolean }
    return text.includes('Line added.') && state.sessionId === sessionId && state.turnOpen !== true
  } catch {
    return false
  }
}

test('filling the transcript past 20MB should rotate it and restoring the session should show the earlier messages', async ({ browser }) => {
  test.setTimeout(90_000)
  const server = await startStandaloneServer()
  const sessionId = `scripted-${randomUUID()}`
  let historyFile = ''
  try {
    const context = await browser.newContext({ baseURL: server.baseURL })
    const { home } = await useProjectsHome(context, server.baseURL, [])
    historyFile = seedFullTranscript(home, sessionId)
    const page = await context.newPage()
    const transcript = page.getByRole('log', { name: 'Transcript' })

    await page.goto('/')
    await expect(transcript).toHaveAttribute('data-connected', 'true', { timeout: 15_000 })
    await expect(transcript.getByLabel('Your message')).toHaveText('EARLY-MARKER')
    await expect(transcript.getByLabel('Reply', { exact: true })).toHaveText('Saw the early marker.')

    await page.getByRole('textbox', { name: 'Message' }).fill(ADD_LINE)
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(transcript.getByLabel('Reply', { exact: true }).nth(1)).toHaveText('Line added.')
    const archived = join(home, 'director', 'transcript.1.jsonl')
    const active = join(home, 'director', 'transcript.jsonl')
    const stateFile = join(home, 'director', 'state.json')
    // The reply is shown before its write finishes, and the session file is written after that.
    await expect.poll(() => transcriptSettled(active, stateFile, sessionId)).toBe(true)

    expect(transcriptNames(home)).toEqual(['transcript.1.jsonl', 'transcript.jsonl'])
    const archivedSize = statSync(archived).size
    const archivedText = readFileSync(archived, 'utf8')
    expect(archivedSize).toBeGreaterThanOrEqual(MAX_TRANSCRIPT_BYTES)
    expect(archivedSize).toBeLessThan(MAX_TRANSCRIPT_BYTES + 1024 * 1024)
    expect(statSync(active).size).toBeLessThan(MAX_TRANSCRIPT_BYTES)
    expect(archivedText.includes('EARLY-MARKER')).toBe(true)
    expect(archivedText.includes('Line added.')).toBe(false)
    const activeText = readFileSync(active, 'utf8')
    expect(activeText).toContain(ADD_LINE)
    expect(activeText).toContain('Line added.')
    expect(activeText.includes('EARLY-MARKER')).toBe(false)

    await server.stop('SIGKILL')
    await server.restart()
    await page.goto('/')
    await expect(transcript).toHaveAttribute('data-connected', 'true', { timeout: 15_000 })
    await expect(transcript.getByLabel('Your message').first()).toHaveText('EARLY-MARKER')
    await expect(transcript.getByLabel('Reply', { exact: true }).first()).toHaveText('Saw the early marker.')
    await expect(transcript.getByLabel('Reply', { exact: true }).nth(1)).toHaveText('Line added.')

    await page.getByRole('textbox', { name: 'Message' }).fill(REMEMBER)
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(transcript.getByLabel('Reply', { exact: true }).nth(2)).toHaveText('Lighthouse.')
    expect(transcriptNames(home)).toEqual(['transcript.1.jsonl', 'transcript.jsonl'])
    const state = JSON.parse(readFileSync(join(home, 'director', 'state.json'), 'utf8')) as { sessionId?: string }
    expect(state.sessionId).toBe(sessionId)
    await context.close()
  } finally {
    await server.dispose()
    if (historyFile) rmSync(historyFile, { force: true })
  }
})
