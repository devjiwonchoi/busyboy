// A fake `codex app-server` for journeys. The real Codex adapter starts it
// (BUSYBOY_CODEX_PATH points here) and talks newline-delimited JSON-RPC to it,
// so tests exercise the adapter itself. It replays the recorded runs in
// tests/provider-scripts/codex/: a `turn/start` whose text matches a recorded
// prompt plays that turn's raw app-server messages. A recorded server request
// waits for the adapter's reply; a recorded question in an agent message
// waits for `turn/steer`. As in Codex, `cancel` ends the turn, while
// `decline` refuses only that action: the recording assumed it was accepted,
// so the turn then stays open with no more output until `turn/interrupt`. An
// MCP form's reply, declined or not, only goes to its server: the turn goes on.
// A step with `echoReply` then writes the reply's action and content as an agent message.
// A `delayMs` step waits, unless the turn ends first (an interrupt or a stop).
// `thread/resume` fails as Codex does for ids starting with `missing-`.
// `thread/fork` answers like `thread/start`, and an `echoThread` step writes
// what the branch was started with, so journeys can check a side question's
// thread. `config/read` lists no MCP servers.
// The prompt in START_CHILDREN_PROMPT starts two long-running children (one in
// this process group, one detached into a session of its own, as Codex runs
// commands), writes their pids to $FAKE_CODEX_PID_FILE, and from then on
// ignores SIGTERM and the end of its input, so only a forced kill ends it. No model is called.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const START_CHILDREN_PROMPT = 'Start a command that keeps running.'
const scriptsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'provider-scripts', 'codex')
const turns = new Map()
for (const file of readdirSync(scriptsFolder).filter((name) => name.endsWith('.json'))) {
  const script = JSON.parse(readFileSync(join(scriptsFolder, file), 'utf8'))
  for (const turn of script.turns) turns.set(turn.prompt.trim(), turn)
}

let threadId = randomUUID()
/** How a branch was started: the thread it came from and its settings. */
let fork
/** Set once START_CHILDREN_PROMPT ran: the fake then only ends when killed. */
let stubborn = false
let nextRequestId = 0
/** Replies the replay waits for, by server request id. */
const waitingReplies = new Map()
/** The running turn: its id, a way to end it early, and a waiting question to resolve. */
let current

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const notify = (method, params) => send({ method, params: { threadId, ...(current ? { turnId: current.id } : {}), ...params } })

/** The reply as a command decision: permissions granted nothing, or an elicitation declined, count as a decline. */
function replyDecision(result) {
  if (!result || typeof result !== 'object') return 'accept'
  if ('decision' in result) return typeof result.decision === 'string' ? result.decision : 'accept'
  if ('action' in result) return result.action
  if ('permissions' in result) return Object.keys(result.permissions ?? {}).length ? 'accept' : 'decline'
  return 'accept'
}

function completeTurn(status, error = null) {
  if (!current) return
  const { id } = current
  const replies = [...waitingReplies]
  waitingReplies.clear()
  current.ended = true
  for (const [requestId, resolve] of replies) {
    notify('serverRequest/resolved', { requestId })
    resolve(undefined)
  }
  current.wake?.()
  notify('turn/completed', { turn: { id, status, error } })
  current = undefined
}

function startChildren() {
  const grouped = spawn('sleep', ['300'], { stdio: 'ignore' })
  const detached = spawn('sleep', ['301'], { stdio: 'ignore', detached: true })
  const file = process.env.FAKE_CODEX_PID_FILE
  if (file) {
    writeFileSync(`${file}.tmp`, `${grouped.pid} ${detached.pid}`)
    renameSync(`${file}.tmp`, file)
  }
  process.on('SIGTERM', () => {})
  stubborn = true
}

/** Writes `text` as one agent message of the running turn. */
function say(text) {
  const itemId = randomUUID()
  notify('item/agentMessage/delta', { itemId, delta: text })
  notify('item/completed', { item: { type: 'agentMessage', id: itemId, text } })
}

async function playTurn(turn) {
  const own = current
  for (const { raw, echoReply, delayMs, echoThread } of turn.steps) {
    if (own.ended) return
    if (echoThread) {
      say(fork ? `Branched from ${fork.from}. Shell tool: ${fork.shell}. Approvals: ${fork.approvals}. Sandbox: ${fork.sandbox}.` : 'Not a branch.')
      continue
    }
    if (delayMs !== undefined) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, delayMs)
        own.wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      continue
    }
    if (raw.method === 'thread/started') continue
    if (raw.method === 'turn/completed') {
      completeTurn(raw.params.turn.status, raw.params.turn.error)
      return
    }
    if (raw.id !== undefined) {
      const id = nextRequestId++
      const reply = new Promise((resolve) => waitingReplies.set(id, resolve))
      send({ id, method: raw.method, params: { threadId, turnId: own.id, itemId: randomUUID(), ...raw.params } })
      const result = await reply
      if (own.ended) return
      if (echoReply) say(`Reply ${result?.action ?? ''}: ${JSON.stringify(result?.content ?? null)}`)
      // An MCP form's answer, declined or not, goes to its server and the turn goes on.
      if (result && typeof result === 'object' && 'action' in result) continue
      const decision = replyDecision(result)
      if (decision === 'cancel') {
        completeTurn('interrupted')
        return
      }
      // The rest of the recording assumed an accept; after a decline the turn waits for an interrupt.
      if (decision !== 'accept' && typeof decision === 'string' && !decision.startsWith('accept')) {
        await new Promise((resolve) => (own.wake = resolve))
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
    case 'config/read':
      return send({ id, result: { config: { mcp_servers: {} } } })
    case 'thread/fork':
      fork = {
        from: params.threadId,
        shell: params.config?.['features.shell_tool'] === false ? 'off' : 'on',
        approvals: params.approvalPolicy,
        sandbox: params.sandbox,
      }
      send({ id, result: { thread: { id: threadId } } })
      return notify('thread/started', { thread: { id: threadId } })
    case 'thread/start':
    case 'thread/resume':
      if (method === 'thread/resume' && params.threadId.startsWith('missing-')) {
        return send({ id, error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } })
      }
      if (method === 'thread/resume') threadId = params.threadId
      send({ id, result: { thread: { id: threadId } } })
      return notify('thread/started', { thread: { id: threadId } })
    case 'turn/start': {
      const text = params.input.map((part) => part.text ?? '').join('').trim()
      current = { id: randomUUID(), ended: false }
      send({ id, result: { turn: { id: current.id, status: 'inProgress' } } })
      notify('turn/started', { turn: { id: current.id, status: 'inProgress' } })
      if (text === START_CHILDREN_PROMPT) return startChildren()
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
  .on('close', () => {
    if (stubborn) setInterval(() => {}, 1000)
    else process.exit(0)
  })
