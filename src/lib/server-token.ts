import { createHmac } from 'node:crypto'

/** Cookie that carries the per-launch server token from the desktop window. */
export const SERVER_TOKEN_COOKIE = 'busyboy-token'

/** Header that carries the token for requests made outside the window. */
export const SERVER_TOKEN_HEADER = 'x-busyboy-token'

/** Environment variable that hands the token to the server process. */
export const SERVER_TOKEN_ENV = 'BUSYBOY_TOKEN'

/** Set to `1` by the Playwright journeys so the server runs without a token. */
export const TEST_MODE_ENV = 'BUSYBOY_TEST_MODE'

/** Header that carries the MCP token, which opens only busyboy's MCP endpoint, or the always-ask token, which opens only ALWAYS_ASK_PATH. */
export const MCP_TOKEN_HEADER = 'x-busyboy-mcp-token'

/** Busyboy's MCP endpoint. */
export const MCP_PATH = '/api/mcp'

/** Where Codex's always-ask hook asks this server about a tool call (server/runner/codex-always-ask.ts). */
export const ALWAYS_ASK_PATH = '/api/always-ask'

/**
 * The token agents get for the MCP endpoint, derived from the server token.
 * Agents never get the server token itself, which opens every route
 * (actions, agent streams, answers to their own approvals).
 */
export function mcpTokenFor(serverToken: string) {
  return createHmac('sha256', serverToken).update('busyboy-mcp-endpoint').digest('hex')
}

/** Query parameter that names a task agent's project on the MCP endpoint URL. */
export const MCP_TASK_PROJECT_PARAM = 'project'

/**
 * A task agent's MCP token, bound to its project. With it the endpoint lists
 * only the memory tools and keeps the agent's memory writes in its own
 * project, so content a task agent reads cannot reach every later prompt.
 */
export function taskMcpTokenFor(serverToken: string, project: string) {
  return createHmac('sha256', serverToken).update(`busyboy-mcp-task:${project}`).digest('hex')
}

/**
 * The token Codex's always-ask hook sends, derived from the server token. It
 * opens only ALWAYS_ASK_PATH, never the MCP endpoint: the hook reads it from a
 * file any task agent could also read, and a task agent's MCP access stays
 * bound to its project. Holding it only lets a caller ask the user about a tool
 * call of a session BusyBoy runs.
 */
export function alwaysAskTokenFor(serverToken: string) {
  return createHmac('sha256', serverToken).update('busyboy-always-ask').digest('hex')
}
