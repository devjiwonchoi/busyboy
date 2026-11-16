// Records a short real Claude run as a provider script for the scripted
// provider (src/server/runner/scripted-provider.ts). It runs in a fresh temporary
// folder in Auto mode, answers every approval with Allow and every question
// with its first option (or --answer), and keeps only the messages the
// Claude event mapping reads.
//
//   node scripts/record-claude-script.mts tests/provider-scripts/name.json \
//     --description "What the run shows" [--ask "Bash(touch:*)"] [--answer Blue] \
//     "first prompt" ["second prompt" ...]
import { execFileSync } from 'node:child_process'
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
      if (event.type === 'message_start') return { type: 'stream_event', event: { type: event.type, message: { id: event.message.id } } }
      if (event.type === 'content_block_start' && event.content_block.type === 'text') {
        const block = { type: 'text', text: event.content_block.text }
        return { type: 'stream_event', event: { type: event.type, index: event.index, content_block: block } }
      }
      if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') return undefined
      const delta = { type: 'text_delta', text: event.delta.text }
      return { type: 'stream_event', event: { type: event.type, index: event.index, delta } }
    }
    case 'assistant': {
      const content = message.message.content.flatMap((block): Step[] => {
        if (block.type === 'text') return [{ type: 'text', text: block.text }]
        if (block.type === 'tool_use') return [{ type: 'tool_use', name: block.name, input: block.input }]
        return []
      })
      if (content.length === 0 && !message.error) return undefined
      const recorded = { id: message.message.id, content }
      return { type: 'assistant', message: recorded, ...(message.error ? { error: message.error } : {}) }
    }
    case 'result':
      return {
        type: 'result',
        subtype: message.subtype,
        is_error: message.is_error,
        ...(message.terminal_reason ? { terminal_reason: message.terminal_reason } : {}),
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

try {
  const run = query({
    prompt: input(),
    options: {
      cwd,
      pathToClaudeCodeExecutable: claude,
      permissionMode: 'auto',
      includePartialMessages: true,
      ...(values.ask ? { settings: { permissions: { ask: values.ask } } } : {}),
      canUseTool: async (toolName, toolInput, { title, description, suggestions, suppressAlwaysAllowRule }) => {
        // Suggestions that would grant more than the request do not count (see claude-adapter.ts).
        const sessionSuggestions = suppressAlwaysAllowRule ? undefined : suggestions
        steps.push({ canUseTool: { toolName, input: toolInput, title, description, suggestions: sessionSuggestions } })
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
  rmSync(cwd, { recursive: true, force: true })
}
