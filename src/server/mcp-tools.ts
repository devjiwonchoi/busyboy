import { listProjects } from './projects'

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
]
