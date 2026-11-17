import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  MCP_MANAGER_PARAM,
  MCP_TASK_PROJECT_PARAM,
  MCP_TOKEN_HEADER,
  managerMcpTokenFor,
  mcpTokenFor,
  SERVER_TOKEN_ENV,
  taskMcpTokenFor,
} from '@/lib/server-token'
import { listManagers } from '@/server/managers'
import { McpToolError, toolsFor, type McpCaller } from '@/server/mcp-tools'

// McpServer reports an unknown tool as a tool result, so a forbidden tool has to fail as a JSON-RPC error.
// Agents get a derived MCP token, never the server token.

/** A JSON-RPC error with exactly this message; McpError would prefix "MCP error <code>:". */
function rpcError(code: number, message: string) {
  return Object.assign(new Error(message), { code })
}

// Without a server token (tests, next dev) the URL is trusted, because every request is let in anyway.
async function callerOf(request: Request): Promise<McpCaller> {
  const params = new URL(request.url).searchParams
  const serverToken = process.env[SERVER_TOKEN_ENV]
  const provided = request.headers.get(MCP_TOKEN_HEADER)
  const project = params.get(MCP_TASK_PROJECT_PARAM)
  const id = params.get(MCP_MANAGER_PARAM)
  if (!serverToken) {
    if (project) return { kind: 'task', project }
    return id ? managerCaller(id) : { kind: 'director' }
  }
  // The proxy lets a manager token in for its manager parameter, so a project on the URL must not widen that.
  if (provided && project && provided === taskMcpTokenFor(serverToken, project)) return { kind: 'task', project }
  if (provided && id && provided === managerMcpTokenFor(serverToken, id)) return managerCaller(id)
  if (!provided || provided === mcpTokenFor(serverToken)) return { kind: 'director' }
  throw new RefusedCallerError('This token cannot be used here.')
}

async function managerCaller(id: string): Promise<McpCaller> {
  const manager = (await listManagers()).find((entry) => entry.id === id)
  if (!manager) throw new RefusedCallerError('This manager was removed.')
  return { kind: 'manager', manager: manager.id, project: manager.project }
}

class RefusedCallerError extends Error {}

function busyboyServer(caller: McpCaller) {
  const tools = toolsFor(caller)
  const server = new Server({ name: 'busyboy', version: '0.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    // Claude otherwise defers MCP tools behind tool search.
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
      _meta: { 'anthropic/alwaysLoad': true },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = tools.find((candidate) => candidate.name === params.name)
    if (!tool) throw rpcError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`)
    try {
      return { content: [{ type: 'text', text: await tool.run(params.arguments ?? {}, caller) }] }
    } catch (error) {
      if (!(error instanceof McpToolError)) console.error(`busyboy MCP tool ${tool.name} failed`, error)
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
    }
  })
  return server
}

// The SDK requires initialize to carry client capabilities this server never reads.
function withInitializeDefaults(message: unknown) {
  const request = message as { method?: unknown; params?: Record<string, unknown> } | null
  if (request?.method !== 'initialize' || typeof request.params !== 'object' || request.params === null) return message
  return { ...request, params: { capabilities: {}, clientInfo: { name: 'unknown', version: '0.0.0' }, ...request.params } }
}

// The MCP spec asks for an Accept header of both JSON and an event stream; curl sends neither.
async function forTransport(request: Request) {
  const headers = new Headers(request.headers)
  headers.set('accept', 'application/json, text/event-stream')
  const body = await request.text()
  let parsedBody: unknown
  try {
    const json = JSON.parse(body) as unknown
    parsedBody = Array.isArray(json) ? json.map(withInitializeDefaults) : withInitializeDefaults(json)
  } catch {}
  // A new plain Request: `new Request(request, ...)` fails on Next's request
  // subclass, whose private fields the base constructor cannot read.
  return { request: new Request(request.url, { method: request.method, headers, body }), parsedBody }
}

export async function POST(incoming: Request) {
  const { request, parsedBody } = await forTransport(incoming)
  let caller: McpCaller
  try {
    caller = await callerOf(incoming)
  } catch (error) {
    if (error instanceof RefusedCallerError) return new Response(error.message, { status: 403 })
    throw error
  }
  const server = busyboyServer(caller)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request, { parsedBody })
  } finally {
    await server.close()
  }
}

export function GET() {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
}

export function DELETE() {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
}
