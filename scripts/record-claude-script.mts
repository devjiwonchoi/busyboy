// Records a short real Claude run as a provider script for the scripted
// provider (server/runner/scripted-provider.ts). It runs in a fresh temporary
// folder in Auto mode, answers every approval with Allow and every question
// with its first option (or --answer), and keeps only the messages the
// Claude event mapping reads.
//
//   node scripts/record-claude-script.mts tests/provider-scripts/name.json \
//     --description "What the run shows" [--ask "Bash(touch:*)"] [--answer Blue] \
//     "first prompt" ["second prompt" ...]
//
// With --master, the run gets the master's instructions and a stand-in for
// busyboy's MCP tools that knows the projects given by --project; replays
// call the real tools (see `mcpCalls` in server/runner/scripted-provider.ts).
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { parseArgs } from 'node:util'
import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    description: { type: 'string' },
    ask: { type: 'string', multiple: true },
    answer: { type: 'string' },
    master: { type: 'boolean' },
    project: { type: 'string', multiple: true },
  },
})
const [output, ...prompts] = positionals
if (!output || prompts.length === 0 || !values.description) {
  console.error('Usage: record-claude-script.mts <output.json> --description <text> <prompt>...')
  process.exit(1)
}

type Step = Record<string, unknown>
const turns: { prompt: string; steps: Step[] }[] = []
let steps: Step[] = []

function keep(message: SDKMessage): Step | undefined {
  const parent = 'parent_tool_use_id' in message ? message.parent_tool_use_id : null
  if (parent) return undefined
  switch (message.type) {
    case 'system':
      return message.subtype === 'init' ? { type: 'system', subtype: 'init', session_id: message.session_id } : undefined
    case 'stream_event': {
      const event = message.event
      if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') return undefined
      return { type: 'stream_event', event: { type: event.type, delta: { type: 'text_delta', text: event.delta.text } } }
    }
    case 'assistant': {
      const content = message.message.content.flatMap((block) => {
        if (block.type === 'text') return [{ type: 'text', text: block.text }]
        if (block.type === 'tool_use') return [{ type: 'tool_use', name: block.name, input: block.input }]
        return []
      })
      if (content.length === 0 && !message.error) return undefined
      return { type: 'assistant', message: { content }, ...(message.error ? { error: message.error } : {}) }
    }
    case 'result':
      return {
        type: 'result',
        subtype: message.subtype,
        is_error: message.is_error,
        ...('errors' in message && message.errors.length ? { errors: message.errors } : {}),
      }
    default:
      return undefined
  }
}

const cwd = mkdtempSync(join(tmpdir(), 'busyboy-record-'))
// Look `claude` up on the login-shell PATH (an alias such as `claude --flag` must not win).
const shellPath = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "\n%s" "$PATH"'], { encoding: 'utf8' })
  .split('\n')
  .at(-1)!
const claude = [...shellPath.split(delimiter), ...(process.env.PATH ?? '').split(delimiter)]
  .map((directory) => join(directory, 'claude'))
  .find((candidate) => existsSync(candidate))
if (!claude) throw new Error('The `claude` command was not found on the login-shell PATH.')

let release: () => void = () => {}
async function* input(): AsyncGenerator<SDKUserMessage> {
  for (const prompt of prompts) {
    steps = []
    turns.push({ prompt, steps })
    yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, origin: { kind: 'human' } }
    await new Promise<void>((resolve) => (release = resolve))
  }
}

/** A stand-in for busyboy's MCP endpoint with the same tools, for recording the master. */
async function startToolStandIn(projects: string[]) {
  const tools = [
    { name: 'list_projects', description: 'List the projects busyboy can create tasks in, with the folder of each.', inputSchema: { type: 'object', properties: {}, required: [] } },
    {
      name: 'create_task',
      description:
        'Start a task agent for one project. It gets its own git worktree and branch from the project HEAD, plans with the align skill, and does the work. Create one task per project.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'The project name, as list_projects returns it.' },
          title: { type: 'string', description: 'A short title, a few words.' },
          request: { type: 'string', description: "The user's request for this project, complete and in the user's words." },
        },
        required: ['project', 'title', 'request'],
      },
    },
  ]
  const call = (name: string, input: Record<string, string>) => {
    if (name === 'list_projects') return JSON.stringify(projects.map((project) => ({ name: project, path: `/code/${project}` })))
    const id = `${input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-a1b2c3`
    return `Created task ${id} in ${input.project} on branch busyboy/${id}. Its agent is planning the work now.`
  }
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') return response.writeHead(405).end()
    let body = ''
    for await (const chunk of request) body += chunk
    const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, string> } }
    if (message.id === undefined) return response.writeHead(202).end()
    const result =
      message.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'busyboy', version: '0.0.0' } }
        : message.method === 'tools/list'
          ? { tools }
          : message.method === 'tools/call'
            ? { content: [{ type: 'text', text: call(message.params!.name!, message.params!.arguments ?? {}) }] }
            : {}
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp` }
}

const standIn = values.master ? await startToolStandIn(values.project ?? []) : undefined
const masterOptions = standIn
  ? {
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: (await import('../server/master-context.ts')).MASTER_INSTRUCTIONS,
      },
      mcpServers: { busyboy: { type: 'http' as const, url: standIn.url, alwaysLoad: true } },
      allowedTools: ['mcp__busyboy'],
    }
  : {}

try {
  const run = query({
    prompt: input(),
    options: {
      cwd,
      pathToClaudeCodeExecutable: claude,
      permissionMode: 'auto',
      includePartialMessages: true,
      ...masterOptions,
      ...(values.ask ? { settings: { permissions: { ask: values.ask } } } : {}),
      canUseTool: async (toolName, toolInput, { title, description }) => {
        steps.push({ canUseTool: { toolName, input: toolInput, title, description } })
        if (toolName === 'AskUserQuestion') {
          const questions = toolInput.questions as { question: string; options: { label: string }[] }[]
          const answers = Object.fromEntries(questions.map((q) => [q.question, values.answer ?? q.options[0]!.label]))
          return { behavior: 'allow', updatedInput: { ...toolInput, answers } }
        }
        return { behavior: 'allow', updatedInput: toolInput }
      },
    },
  })
  for await (const message of run) {
    const step = keep(message)
    if (step) steps.push({ raw: step })
    if (message.type === 'result') {
      if (turns.length === prompts.length) break
      release()
    }
  }
  const script = { provider: 'claude', description: values.description, recordedAt: new Date().toISOString(), turns }
  writeFileSync(output, `${JSON.stringify(script, null, 2)}\n`)
  console.log(`Recorded ${turns.length} turn(s) to ${output}`)
} finally {
  standIn?.server.close()
  rmSync(cwd, { recursive: true, force: true })
}
