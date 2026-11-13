import { headers } from 'next/headers'
import { MCP_PATH, MCP_TOKEN_HEADER, mcpTokenFor, SERVER_TOKEN_ENV } from '@/lib/server-token'
import { dataFolder, isTestMode, TEST_HOME_COOKIE } from './config'
import { attachTaskToMaster } from './master-chat'
import { listProjects } from './projects'
import type { McpServerInput } from './runner/contract'
import { createTask, TaskError } from './tasks'

// The tools busyboy offers its agents over MCP (app/api/mcp/route.ts). Every
// call runs inside that request, so `dataFolder()` and the providers resolve
// exactly as they do for the window.

export const MCP_SERVER_NAME = 'busyboy'

type JsonSchema = { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] }

export type McpTool = {
  name: string
  description: string
  inputSchema: JsonSchema
  run: (input: Record<string, unknown>) => Promise<string>
}

export class McpToolError extends Error {}

function text(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (typeof value !== 'string' || !value.trim()) throw new McpToolError(`\`${key}\` must be a non-empty string.`)
  return value
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'list_projects',
    description: 'List the projects busyboy can create tasks in, with the folder of each.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    async run() {
      const projects = await listProjects()
      if (projects.length === 0) return 'There are no projects yet. The user adds them in Setup.'
      return JSON.stringify(projects.map(({ name, path }) => ({ name, path })))
    },
  },
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
    async run(input) {
      try {
        const task = await createTask({ project: text(input, 'project'), title: text(input, 'title'), request: text(input, 'request') })
        await attachTaskToMaster(await dataFolder(), task)
        return `Created task ${task.id} in ${task.project} on branch ${task.branch}. Its agent is planning the work now.`
      } catch (error) {
        if (error instanceof TaskError) throw new McpToolError(error.message)
        throw error
      }
    },
  },
]

/**
 * How an agent reaches busyboy's MCP endpoint from the current request: the
 * server's own address, the MCP token (never the server token), and in test
 * mode the data folder cookie.
 */
export async function busyboyMcpServer(): Promise<McpServerInput> {
  const requestHeaders = await headers()
  const host = requestHeaders.get('host') ?? `127.0.0.1:${process.env.PORT ?? 3000}`
  const mcpHeaders: Record<string, string> = {}
  const token = process.env[SERVER_TOKEN_ENV]
  if (token) mcpHeaders[MCP_TOKEN_HEADER] = mcpTokenFor(token)
  if (isTestMode()) mcpHeaders.cookie = `${TEST_HOME_COOKIE}=${encodeURIComponent(await dataFolder())}`
  return { name: MCP_SERVER_NAME, url: `http://${host}${MCP_PATH}`, headers: mcpHeaders }
}
