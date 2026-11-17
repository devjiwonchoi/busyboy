// Codex: cancel ends the turn, decline refuses only that action, and thread/resume fails for ids starting with missing-.
// Hooks run only when the thread config trusts them with the hash hooks/list reported.
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
let fork
let stubborn = false
let nextRequestId = 0
const waitingReplies = new Map()
let current
const probeHooks = new Map()
let threadHooks = []
let threadCwd = process.cwd()

function listHooks(hooks) {
  return (hooks?.PreToolUse ?? []).flatMap((group, groupIndex) =>
    group.hooks.map((handler, handlerIndex) => ({
      key: `/<session-flags>/config.toml:pre_tool_use:${groupIndex}:${handlerIndex}`,
      command: handler.command,
      source: 'sessionFlags',
      currentHash: `sha256:${createHash('sha256').update(handler.command).digest('hex')}`,
      trustStatus: 'untrusted',
    })),
  )
}

async function hooksDeny(call) {
  const trusted = threadHooks.filter(({ trustStatus }) => trustStatus === 'trusted').map(({ command }) => command)
  for (const command of trusted) {
    const child = spawn(command, { shell: true, cwd: threadCwd, stdio: ['pipe', 'pipe', 'inherit'] })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stdin.end(JSON.stringify({ session_id: threadId, cwd: threadCwd, hook_event_name: 'PreToolUse', ...call }))
    await new Promise((resolve) => child.on('close', resolve))
    if (output.trim() && JSON.parse(output).hookSpecificOutput?.permissionDecision === 'deny') return true
  }
  return false
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const notify = (method, params) => send({ method, params: { threadId, ...(current ? { turnId: current.id } : {}), ...params } })

function replyDecision(result) {
  if (!result || typeof result !== 'object') return 'accept'
  if ('decision' in result) return decisionName(result.decision)
  if ('action' in result) return result.action
  if ('permissions' in result) return Object.keys(result.permissions ?? {}).length ? 'accept' : 'decline'
  return 'accept'
}

function decisionName(decision) {
  if (typeof decision === 'string') return decision
  if (!decision || typeof decision !== 'object') return 'accept'
  const [name] = Object.keys(decision)
  if (name === 'acceptWithExecpolicyAmendment' || name === 'acceptForSession') return 'accept'
  if (name === 'applyNetworkPolicyAmendment') {
    return decision.applyNetworkPolicyAmendment?.network_policy_amendment?.action === 'deny' ? 'decline' : 'accept'
  }
  return name || 'accept'
}

function decisionText(decision) {
  if (typeof decision === 'string') return decision
  if (decision && typeof decision === 'object') return JSON.stringify(decision)
  return 'unknown'
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

function say(text) {
  const itemId = randomUUID()
  notify('item/agentMessage/delta', { itemId, delta: text })
  notify('item/completed', { item: { type: 'agentMessage', id: itemId, text } })
}

async function playTurn(turn) {
  const own = current
  for (const { raw, echoReply, echoDecision, delayMs, echoThread, preToolUse, then } of turn.steps) {
    if (own.ended) return
    if (preToolUse) {
      const branch = then?.[(await hooksDeny(preToolUse)) ? 'deny' : 'allow']
      if (own.ended) return
      if (branch) return playTurn({ steps: branch })
      continue
    }
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
      if (echoDecision) say(`Codex received ${decisionText(result?.decision)}`)
      if (echoReply) say(`Reply ${result?.action ?? ''}: ${JSON.stringify(result?.content ?? null)}`)
      if (result && typeof result === 'object' && 'action' in result) continue
      const decision = replyDecision(result)
      if (decision === 'cancel') {
        completeTurn('interrupted')
        return
      }
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
    case 'hooks/list': {
      const hooks = probeHooks.get(params.threadId) ?? (params.threadId === threadId ? threadHooks : [])
      return send({ id, result: { data: [{ cwd: threadCwd, hooks, warnings: [], errors: [] }] } })
    }
    case 'thread/start':
      if (params.ephemeral) {
        const probe = randomUUID()
        probeHooks.set(probe, listHooks(params.config?.hooks))
        return send({ id, result: { thread: { id: probe } } })
      }
      threadCwd = params.cwd ?? threadCwd
      threadHooks = listHooks(params.config?.hooks).map((hook) => ({
        ...hook,
        trustStatus: params.config?.hooks?.state?.[hook.key]?.trusted_hash === hook.currentHash ? 'trusted' : 'untrusted',
      }))
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
