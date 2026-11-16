import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { MCP_TOOLS, McpToolError } from '@/server/mcp-tools'

// Busyboy's MCP endpoint (streamable HTTP, stateless, JSON responses only),
// served by the MCP SDK: it handles JSON-RPC, batches, `initialize` version
// negotiation, and `ping`; this file only lists and calls busyboy's tools.
// `proxy.ts` rejects requests without the MCP token, so only agents busyboy
// started can call it. Their MCP config carries that token, which is derived
// from the per-launch token and opens only this route (src/lib/server-token.ts);
// agents never get the per-launch token itself.
//
// The low-level `Server` rather than `McpServer`: McpServer answers a call to
// an unknown tool with a tool result, but a tool the caller may not use must
// fail as a JSON-RPC error, so an agent cannot mistake it for a tool's output.

/** A JSON-RPC error with exactly this message; McpError would prefix "MCP error <code>:". */
function rpcError(code: number, message: string) {
  return Object.assign(new Error(message), { code })
}

/** A new server per request: stateless, it keeps nothing between requests. */
function busyboyServer() {
  const server = new Server({ name: 'busyboy', version: '0.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    // Always loaded: Claude otherwise defers MCP tools behind tool search,
    // and the Director must see create_task from its first turn.
    tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
      _meta: { 'anthropic/alwaysLoad': true },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === params.name)
    if (!tool) throw rpcError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`)
    try {
      return { content: [{ type: 'text', text: await tool.run(params.arguments ?? {}) }] }
    } catch (error) {
      if (!(error instanceof McpToolError)) console.error(`busyboy MCP tool ${tool.name} failed`, error)
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
    }
  })
  return server
}

/**
 * `initialize` must carry the client's capabilities and info, which the SDK
 * checks. This server reads neither, so a minimal client (curl, the journeys)
 * that sends only a protocol version gets them filled in instead of an error.
 */
function withInitializeDefaults(message: unknown) {
  const request = message as { method?: unknown; params?: Record<string, unknown> } | null
  if (request?.method !== 'initialize' || typeof request.params !== 'object' || request.params === null) return message
  return { ...request, params: { capabilities: {}, clientInfo: { name: 'unknown', version: '0.0.0' }, ...request.params } }
}

/**
 * The request as the transport takes it. The transport refuses a POST whose
 * Accept header does not list both JSON and an event stream, as the spec asks
 * of clients; every answer here is JSON (`enableJsonResponse`), so a client
 * that sends no such header, like curl, gets the same JSON instead of a 406.
 * The body is parsed here only to fill in `initialize`; a body that is not
 * JSON goes to the transport as it came, which reports the parse error.
 */
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
  const server = busyboyServer()
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    // With JSON responses, this resolves once every response is ready.
    return await transport.handleRequest(request, { parsedBody })
  } finally {
    await server.close()
  }
}

// No server-initiated stream and no sessions, so only POST.
export function GET() {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
}

export function DELETE() {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
}
