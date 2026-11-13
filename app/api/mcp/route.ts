import { MCP_TOOLS, McpToolError } from '@/server/mcp-tools'

// Busyboy's MCP endpoint (streamable HTTP, stateless, JSON responses only).
// `proxy.ts` rejects requests without the per-launch token, so only agents
// busyboy started (which get the token in their MCP config) can call it.

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

type JsonRpcRequest = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> }
type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } }

const failure = (id: JsonRpcResponse['id'], code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
})

async function handle(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
  if (typeof request !== 'object' || request === null || Array.isArray(request) || typeof request.method !== 'string') {
    return failure(null, -32600, 'Invalid Request')
  }
  // Notifications (no id) get no response.
  if (request.id === undefined) return undefined
  const { id } = request
  switch (request.method) {
    case 'initialize': {
      const requested = request.params?.protocolVersion
      const protocolVersion =
        typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0]
      return {
        jsonrpc: '2.0',
        id,
        result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'busyboy', version: '0.0.0' } },
      }
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) },
      }
    case 'tools/call': {
      const name = request.params?.name
      const tool = MCP_TOOLS.find((candidate) => candidate.name === name)
      if (!tool) return failure(id, -32602, `Unknown tool: ${String(name)}`)
      const input = (request.params?.arguments ?? {}) as Record<string, unknown>
      try {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: await tool.run(input) }] } }
      } catch (error) {
        if (!(error instanceof McpToolError)) console.error(`busyboy MCP tool ${tool.name} failed`, error)
        const message = error instanceof Error ? error.message : String(error)
        return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: message }] } }
      }
    }
    default:
      return failure(id, -32601, `Method not found: ${request.method}`)
  }
}

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json(failure(null, -32700, 'Parse error'), { status: 400 })
  }
  const batch = Array.isArray(body)
  const messages = (batch ? body : [body]) as JsonRpcRequest[]
  if (messages.length === 0) return Response.json(failure(null, -32600, 'Invalid Request'), { status: 400 })
  const responses = (await Promise.all(messages.map(handle))).filter((response) => response !== undefined)
  if (responses.length === 0) return new Response(null, { status: 202 })
  return Response.json(batch ? responses : responses[0])
}

// No server-initiated stream and no sessions.
export function GET() {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
}

export function DELETE() {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } })
}
