// Records a short real Codex run as a script for the fake Codex
// (tests/fake-codex.mjs), which replays it to the real adapter in journeys. It starts `codex app-server`
// in a fresh temporary folder, answers every approval with accept and every
// question with its first option (or --answer), and keeps only the messages
// the Codex event mapping reads (server/runner/codex-events.ts).
//
//   node scripts/record-codex-script.mts tests/provider-scripts/codex/name.json \
//     --description "What the run shows" [--policy untrusted] [--reviewer user] \
//     [--sandbox workspace-write] [--plan] [--answer Blue] [--log raw.jsonl] [--timeout-ms 180000] "first prompt" ["second prompt" ...]
//
// Defaults are busyboy's Auto mode: on-request, auto_review, workspace-write.
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    description: { type: 'string' },
    policy: { type: 'string', default: 'on-request' },
    reviewer: { type: 'string', default: 'auto_review' },
    sandbox: { type: 'string', default: 'workspace-write' },
    plan: { type: 'boolean', default: false },
    answer: { type: 'string' },
    log: { type: 'string' },
    'timeout-ms': { type: 'string', default: '180000' },
  },
})
const [output, ...prompts] = positionals
if (!output || prompts.length === 0 || !values.description) {
  console.error('Usage: record-codex-script.mts <output.json> --description <text> <prompt>...')
  process.exit(1)
}

type Message = { id?: number | string; method?: string; params?: Record<string, any>; result?: any; error?: any }

const REQUESTS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
])

const NON_TOOL_ITEMS = new Set(['userMessage', 'hookPrompt', 'reasoning', 'agentMessage', 'plan', 'contextCompaction', 'sleep'])

/** Keeps a message in the shape the mapping reads, or drops it. */
function keep(message: Message): Message | undefined {
  const { method, params = {} } = message
  if (message.id !== undefined && method && REQUESTS.has(method)) {
    const { threadId, turnId, itemId, startedAtMs, ...rest } = params
    return { id: message.id, method, params: rest }
  }
  switch (method) {
    case 'thread/started':
      return { method, params: { thread: { id: params.thread.id } } }
    case 'item/agentMessage/delta':
      return { method, params: { delta: params.delta } }
    case 'item/started':
    case 'item/completed': {
      const item = params.item
      // Started items become tool labels; completed agent messages become text.
      const kept = method === 'item/started' ? !NON_TOOL_ITEMS.has(item.type) : item.type === 'agentMessage'
      if (!kept) return undefined
      const fields: Record<string, unknown> = { type: item.type, id: item.id }
      for (const key of ['text', 'command', 'server', 'tool', 'query', 'path']) if (item[key]) fields[key] = item[key]
      if (item.commandActions) fields.commandActions = item.commandActions.map((action: { command: string }) => ({ command: action.command }))
      if (item.questions?.length) fields.questions = item.questions
      if (item.changes) fields.changes = item.changes.map((change: { path: string }) => ({ path: change.path }))
      return { method, params: { item: fields } }
    }
    case 'turn/completed': {
      const { id, status, error } = params.turn
      return { method, params: { turn: { id, status, error: error ? { message: error.message, codexErrorInfo: error.codexErrorInfo } : null } } }
    }
    default:
      return undefined
  }
}

function answerFor(message: Message): unknown {
  const params = message.params ?? {}
  switch (message.method) {
    case 'item/permissions/requestApproval':
      return {
        permissions: Object.fromEntries(Object.entries(params.permissions ?? {}).filter(([, value]) => value != null)),
        scope: 'turn',
      }
    case 'item/tool/requestUserInput':
      return {
        answers: Object.fromEntries(
          params.questions.map((question: { id: string; options: { label: string }[] | null }) => [
            question.id,
            { answers: [values.answer ?? question.options?.[0]?.label ?? ''] },
          ]),
        ),
      }
    case 'mcpServer/elicitation/request':
      return { action: 'accept', content: params.mode === 'url' ? null : {}, _meta: null }
    default:
      return { decision: 'accept' }
  }
}

const cwd = mkdtempSync(join(tmpdir(), 'busyboy-record-'))
// Look `codex` up on the login-shell PATH (an alias such as `codex --flag` must not win).
const shellPath = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "\n%s" "$PATH"'], { encoding: 'utf8' })
  .split('\n')
  .at(-1)!
const codex = [...shellPath.split(delimiter), ...(process.env.PATH ?? '').split(delimiter)]
  .map((directory) => join(directory, 'codex'))
  .find((candidate) => existsSync(candidate))
if (!codex) throw new Error('The `codex` command was not found on the login-shell PATH.')

// Like the server's agent environment (server/runner/find-executable.ts), busyboy's own variables stay out.
// Next types NODE_ENV as required in ProcessEnv; leaving it out is the point.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/^(BUSYBOY_|__NEXT)/i.test(name) && !/^(PORT|HOSTNAME|NODE_ENV|NEXT_RUNTIME|ELECTRON_RUN_AS_NODE)$/i.test(name),
  ),
) as NodeJS.ProcessEnv
const child = spawn(codex, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] })
if (values.log) writeFileSync(values.log, '')
const pending = new Map<number, (message: Message) => void>()
let nextId = 1
let onTurnCompleted: () => void = () => {}
let threadId = ''
let turnId = ''
type Step = { raw: Message }
const turns: { prompt: string; steps: Step[] }[] = []

const send = (message: Message) => child.stdin.write(`${JSON.stringify(message)}\n`)
const request = (method: string, params: unknown) =>
  new Promise<any>((resolve, reject) => {
    const id = nextId++
    pending.set(id, (message) => (message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)))
    send({ id, method, params } as Message)
  })

createInterface({ input: child.stdout }).on('line', (line) => {
  const message = JSON.parse(line) as Message
  if (values.log) appendFileSync(values.log, `${line}\n`)
  if (!message.method) {
    pending.get(Number(message.id))?.(message)
    return
  }
  // Subagent and reviewer threads stay out of the recording, as the adapter ignores them.
  const ownThread = !threadId || !message.params?.threadId || message.params.threadId === threadId
  if (message.id !== undefined) {
    const step = keep(message)
    if (step && ownThread) turns.at(-1)?.steps.push({ raw: step })
    if (REQUESTS.has(message.method)) send({ id: message.id, result: answerFor(message) })
    else send({ id: message.id, error: { code: -32601, message: 'Not handled.' } } as Message)
    return
  }
  if (!ownThread) return
  const step = keep(message)
  if (step) turns.at(-1)?.steps.push({ raw: step })
  if (message.method === 'turn/started') turnId = message.params?.turn.id
  if (message.method === 'turn/completed') onTurnCompleted()
  // In Default mode Codex asks in an agent message and waits; the answer steers the running turn.
  const item = message.params?.item
  if (message.method === 'item/completed' && item?.type === 'agentMessage' && item.questions?.length) {
    const text = item.questions
      .map((question: { title: string; options: string[] | null }) => `${question.title} ${values.answer ?? question.options?.[0] ?? ''}`)
      .join('\n')
    void request('turn/steer', { threadId, input: [{ type: 'text', text, text_elements: [] }], expectedTurnId: turnId })
  }
})

// A run that never completes its turn (for example one waiting on a tool the client did not answer) ends here.
const timeout = setTimeout(() => {
  console.error('The run did not finish in time.')
  child.kill()
  rmSync(cwd, { recursive: true, force: true })
  process.exit(1)
}, Number(values['timeout-ms']))

try {
  await request('initialize', {
    clientInfo: { name: 'busyboy-recorder', title: null, version: '0.0.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  })
  send({ method: 'initialized' })
  const start = await request('thread/start', {
    cwd,
    approvalPolicy: values.policy,
    approvalsReviewer: values.reviewer,
    sandbox: values.sandbox,
  })
  threadId = start.thread.id
  for (const prompt of prompts) {
    const steps: Step[] = []
    turns.push({ prompt, steps })
    const done = new Promise<void>((resolve) => (onTurnCompleted = resolve))
    await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      ...(values.plan ? { collaborationMode: { mode: 'plan', settings: { model: start.model, reasoning_effort: null } } } : {}),
    })
    await done
  }
  const script = { provider: 'codex', description: values.description, recordedAt: new Date().toISOString(), turns }
  writeFileSync(output, `${JSON.stringify(script, null, 2)}\n`)
  console.log(`Recorded ${turns.length} turn(s) to ${output}`)
} finally {
  clearTimeout(timeout)
  child.kill()
  rmSync(cwd, { recursive: true, force: true })
}
