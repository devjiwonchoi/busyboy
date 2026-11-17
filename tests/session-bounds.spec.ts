import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { MAX_TRANSCRIPT_BYTES } from '@/server/director/transcript-log'
import { useProjectsHome } from './support/projects-home'
import { startStandaloneServer } from './support/standalone-server'

const ADD_LINE = 'Add one more line to the transcript.'
const REMEMBER = 'What word did I ask you to remember?'

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
