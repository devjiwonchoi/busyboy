import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { ALWAYS_ASK_PATH, alwaysAskTokenFor, MCP_TOKEN_HEADER, SERVER_TOKEN_ENV } from '@/lib/server-token'
import { alwaysAskRules } from '../always-ask-list'
import { resolveDataFolder } from '../config'
import { listProjects } from '../projects'
import { matchAlwaysAsk } from './always-ask'

// Codex's Auto mode lets its auto reviewer approve escalations without the
// user, so the always-ask list reaches Codex through a PreToolUse command hook
// instead: BusyBoy adds the hook to each task thread's config, the hook posts
// every tool call to ALWAYS_ASK_PATH and waits, and the session that owns the
// thread answers once the user has (see `codexAdapter`). The hook fails closed:
// when BusyBoy cannot be reached, the tool call is blocked. Verified live with
// codex-cli 0.167.0: the hook gets `session_id` (the thread id), `cwd`,
// `tool_name` ("Bash" for shell commands) and `tool_input`, and its denial
// blocks the command.

/** What a hook asks about: the tool call and where it came from. */
export type HookCall = { sessionId: string | undefined; cwd: string | undefined; toolName: string; input: unknown }

export type HookDecision = { allow: boolean; reason: string }

/** `signal` aborts when the hook went away (its turn ended, or it timed out), so the session drops the approval. */
type Gate = (call: Pick<HookCall, 'toolName' | 'input'> & { signal: AbortSignal }) => Promise<HookDecision>

// On globalThis like the runner's registry, so `next dev` reloads keep the open sessions.
const GATES_KEY = Symbol.for('busyboy.codex-always-ask')
const globalStore = globalThis as typeof globalThis & { [GATES_KEY]?: Map<string, Gate> }
const gates = (globalStore[GATES_KEY] ??= new Map())

/** Lets the hook calls of a thread, or of anything run inside a working folder, reach `gate`. */
export function registerGate({ key, gate }: { key: string; gate: Gate }) {
  gates.set(key, gate)
  return () => {
    if (gates.get(key) === gate) {
      gates.delete(key)
    }
  }
}

export const threadKey = (threadId: string) => `thread:${threadId}`
export const folderKey = (cwd: string) => `cwd:${cwd}`

/**
 * Decides a hook call: the owning session asks the user when a rule matches.
 * A call is matched by its thread, else by a folder inside a task's folder (a
 * subagent the task started). Codex also runs its own background agents, such
 * as memory consolidation in ~/.codex/memories, with the thread's hooks; those
 * are not BusyBoy's to ask about and run. A call with no owner that works in
 * BusyBoy's data folder or a project, such as a task's subagent in the
 * project's main checkout, has no session to ask, so it is blocked when a rule
 * matches.
 */
export function decideHookCall({ call, signal }: { call: HookCall; signal: AbortSignal }): Promise<HookDecision> {
  const byThread = call.sessionId ? gates.get(threadKey(call.sessionId)) : undefined
  const byFolder = call.cwd
    ? [...gates.entries()].find(([key]) => key.startsWith('cwd:') && isInside({ folder: key.slice('cwd:'.length), path: call.cwd! }))?.[1]
    : undefined
  const gate = byThread ?? byFolder
  if (!gate) {
    return decideUnowned(call)
  }
  return gate({ toolName: call.toolName, input: call.input, signal })
}

async function decideUnowned(call: HookCall): Promise<HookDecision> {
  const cwd = call.cwd
  if (!cwd) return { allow: true, reason: '' }
  const folders = [resolveDataFolder(), ...(await listProjects()).map(({ path }) => path)]
  if (!folders.some((folder) => isInside({ folder, path: cwd }))) return { allow: true, reason: '' }
  const rule = matchAlwaysAsk({ rules: await alwaysAskRules(), toolName: call.toolName, input: call.input, folder: cwd })
  if (!rule) return { allow: true, reason: '' }
  return { allow: false, reason: `${rule}. BusyBoy did not start this agent, so it cannot ask the user, and blocked the action.` }
}

function isInside({ folder, path }: { folder: string; path: string }) {
  const inside = relative(folder, path)
  return !inside.startsWith('..') && !isAbsolute(inside)
}

// The hook script, run by Codex with the tool call as JSON on stdin. It prints
// a PreToolUse denial to block the call and prints nothing to let it run. The
// server keeps the response open with spaces until the user answers, so a long
// wait never hits fetch's idle timeout. It is passed inline on the command line
// and the URL is part of it: a script or endpoint file on disk could be
// rewritten by any agent running as the user to let everything through. Only
// the token is read from a file, and a rewritten token is refused by the server.
const hookScript = ({ url, tokenFile }: { url: string; tokenFile: string }) => `import { readFileSync } from 'node:fs'
const deny = (reason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
  process.exit(0)
}
let input = ''
for await (const chunk of process.stdin) input += chunk
try {
  const token = readFileSync(${JSON.stringify(tokenFile)}, 'utf8').trim()
  const headers = { 'content-type': 'application/json', ...(token ? { ${JSON.stringify(MCP_TOKEN_HEADER)}: token } : {}) }
  const response = await fetch(${JSON.stringify(url)}, { method: 'POST', headers, body: input })
  const result = JSON.parse((await response.text()).trim())
  if (!response.ok || result.allow !== true) deny(result.reason || 'The user did not allow this action.')
} catch (error) {
  deny('BusyBoy could not ask the user: ' + (error instanceof Error ? error.message : String(error)))
}
`

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** Printed by the shell when the hook script cannot run at all, so the tool call is blocked rather than let through. */
const CANNOT_RUN = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'BusyBoy could not ask the user: its always-ask hook could not run.',
  },
})

/**
 * Writes the hook's token and returns the hook's shell command. The command is
 * the same for every thread of this server, so Codex's trust hash for it stays
 * the same (see `trustedHookConfig`). The token lives in its own folder per
 * port, so two servers on one machine never answer each other's hooks, and is
 * written again before each thread. The server's own runtime runs the script:
 * in the desktop app that is Electron, run as plain Node.
 */
export async function hookCommand() {
  const port = process.env.PORT ?? '3000'
  const folder = join(resolveDataFolder(), `always-ask-${port}`)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const token = process.env[SERVER_TOKEN_ENV]
  // The token stays out of the command line, where process listings would show it.
  const tokenFile = join(folder, 'token')
  await writeFile(tokenFile, token ? alwaysAskTokenFor(token) : '', { mode: 0o600 })
  const script = hookScript({ url: `http://127.0.0.1:${port}${ALWAYS_ASK_PATH}`, tokenFile })
  // When the runtime or the script cannot start, `||` prints the denial instead.
  return `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} --input-type=module -e ${quote(script)} || printf '%s' ${quote(CANNOT_RUN)}`
}

/** A day: a hook that waits for the user must not time out into running the action. */
const HOOK_TIMEOUT_S = 24 * 60 * 60

type Request = <T>(method: string, params: unknown) => Promise<T>

type ListedHook = { key: string; command?: string; source?: string; currentHash: string; trustStatus?: string }

const trust = new Map<string, Promise<{ key: string; hash: string }>>()

/**
 * The thread config that adds the hook already trusted. Codex runs only hooks
 * the user trusted, by a hash of the hook that it does not document, so BusyBoy
 * reads the hash from `hooks/list` on an ephemeral thread with no turn (no model
 * call) and passes it as `hooks.state.<key>.trusted_hash`, which Codex accepts
 * from a thread's own config (verified with codex-cli 0.167.0). The hash is
 * read once per command.
 */
export async function trustedHookConfig({ request, cwd, executable }: { request: Request; cwd: string; executable: string }) {
  const hookCommandText = await hookCommand()
  // No matcher: the hook sees every tool call and the session decides, so a rule never depends on
  // Codex's matcher syntax or tool names agreeing with the list. Each call costs a short process start.
  const hooks = { PreToolUse: [{ matcher: null, hooks: [{ type: 'command', command: hookCommandText, timeout: HOOK_TIMEOUT_S }] }] }
  // Keyed by the executable too: another Codex version may hash differently.
  const cacheKey = `${executable}\n${hookCommandText}`
  let trusted = trust.get(cacheKey)
  if (!trusted) {
    trusted = (async () => {
      const probe = await request<{ thread: { id: string } }>('thread/start', {
        cwd,
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        config: { hooks },
      })
      const { data } = await request<{ data: { hooks: ListedHook[] }[] }>('hooks/list', { threadId: probe.thread.id })
      const listed = data.flatMap((entry) => entry.hooks).find((hook) => hook.source === 'sessionFlags' && hook.command === hookCommandText)
      if (!listed) {
        throw new Error('Codex did not load the always-ask hook, so it cannot ask before irreversible actions.')
      }
      return { key: listed.key, hash: listed.currentHash }
    })()
    trust.set(cacheKey, trusted)
    trusted.catch(() => trust.delete(cacheKey))
  }
  const { key, hash } = await trusted
  return {
    config: { hooks: { ...hooks, state: { [key]: { trusted_hash: hash } } } },
    /**
     * Checks that the started thread runs the hook as trusted. An untrusted hook is skipped
     * without an error, which would let every rule through, so the thread must not be used then.
     */
    verify: async (threadId: string) => {
      const { data } = await request<{ data: { hooks: ListedHook[] }[] }>('hooks/list', { threadId })
      const listed = data.flatMap((entry) => entry.hooks).find((hook) => hook.command === hookCommandText)
      if (listed?.trustStatus !== 'trusted') {
        trust.delete(cacheKey)
        throw new Error('Codex did not trust the always-ask hook, so it cannot ask before irreversible actions. Try again.')
      }
    },
  }
}
