// Turns `codex app-server` notifications and server requests into contract
// events, and contract answers into the replies Codex expects. Used by the
// Codex adapter; journeys reach it through the adapter and tests/fake-codex.mjs,
// which replays recorded runs. Types follow the protocol of
// codex-cli 0.167.0 (`codex app-server generate-ts`), reduced to the fields read here.
import type { AgentAnswer, AgentEvent, Question } from './contract'

/** A JSON-RPC message from the app server: a notification, or a server request when `id` is set. */
export type CodexRawMessage = { id?: string | number; method: string; params?: Record<string, unknown> }

type ThreadItem = {
  type: string
  id?: string
  text?: string
  command?: string
  commandActions?: { command: string }[]
  changes?: { path: string }[]
  server?: string
  tool?: string
  query?: string
  path?: string
  questions?: AsyncQuestion[] | null
}

/** A question Codex puts in an agent message in Default mode, where `request_user_input` is unavailable. */
type AsyncQuestion = { title: string; options: string[] | null }

/** Request ids of questions asked in agent messages; they are answered by steering the turn. */
export const CODEX_MESSAGE_QUESTION_PREFIX = 'codex-ask-'

type Turn = { id: string; status: 'completed' | 'interrupted' | 'failed' | 'inProgress'; error?: TurnError | null }
type TurnError = { message: string; codexErrorInfo?: unknown }

type UserInputQuestion = {
  id: string
  header: string
  question: string
  options: { label: string; description: string }[] | null
}

/** A path in a permission request, as the 0.167.0 protocol shapes it. */
type SandboxPath = { type: 'path'; path: string } | { type: 'glob_pattern'; pattern: string } | { type: 'special'; value: unknown }

function sandboxPathLabel(path: SandboxPath) {
  if (path.type === 'path') return path.path
  if (path.type === 'glob_pattern') return path.pattern
  return typeof path.value === 'string' ? path.value : JSON.stringify(path.value)
}

/** Server requests that become an approval or a question. Others are refused. */
export const CODEX_ANSWERABLE_REQUESTS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
])

const LABEL_LIMIT = 80

/**
 * The command as the user would write it. Codex wraps commands in the login
 * shell (`/bin/zsh -lc '…'`) and reports the parsed commands separately.
 */
function displayCommand(command: unknown, actions: unknown) {
  const parsed = Array.isArray(actions) ? actions.map((action: { command?: unknown }) => action.command) : []
  if (parsed.length && parsed.every((value) => typeof value === 'string' && value)) return parsed.join(' && ')
  return typeof command === 'string' ? command : undefined
}

function shorten(value: string) {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > LABEL_LIMIT ? `${line.slice(0, LABEL_LIMIT - 1)}…` : line
}

/** A short label such as `Shell: pnpm test` or `Edit: app/page.tsx`, or undefined for non-tool items. */
function itemLabel(item: ThreadItem): string | undefined {
  switch (item.type) {
    case 'commandExecution': {
      const command = displayCommand(item.command, item.commandActions)
      return command ? `Shell: ${shorten(command)}` : 'Shell'
    }
    case 'fileChange': {
      const paths = item.changes?.map((change) => change.path) ?? []
      if (paths.length === 0) return 'Edit'
      return `Edit: ${shorten(paths.length === 1 ? paths[0]! : `${paths[0]} and ${paths.length - 1} more`)}`
    }
    case 'mcpToolCall':
      return `${item.server}: ${item.tool}`
    case 'dynamicToolCall':
      return item.tool ?? 'Tool'
    case 'webSearch':
      return item.query ? `Web search: ${shorten(item.query)}` : 'Web search'
    case 'imageView':
      return item.path ? `View image: ${shorten(item.path)}` : 'View image'
    default:
      return undefined
  }
}

function isSignedOut(error: TurnError) {
  return error.codexErrorInfo === 'unauthorized'
}

/** Events for a notification. Server requests go through `codexRequestToEvent`. */
export function codexMessageToEvents(message: CodexRawMessage): AgentEvent[] {
  const params = message.params ?? {}
  switch (message.method) {
    case 'item/agentMessage/delta':
      return typeof params.delta === 'string' && params.delta ? [{ type: 'text-delta', text: params.delta }] : []
    case 'item/started': {
      const label = itemLabel(params.item as ThreadItem)
      return label ? [{ type: 'tool', label }] : []
    }
    case 'item/completed': {
      const item = params.item as ThreadItem
      if (item.type !== 'agentMessage') return []
      const events: AgentEvent[] = item.text ? [{ type: 'text', text: item.text }] : []
      if (item.questions?.length) {
        events.push({
          type: 'question',
          requestId: `${CODEX_MESSAGE_QUESTION_PREFIX}${item.id}`,
          questions: item.questions.map((question) => ({
            question: question.title,
            multiSelect: false,
            options: (question.options ?? []).map((label) => ({ label })),
          })),
        })
      }
      return events
    }
    case 'turn/completed': {
      const turn = params.turn as Turn
      const events: AgentEvent[] = []
      if (turn.status === 'failed' && turn.error) {
        events.push(
          isSignedOut(turn.error)
            ? { type: 'error', code: 'signed-out', message: 'Codex is not signed in. Run `codex login`.' }
            : { type: 'error', code: 'provider', message: turn.error.message },
        )
      }
      events.push(turn.status === 'interrupted' ? { type: 'turn-done', interrupted: true } : { type: 'turn-done' })
      return events
    }
    default:
      return []
  }
}

function detailLines(...lines: (string | number | null | undefined | false)[]) {
  const detail = lines.filter(Boolean).join('\n')
  return detail || undefined
}

/** The approval or question for an answerable server request, or undefined for any other request. */
export function codexRequestToEvent(
  requestId: string,
  message: CodexRawMessage,
): Extract<AgentEvent, { type: 'approval' | 'question' }> | undefined {
  const params = message.params ?? {}
  const reason = typeof params.reason === 'string' ? params.reason : undefined
  switch (message.method) {
    case 'item/commandExecution/requestApproval': {
      const command = displayCommand(params.command, params.commandActions)
      return {
        type: 'approval',
        requestId,
        title: command ? `Allow Shell: ${shorten(command)}?` : 'Allow a shell command?',
        detail: detailLines(reason, typeof params.cwd === 'string' && `In ${params.cwd}`),
      }
    }
    case 'item/fileChange/requestApproval':
      return {
        type: 'approval',
        requestId,
        title: 'Allow file changes?',
        detail: detailLines(reason, typeof params.grantRoot === 'string' && `Write access under ${params.grantRoot}`),
      }
    case 'item/permissions/requestApproval': {
      const permissions = params.permissions as {
        network?: { enabled: boolean | null } | null
        fileSystem?: {
          read?: string[] | null
          write?: string[] | null
          entries?: { path: SandboxPath; access: string }[]
        } | null
      }
      const entries = permissions?.fileSystem?.entries
      return {
        type: 'approval',
        requestId,
        title: 'Allow extra permissions?',
        detail: detailLines(
          reason,
          permissions?.network?.enabled && 'Network access',
          // Newer servers describe paths as entries (granted in full on Allow); the read and write lists are their legacy form.
          ...(entries?.length
            ? entries.map((entry) => `${entry.access}: ${sandboxPathLabel(entry.path)}`)
            : [
                permissions?.fileSystem?.write?.length && `Write: ${permissions.fileSystem.write.join(', ')}`,
                permissions?.fileSystem?.read?.length && `Read: ${permissions.fileSystem.read.join(', ')}`,
              ]),
        ),
      }
    }
    case 'item/tool/requestUserInput': {
      const questions: Question[] = (params.questions as UserInputQuestion[]).map((question) => ({
        question: question.question,
        header: question.header || undefined,
        multiSelect: false,
        options: (question.options ?? []).map(({ label, description }) => ({ label, description: description || undefined })),
      }))
      return { type: 'question', requestId, questions }
    }
    case 'mcpServer/elicitation/request': {
      const text = [params.message, params.title, params.description].find((value) => typeof value === 'string')
      return {
        type: 'approval',
        requestId,
        title: `Allow ${params.serverName}: ${shorten(String(text ?? 'request'))}?`,
        detail: detailLines(typeof params.url === 'string' && params.url),
      }
    }
    default:
      return undefined
  }
}

/** The JSON-RPC result that answers a server request. */
export function codexAnswerToResult(message: CodexRawMessage, answer: AgentAnswer): unknown {
  const params = message.params ?? {}
  const allow = answer.kind === 'question' || answer.allow
  switch (message.method) {
    case 'item/commandExecution/requestApproval': {
      // Codex lists the decisions it takes. Without `decline`, a denial can only `cancel`, which also ends the turn.
      const offered = Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined
      if (allow) return { decision: 'accept' }
      return { decision: !offered || offered.includes('decline') ? 'decline' : 'cancel' }
    }
    case 'item/fileChange/requestApproval':
      return { decision: allow ? 'accept' : 'decline' }
    case 'item/permissions/requestApproval': {
      const requested = params.permissions as { network?: unknown; fileSystem?: unknown }
      const granted = Object.fromEntries(Object.entries(requested ?? {}).filter(([, value]) => value != null))
      return { permissions: allow ? granted : {}, scope: 'turn' }
    }
    case 'item/tool/requestUserInput': {
      const questions = params.questions as UserInputQuestion[]
      if (answer.kind !== 'question') return { answers: {} }
      const answers = Object.fromEntries(
        questions
          .filter((question) => answer.answers[question.question] !== undefined)
          // Every question here is single-select, so the label is one answer even when it has a comma.
          .map((question) => [question.id, { answers: [answer.answers[question.question]!] }]),
      )
      return { answers }
    }
    case 'mcpServer/elicitation/request':
      // A form needs typed content the contract does not carry; accepting sends an empty form.
      return { action: allow ? 'accept' : 'decline', content: allow && params.mode !== 'url' ? {} : null, _meta: null }
    default:
      return undefined
  }
}

/** The user message that answers questions Codex asked in an agent message. */
export function codexQuestionAnswerText(answer: AgentAnswer) {
  if (answer.kind !== 'question') return 'I would rather not answer that. Continue without it.'
  return Object.entries(answer.answers)
    .map(([question, label]) => `${question} ${label}`)
    .join('\n')
}
