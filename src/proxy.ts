import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import {
  MCP_PATH,
  MCP_TOKEN_HEADER,
  mcpTokenFor,
  SERVER_TOKEN_COOKIE,
  SERVER_TOKEN_ENV,
  SERVER_TOKEN_HEADER,
  TEST_MODE_ENV,
} from '@/lib/server-token'
import { isSetupComplete, readSettingsAt, resolveDataFolder, TEST_HOME_COOKIE } from '@/server/config'

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost'])

function sameToken(provided: string, expected: string) {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function forbidden(reason: string) {
  return new NextResponse(`Forbidden: ${reason}`, { status: 403 })
}

/**
 * Only `127.0.0.1:<port>` and `localhost:<port>` are accepted, which blocks DNS
 * rebinding and requests that reach the server through another interface.
 * The port is checked when the server knows it (`PORT`, set by the desktop app
 * and `pnpm start`). `pnpm dev` and `pnpm start` also bind to 127.0.0.1, so
 * other machines cannot connect at all.
 */
function isAllowedHost(host: string | null) {
  if (!host) return false
  let url: URL
  try {
    url = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return false
  const port = process.env.PORT
  return !port || url.port === port
}

/**
 * Guards every route. The desktop app starts the server with a per-launch
 * token and gives its window a matching cookie, so other local processes
 * cannot use the server. Without a token, requests are allowed only in
 * `next dev` and in test mode; otherwise the server fails closed.
 */
export async function proxy(request: NextRequest) {
  const host = request.headers.get('host')
  if (!isAllowedHost(host)) return forbidden('host')

  const origin = request.headers.get('origin')
  if (origin && origin !== `http://${host}`) return forbidden('origin')

  const expected = process.env[SERVER_TOKEN_ENV]
  if (!expected) {
    // Only the desktop app sets a token. `next dev` and the Playwright journeys run
    // without one; NODE_ENV is inlined at build time, so a production build can
    // never take the development path, and BUSYBOY_TEST_MODE is set only by tests.
    const open = process.env.NODE_ENV === 'development' || process.env[TEST_MODE_ENV] === '1'
    if (!open) return forbidden('token')
  } else {
    const provided = request.cookies.get(SERVER_TOKEN_COOKIE)?.value ?? request.headers.get(SERVER_TOKEN_HEADER)
    if (!(provided && sameToken(provided, expected)) && !hasMcpToken(request, expected)) return forbidden('token')
  }
  return (await setupRedirect(request)) ?? NextResponse.next()
}

/** Agents reach only the MCP endpoint, with a token derived from the server token. */
function hasMcpToken(request: NextRequest, serverToken: string) {
  if (request.nextUrl.pathname !== MCP_PATH) return false
  const provided = request.headers.get(MCP_TOKEN_HEADER)
  return Boolean(provided && sameToken(provided, mcpTokenFor(serverToken)))
}

// Opening the main screen goes to setup until setup is complete.
async function setupRedirect(request: NextRequest) {
  if (request.nextUrl.pathname !== '/' || request.method !== 'GET') return undefined
  const folder = resolveDataFolder(request.cookies.get(TEST_HOME_COOKIE)?.value)
  if (isSetupComplete(await readSettingsAt(folder))) return undefined
  return NextResponse.redirect(new URL('/setup', request.url))
}
