// Turns `codex app-server` notifications and server requests into contract
// events, and contract answers into the replies Codex expects. It has no
// process handling, so a live run and a replayed recording map the same way.
// Types follow the protocol of
// codex-cli 0.167.0 (`codex app-server generate-ts`), reduced to the fields read here.
import { TEXT_DELTA_FLUSH_MS } from './claude-events'
import {
  elicitationContent,
  elicitationDefaults,
  elicitationQuestions,
  unfillableFields,
  type ElicitationSchema,
} from './codex-elicitation'
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
type TurnError = { message: string; codexErrorInfo?: unknown; additionalDetails?: string | null }

type UserInputQuestion = {
  id: string
  header: string
  question: string
  options: { label: string; description: string }[] | null
}

/** A path in a permission request, as the 0.167.0 protocol shapes it. */
type SandboxPath =
  | { type: 'path'; path: string }
  | { type: 'glob_pattern'; pattern: string }
  | { type: 'special'; value: { kind: string; path?: string; subpath?: string | null } }

const SPECIAL_PATHS: Record<string, string> = {
  root: 'the whole disk',
  minimal: 'system paths',
  tmpdir: 'the temporary folder',
  slash_tmp: '/tmp',
  project_roots: 'the project folders',
}

function sandboxPathLabel(path: SandboxPath) {
  if (path.type === 'path') return path.path
  if (path.type === 'glob_pattern') return path.pattern
  const { kind, path: unknownPath, subpath } = path.value
  const base = SPECIAL_PATHS[kind] ?? unknownPath ?? kind
  return subpath ? `${subpath} in ${base}` : base
}

const ACCESS_LABELS: Record<string, string> = { read: 'Read', write: 'Write', deny: 'No access' }

/** The permissions a request asks for, as in `item/permissions/requestApproval` and command approvals. */
type PermissionProfile = {
  network?: { enabled: boolean | null } | null
  fileSystem?: {
    read?: string[] | null
    write?: string[] | null
    entries?: { path: SandboxPath; access: string }[]
  } | null
}

function permissionLines(permissions: PermissionProfile | null | undefined) {
  const entries = permissions?.fileSystem?.entries
  return [
    permissions?.network?.enabled && 'Network access',
    // Newer servers describe paths as entries (granted in full on Allow); the read and write lists are their legacy form.
    ...(entries?.length
      ? entries.map((entry) => `${ACCESS_LABELS[entry.access] ?? entry.access}: ${sandboxPathLabel(entry.path)}`)
      : [
          permissions?.fileSystem?.write?.length && `Write: ${permissions.fileSystem.write.join(', ')}`,
          permissions?.fileSystem?.read?.length && `Read: ${permissions.fileSystem.read.join(', ')}`,
        ]),
  ]
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

/** Readable text for failures Codex reports by code. Codex's own message follows when it adds detail. */
const ERROR_TEXT: Record<string, string> = {
  contextWindowExceeded: 'Codex stopped: the conversation is longer than the model can read. Compact it or start a new agent.',
  sessionBudgetExceeded: "Codex stopped: the session's budget ran out.",
  usageLimitExceeded: 'Codex hit its usage limit.',
  rateLimitExceeded: 'Codex hit its rate limit. Try again shortly.',
  serverOverloaded: 'Codex is overloaded right now. Try again shortly.',
  modelNotFound: 'Codex could not find the selected model.',
  internalServerError: 'Codex ran into a server error. Try again shortly.',
  badRequest: 'Codex rejected the request.',
  sandboxError: 'Codex could not run the command in its sandbox.',
  tooManyDenials: 'Codex stopped after too many denied requests.',
  cyberPolicy: 'Codex declined the request under its usage policy.',
  misalignmentPolicyViolation: 'Codex declined the request under its usage policy.',
  policyCapacityUnavailable: 'Codex is out of capacity right now. Try again shortly.',
  flexUnavailable: 'Codex has no flex capacity right now. Try again shortly.',
  httpConnectionFailed: 'Codex could not reach its server.',
  responseStreamConnectionFailed: 'Codex could not reach its server.',
  responseStreamDisconnected: 'Codex lost the connection to its server.',
  responseTooManyFailedAttempts: 'Codex gave up after repeated failed requests.',
}
const DETAIL_LIMIT = 500

/** The error code: a string, or the single key of an object variant such as `{ httpConnectionFailed: {...} }`. */
function errorCode(info: unknown): { code?: string; httpStatus?: number } {
  if (typeof info === 'string') return { code: info }
  if (!info || typeof info !== 'object') return {}
  const [code, value] = Object.entries(info)[0] ?? []
  const status = (value as { httpStatusCode?: unknown } | undefined)?.httpStatusCode
  return { code, httpStatus: typeof status === 'number' ? status : undefined }
}

/** The event for a failed turn: signed out, or a readable provider error. */
export function codexErrorEvent(error: TurnError | null | undefined): Extract<AgentEvent, { type: 'error' }> {
  const { code, httpStatus } = errorCode(error?.codexErrorInfo)
  if (code === 'unauthorized' || httpStatus === 401) {
    return { type: 'error', code: 'signed-out', message: 'Codex is not signed in. Run `codex login`.' }
  }
  const detail = (error?.additionalDetails?.trim() || error?.message?.trim() || '').slice(0, DETAIL_LIMIT)
  const known = httpStatus === 429 ? ERROR_TEXT.rateLimitExceeded : code ? ERROR_TEXT[code] : undefined
  const message = known && detail && detail !== known ? `${known} Codex said: ${detail}` : known || detail || 'The Codex turn failed.'
  return { type: 'error', code: 'provider', message }
}

/**
 * Maps one Codex thread's notifications to contract events, in order.
 *
 * Each agent message is a text item with Codex's item id. Its streamed deltas
 * are gathered for TEXT_DELTA_FLUSH_MS and sent together, so a long reply adds
 * a few events per second instead of one per token. The completed item sends
 * its text only when it never streamed or differs from what streamed. Any
 * other event first sends the deltas still gathered, so order is kept.
 * Server requests go through `codexRequestToEvent`.
 */
export class CodexEventMapper {
  /** Full streamed text by item id, until the item completes. */
  private streamed = new Map<string, string>()
  /** Deltas not sent yet, by item id, in arrival order. */
  private pending = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  /** The last error Codex reported for the running turn without retrying; it explains the failure best. */
  private turnError: TurnError | undefined
  /** MCP servers whose failed start was reported; Codex retries and reports it again. */
  private failedServers = new Set<string>()
  /** A denial in the running turn could only `cancel` it (see `deniedWithCancel`). */
  private endedByDenial = false

  /**
   * @param mcpServers Names of the MCP servers this agent passed to Codex; only their startup
   * failures are reported, not those of servers in the user's own Codex config.
   */
  constructor(
    private readonly emit: (event: AgentEvent) => void,
    private readonly mcpServers: ReadonlySet<string> = new Set(),
  ) {}

  /**
   * A command was denied with `cancel`, because the request offered no
   * `decline`. Claude takes a denial and goes on with the turn; Codex ends it.
   * That gap cannot be closed from here, so instead of showing the turn as
   * interrupted (which reads as the user's doing), it ends normally with a
   * note saying what happened.
   */
  deniedWithCancel() {
    this.endedByDenial = true
  }

  push(message: CodexRawMessage) {
    const params = message.params ?? {}
    switch (message.method) {
      case 'item/agentMessage/delta': {
        if (typeof params.delta !== 'string' || !params.delta) return
        this.append(typeof params.itemId === 'string' ? params.itemId : 'agent-message', params.delta)
        return
      }
      case 'item/started': {
        const label = itemLabel(params.item as ThreadItem)
        if (label) this.send({ type: 'tool', label })
        return
      }
      case 'item/completed': {
        const item = params.item as ThreadItem
        if (item.type === 'agentMessage') this.completeMessage(item)
        return
      }
      case 'error': {
        // Codex retries some failures itself; only a final one explains the turn.
        if (params.willRetry !== true) this.turnError = params.error as TurnError
        return
      }
      case 'mcpServer/startupStatus/updated': {
        const name = String(params.name)
        if (params.status !== 'failed' || !this.mcpServers.has(name) || this.failedServers.has(name)) return
        this.failedServers.add(name)
        const reason = typeof params.error === 'string' && params.error.trim() ? `: ${params.error.trim().slice(0, DETAIL_LIMIT)}` : '.'
        this.send({ type: 'error', code: 'provider', message: `The MCP server ${name} failed to start${reason}` })
        return
      }
      case 'turn/completed': {
        const turn = params.turn as Turn
        // The `error` notification repeats the failure with more detail than the completed turn.
        if (turn.status === 'failed') this.send(codexErrorEvent(this.turnError ?? turn.error))
        this.turnError = undefined
        const endedByDenial = this.endedByDenial
        this.endedByDenial = false
        if (turn.status === 'interrupted' && endedByDenial) {
          this.send({ type: 'error', code: 'provider', message: 'The command was denied, so Codex ended the turn.' })
          this.send({ type: 'turn-done' })
        } else this.send(turn.status === 'interrupted' ? { type: 'turn-done', interrupted: true } : { type: 'turn-done' })
        this.streamed.clear()
        return
      }
    }
  }

  /** Sends gathered deltas now, for example before the session reports it stopped. */
  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const pending = this.pending
    this.pending = new Map()
    for (const [itemId, text] of pending) this.emit({ type: 'text-delta', itemId, text })
  }

  /** Stops the flush timer without sending anything. */
  dispose() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending.clear()
  }

  private send(event: AgentEvent) {
    this.flush()
    this.emit(event)
  }

  private append(itemId: string, text: string) {
    this.streamed.set(itemId, (this.streamed.get(itemId) ?? '') + text)
    this.pending.set(itemId, (this.pending.get(itemId) ?? '') + text)
    this.timer ??= setTimeout(() => this.flush(), TEXT_DELTA_FLUSH_MS)
  }

  private completeMessage(item: ThreadItem) {
    const itemId = item.id ?? 'agent-message'
    const streamed = this.streamed.get(itemId)
    this.streamed.delete(itemId)
    if (item.text && item.text !== streamed) this.send({ type: 'text', itemId, text: item.text })
    else this.flush()
    if (item.questions?.length) {
      this.send({
        type: 'question',
        requestId: `${CODEX_MESSAGE_QUESTION_PREFIX}${itemId}`,
        questions: item.questions.map((question) => ({
          question: question.title,
          multiSelect: false,
          options: (question.options ?? []).map((label) => ({ label })),
        })),
      })
    }
  }
}

function detailLines(...lines: (string | number | null | undefined | false)[]) {
  const detail = lines.filter(Boolean).join('\n')
  return detail || undefined
}

type ElicitationParams = {
  serverName?: string
  mode?: string
  message?: string
  title?: string
  description?: string
  url?: string
  requestedSchema?: ElicitationSchema
}

/** Whether an elicitation is a form BusyBoy shows as questions. */
function isForm(params: ElicitationParams) {
  return params.mode === 'form' || params.mode === 'openai/form' || params.mode === 'openaiForm'
}

/**
 * A reply BusyBoy sends without asking, with the reason it shows, for requests
 * it cannot present: forms with a required free-text field and no default, and
 * challenges such as `openai/userVerification`.
 */
export function codexAutoReply(message: CodexRawMessage): { result: unknown; notice: string } | undefined {
  if (message.method !== 'mcpServer/elicitation/request') return undefined
  const params = (message.params ?? {}) as ElicitationParams
  const decline = { action: 'decline', content: null, _meta: null }
  if (isForm(params)) {
    const missing = unfillableFields(params.requestedSchema ?? {})
    if (missing.length === 0) return undefined
    return {
      result: decline,
      notice: `The MCP server ${params.serverName} asked for a form BusyBoy cannot fill in yet (${missing.join(', ')}), so it was declined.`,
    }
  }
  if (params.mode === 'url') return undefined
  return { result: decline, notice: `The MCP server ${params.serverName} asked for a ${params.mode} check BusyBoy does not support, so it was declined.` }
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
      const network = params.networkApprovalContext as { host?: string; protocol?: string } | null | undefined
      const offered = Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined
      // `writeStdin` sends input to a command that is already running.
      const title =
        params.kind === 'writeStdin'
          ? 'Allow input to a running command?'
          : command
            ? `Allow Shell: ${shorten(command)}?`
            : 'Allow a shell command?'
      return {
        type: 'approval',
        requestId,
        title,
        // Accepting also grants what the command asks for beyond the sandbox, so it is shown.
        detail: detailLines(
          reason,
          typeof params.cwd === 'string' && `In ${params.cwd}`,
          network?.host && `Network: ${network.host}`,
          ...permissionLines(params.additionalPermissions as PermissionProfile | null | undefined),
        ),
        canAllowForSession: !offered || offered.includes('acceptForSession'),
      }
    }
    case 'item/fileChange/requestApproval':
      return {
        type: 'approval',
        requestId,
        title: 'Allow file changes?',
        detail: detailLines(reason, typeof params.grantRoot === 'string' && `Write access under ${params.grantRoot}`),
        canAllowForSession: true,
      }
    case 'item/permissions/requestApproval': {
      return {
        type: 'approval',
        requestId,
        title: 'Allow extra permissions?',
        detail: detailLines(reason, ...permissionLines(params.permissions as PermissionProfile)),
        canAllowForSession: true,
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
      const elicitation = params as ElicitationParams
      const text = [elicitation.message, elicitation.title, elicitation.description].find((value) => typeof value === 'string')
      if (isForm(elicitation)) {
        const questions = elicitationQuestions(elicitation.message ?? '', elicitation.requestedSchema ?? {})
        if (questions.length > 0) return { type: 'question', requestId, questions }
      }
      // A link to open, or a form with nothing to choose: allowing accepts it as it is, so the values it sends are shown.
      const defaults = isForm(elicitation) ? elicitationDefaults(elicitation.requestedSchema ?? {}) : []
      return {
        type: 'approval',
        requestId,
        title: `Allow ${elicitation.serverName}: ${shorten(String(text ?? 'request'))}?`,
        detail: detailLines(typeof elicitation.url === 'string' && elicitation.url, defaults.length > 0 && 'Sends:', ...defaults),
        canAllowForSession: false,
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
  const forSession = answer.kind === 'approval' && answer.allow && Boolean(answer.forSession)
  switch (message.method) {
    case 'item/commandExecution/requestApproval': {
      // Codex lists the decisions it takes. Without `decline`, a denial can only `cancel`, which also ends the turn.
      const offered = Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined
      if (allow) return { decision: forSession && (!offered || offered.includes('acceptForSession')) ? 'acceptForSession' : 'accept' }
      return { decision: !offered || offered.includes('decline') ? 'decline' : 'cancel' }
    }
    case 'item/fileChange/requestApproval':
      return { decision: allow ? (forSession ? 'acceptForSession' : 'accept') : 'decline' }
    case 'item/permissions/requestApproval': {
      const requested = params.permissions as { network?: unknown; fileSystem?: unknown }
      const granted = Object.fromEntries(Object.entries(requested ?? {}).filter(([, value]) => value != null))
      return { permissions: allow ? granted : {}, scope: forSession ? 'session' : 'turn' }
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
    case 'mcpServer/elicitation/request': {
      const elicitation = params as ElicitationParams
      const decline = { action: 'decline', content: null, _meta: null }
      if (answer.kind === 'question') {
        // Answered from question cards: the form content, typed as its schema asks.
        const content = elicitationContent(elicitation.message ?? '', elicitation.requestedSchema ?? {}, answer)
        return content ? { action: 'accept', content, _meta: null } : decline
      }
      if (!answer.allow) return decline
      // A form with nothing to choose sends its defaults; a link sends no content.
      const content = isForm(elicitation) ? (elicitationContent('', elicitation.requestedSchema ?? {}, { kind: 'question', answers: {} }) ?? {}) : null
      return { action: 'accept', content, _meta: null }
    }
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
