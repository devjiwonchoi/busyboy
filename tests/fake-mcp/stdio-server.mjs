// A local MCP server on stdio. The connector probe speaks newline-delimited JSON
// to this process and reads the initialize result the SDK writes back.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new Server({ name: 'local', version: '0.0.0' }, { capabilities: {} })
await server.connect(new StdioServerTransport())
