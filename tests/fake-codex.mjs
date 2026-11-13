// A fake `codex app-server` for journeys. The real Codex adapter starts it
// (BUSYBOY_CODEX_PATH points here) and talks newline-delimited JSON-RPC to it,
// so tests exercise the adapter itself. It replays the recorded runs in
// tests/provider-scripts/codex/: a `turn/start` whose text matches a recorded
// prompt plays that turn's raw app-server messages. A recorded server request
// waits for the adapter's reply; a recorded question in an agent message
// waits for `turn/steer`. No model is called.
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const scriptsFolder = join(dirname(fileURLToPath(import.meta.url)), 'provider-scripts', 'codex')
const turns = new Map()
for (const file of readdirSync(scriptsFolder).filter((name) => name.endsWith('.json'))) {
  const script = JSON.parse(readFileSync(join(scriptsFolder, file), 'utf8'))
  for (const turn of script.turns) turns.set(turn.prompt.trim(), turn)
}

let threadId = randomUUID()
let nextRequestId = 0
/** Replies the replay waits for, by server request id. */
const waitingReplies = new Map()
/** The running turn: its id, a way to end it early, and a waiting question to resolve. */
let current

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const notify = (method, params) => send({ method, params: { threadId, ...(current ? { turnId: current.id } : {}), ...params } })

function completeTurn(status, error = null) {
  if (!current) return
  const { id } = current
  for (const [requestId] of waitingReplies) notify('serverRequest/resolved', { requestId })
  waitingReplies.clear()
  current.ended = true
  current.wake?.()
  notify('turn/completed', { turn: { id, status, error } })
  current = undefined
}

async function playTurn(turn) {
  const own = current
  for (const { raw } of turn.steps) {
    if (own.ended) return
    if (raw.method === 'thread/started') continue
    if (raw.method === 'turn/completed') {
      completeTurn(raw.params.turn.status, raw.params.turn.error)
      return
    }
    if (raw.id !== undefined) {
      const id = nextRequestId++
      const reply = new Promise((resolve) => waitingReplies.set(id, resolve))
      send({ id, method: raw.method, params: { threadId, turnId: own.id, itemId: randomUUID(), ...raw.params } })
      own.wake = () => waitingReplies.get(id)?.(undefined)
      const result = await reply
      if (own.ended) return
      // Only `accept` lets the recorded run go on; a declined command ends the turn like Codex's cancel.
      if (result && 'decision' in result && result.decision !== 'accept') {
        completeTurn('interrupted')
        return
      }
      continue
    }
    notify(raw.method, raw.params)
    const questions = raw.method === 'item/completed' && raw.params.item.questions
    if (questions?.length) await new Promise((resolve) => (own.wake = resolve))
  }
  // A recording always ends with turn/completed; a cut-off one still ends its turn.
  if (!own.ended) completeTurn('completed')
}

function handle(message) {
  const { id, method, params } = message
  if (method === undefined) {
    const resolve = waitingReplies.get(id)
    waitingReplies.delete(id)
    resolve?.(message.result)
    return
  }
  switch (method) {
    case 'initialize':
      return send({ id, result: { userAgent: 'fake-codex/0.0.0', platformFamily: 'unix', platformOs: 'fake' } })
    case 'initialized':
      return
    case 'account/read':
      return send({ id, result: { account: { type: 'chatgpt', email: null }, requiresOpenaiAuth: true } })
    case 'thread/start':
    case 'thread/resume':
      if (method === 'thread/resume') threadId = params.threadId
      send({ id, result: { thread: { id: threadId } } })
      return notify('thread/started', { thread: { id: threadId } })
    case 'turn/start': {
      const text = params.input.map((part) => part.text ?? '').join('').trim()
      current = { id: randomUUID(), ended: false }
      send({ id, result: { turn: { id: current.id, status: 'inProgress' } } })
      notify('turn/started', { turn: { id: current.id, status: 'inProgress' } })
      const turn = turns.get(text)
      if (!turn) return completeTurn('failed', { message: `No fake Codex script has a turn for: ${text}`, codexErrorInfo: 'other' })
      void playTurn(turn)
      return
    }
    case 'turn/steer': {
      if (!current || current.id !== params.expectedTurnId) {
        return send({ id, error: { code: -32600, message: 'No active turn to steer.' } })
      }
      send({ id, result: { turnId: current.id } })
      const wake = current.wake
      current.wake = undefined
      return wake?.()
    }
    case 'turn/interrupt':
      send({ id, result: {} })
      return completeTurn('interrupted')
    case 'thread/compact/start':
      send({ id, result: {} })
      current = { id: randomUUID(), ended: false }
      notify('turn/started', { turn: { id: current.id, status: 'inProgress' } })
      return completeTurn('completed')
    default:
      return send({ id, error: { code: -32601, message: `The fake Codex does not handle ${method}.` } })
  }
}

createInterface({ input: process.stdin })
  .on('line', (line) => line.trim() && handle(JSON.parse(line)))
  .on('close', () => process.exit(0))
