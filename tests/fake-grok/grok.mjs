// A fake `grok agent stdio` for journeys. The real Grok adapter starts it
// (BUSYBOY_GROK_PATH points here) and talks newline-delimited JSON-RPC to it,
// so tests exercise the adapter itself. Nothing here uses the network.
//
// Prompts pick a scripted turn. A tool call is a `session/request_permission`
// that waits for BusyBoy's outcome; there is no hook to run. `session/load`
// and `session/fork` of an id starting with `missing-` fail the way a session
// Grok no longer has fails. Any other id can be loaded: a second process does
// not share the first process's memory, and a real Grok keeps sessions on disk.
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const modeFlag = process.argv.indexOf('--permission-mode')
const argvMode = modeFlag === -1 ? 'auto' : process.argv[modeFlag + 1]

function flagValue(name) {
  const index = process.argv.indexOf(name)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (!value || value.startsWith('-')) return null
  return value
}

/** Writes the model and effort this process was started with, next to the session. */
function recordLaunch(cwd) {
  if (typeof cwd !== 'string' || !cwd) return
  mkdirSync(cwd, { recursive: true })
  writeFileSync(
    join(cwd, '.grok-launch.json'),
    `${JSON.stringify({ model: flagValue('-m'), effort: flagValue('--reasoning-effort') }, null, 2)}\n`,
  )
}

const sessions = new Map()
const pending = new Map()
let seq = 0
let currentAbort

function write(message) {
  if (process.stdout.writable) process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result })
}

function fail(id, message) {
  write({ jsonrpc: '2.0', id, error: { code: -32601, message } })
}

function missing(id) {
  return typeof id !== 'string' || id.startsWith('missing-')
}

function usesHooks(params) {
  return Boolean(params?.hooks || params?._meta?.hooks)
}

function remember(params, extra = {}) {
  const id = extra.id ?? randomUUID()
  const session = {
    id,
    cwd: params?.cwd,
    mcpServers: params?.mcpServers ?? [],
    rules: params?._meta?.rules ?? '',
    parentId: extra.parentId,
    mode: argvMode,
  }
  sessions.set(id, session)
  return session
}

/** A session this process may not have created. `missing-` ids are gone. */
function recall(id, params) {
  if (missing(id)) return undefined
  const existing = sessions.get(id)
  if (existing) {
    if (params?.mcpServers) existing.mcpServers = params.mcpServers
    if (params?._meta?.rules) existing.rules = params._meta.rules
    return existing
  }
  return remember(params ?? {}, { id })
}

function promptText(params) {
  const blocks = Array.isArray(params?.prompt) ? params.prompt : []
  return blocks.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('')
}

function say(session, text) {
  const messageId = `msg-${++seq}`
  const split = Math.ceil(text.length / 2)
  for (const part of [text.slice(0, split), text.slice(split)].filter(Boolean)) {
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: session.id,
        update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: part } },
      },
    })
  }
}

/** Records that BusyBoy allowed the command, so a journey can see it without a card. */
function noteAllowed(session, command) {
  if (session.cwd) writeFileSync(join(session.cwd, '.grok-ran'), `${command}\n`)
}

function usedTool(session, command) {
  noteAllowed(session, command)
  write({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: session.id,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: `tool-${++seq}`,
        title: `Execute \`${command}\``,
        kind: 'execute',
        name: 'run_terminal_command',
        status: 'completed',
        rawInput: { variant: 'Bash', command },
      },
    },
  })
}

function decisionOf(result) {
  const outcome = result?.outcome
  if (!outcome || outcome.outcome === 'cancelled') return 'cancel'
  if (outcome.outcome === 'selected' && (outcome.optionId === 'allow-once' || outcome.optionId === 'allow-always')) return 'allow'
  return 'deny'
}

function ask(session, signal, command) {
  if (signal.aborted) return Promise.resolve('cancel')
  const id = `perm-${++seq}`
  return new Promise((resolve) => {
    const finish = (decision) => {
      signal.removeEventListener('abort', onAbort)
      resolve(decision)
    }
    const onAbort = () => {
      pending.delete(id)
      finish('cancel')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.set(id, finish)
    write({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: {
        sessionId: session.id,
        toolCall: {
          toolCallId: `call-${seq}`,
          title: `Execute \`${command}\``,
          kind: 'execute',
          name: 'run_terminal_command',
          status: 'pending',
          rawInput: { variant: 'Bash', command },
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
      },
    })
  })
}

function hasBusyboy(servers) {
  return (servers ?? []).some((server) => {
    if (server?.name !== 'busyboy' || server.type !== 'http') return false
    if (typeof server.url !== 'string' || !server.url.includes('/api/mcp')) return false
    const headers = server.headers
    return Array.isArray(headers) && headers.length > 0 && headers.every((header) => typeof header?.name === 'string' && typeof header?.value === 'string')
  })
}

async function play(session, text, signal) {
  if (signal.aborted) return 'cancelled'
  if (text.includes('Hello from busyboy')) {
    say(session, session.rules?.trim() ? 'Hello from busyboy.' : 'Missing instructions.')
    return 'end_turn'
  }
  if (text.includes('Force push the branch') || text.includes('Force push the main branch')) {
    const commands = ['git push --force origin HEAD', 'git push --force origin HEAD', 'git push --force origin release']
    for (const command of commands) {
      const decision = await ask(session, signal, command)
      if (decision !== 'allow') {
        if (decision === 'cancel') return 'cancelled'
        say(session, 'Declined the push.')
        return 'end_turn'
      }
      usedTool(session, command)
    }
    say(session, 'Pushed.')
    return 'end_turn'
  }
  if (text.includes('Remove the build folder')) {
    const decision = await ask(session, signal, 'rm -rf build')
    if (decision !== 'allow') {
      if (decision === 'cancel') return 'cancelled'
      say(session, 'Declined.')
      return 'end_turn'
    }
    usedTool(session, 'rm -rf build')
    say(session, 'Removed the build folder.')
    return 'end_turn'
  }
  if (text.includes('Which MCP servers')) {
    say(session, hasBusyboy(session.mcpServers) ? 'busyboy http with headers.' : 'No busyboy MCP server.')
    return 'end_turn'
  }
  if (text.includes('How was this thread started')) {
    const tools = session.mode === 'dontAsk' ? 'off' : 'on'
    say(session, session.parentId ? `Branched from ${session.parentId}. Tools: ${tools}.` : 'Not a branch.')
    return 'end_turn'
  }
  say(session, 'No script for this prompt.')
  return 'end_turn'
}

function handle(message) {
  const { id, method, params } = message
  if (id === undefined) {
    if (method === 'session/cancel') currentAbort?.abort()
    return
  }
  if (usesHooks(params)) {
    fail(id, 'Grok hooks are fail-open and BusyBoy must not install them.')
    return
  }
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: 1,
        agentInfo: { name: 'grok', title: 'Grok', version: 'fake' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: {},
        },
        authMethods: [{ id: 'cached_token', name: 'Saved login' }],
      })
      return
    case 'authenticate':
      if (params?.methodId === 'cached_token' || params?.methodId === 'xai.api_key') reply(id, {})
      else fail(id, 'Grok is not signed in. Run `grok login`.')
      return
    case 'session/new': {
      const session = remember(params)
      recordLaunch(params?.cwd)
      reply(id, { sessionId: session.id })
      return
    }
    case 'session/load': {
      const session = recall(params?.sessionId, params)
      if (!session) {
        fail(id, `No conversation found with session ID: ${params?.sessionId}`)
        return
      }
      reply(id, {})
      return
    }
    case 'session/fork': {
      if (missing(params?.sessionId)) {
        fail(id, `No conversation found with session ID: ${params?.sessionId}`)
        return
      }
      const session = remember(params, { parentId: params.sessionId })
      reply(id, { sessionId: session.id })
      return
    }
    case 'session/set_mode': {
      const session = sessions.get(params?.sessionId)
      if (!session) {
        fail(id, `No conversation found with session ID: ${params?.sessionId}`)
        return
      }
      session.mode = params?.modeId
      reply(id, {})
      return
    }
    case 'session/prompt': {
      const session = sessions.get(params?.sessionId)
      if (!session) {
        fail(id, `No conversation found with session ID: ${params?.sessionId}`)
        return
      }
      const controller = new AbortController()
      currentAbort = controller
      void play(session, promptText(params), controller.signal).then((stopReason) => {
        if (currentAbort === controller) currentAbort = undefined
        reply(id, { stopReason })
      })
      return
    }
    case '_x.ai/compact_conversation':
      reply(id, {})
      return
    default:
      fail(id, `Method not found: ${method}`)
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.method) {
    handle(message)
    return
  }
  const finish = pending.get(message.id)
  if (!finish) return
  pending.delete(message.id)
  finish(decisionOf(message.result))
})

process.stdin.on('end', () => process.exit(0))
