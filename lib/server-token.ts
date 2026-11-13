import { createHmac } from 'node:crypto'

/** Cookie that carries the per-launch server token from the desktop window. */
export const SERVER_TOKEN_COOKIE = 'busyboy-token'

/** Header that carries the token for requests made outside the window. */
export const SERVER_TOKEN_HEADER = 'x-busyboy-token'

/** Environment variable that hands the token to the server process. */
export const SERVER_TOKEN_ENV = 'BUSYBOY_TOKEN'

/** Header that carries the MCP token, which opens only busyboy's MCP endpoint. */
export const MCP_TOKEN_HEADER = 'x-busyboy-mcp-token'

/** Busyboy's MCP endpoint, the one route the MCP token opens. */
export const MCP_PATH = '/api/mcp'

/**
 * The token agents get for the MCP endpoint, derived from the server token.
 * Agents never get the server token itself, which opens every route
 * (actions, agent streams, answers to their own approvals).
 */
export function mcpTokenFor(serverToken: string) {
  return createHmac('sha256', serverToken).update('busyboy-mcp-endpoint').digest('hex')
}
