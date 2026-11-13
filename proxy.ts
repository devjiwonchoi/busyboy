import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { SERVER_TOKEN_COOKIE, SERVER_TOKEN_ENV, SERVER_TOKEN_HEADER, TEST_MODE_ENV } from '@/lib/server-token'

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
 * and `pnpm start`).
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
export function proxy(request: NextRequest) {
  const host = request.headers.get('host')
  if (!isAllowedHost(host)) return forbidden('host')

  const origin = request.headers.get('origin')
  if (origin && origin !== `http://${host}`) return forbidden('origin')

  const expected = process.env[SERVER_TOKEN_ENV]
  if (!expected) {
    const open = process.env.NODE_ENV === 'development' || process.env[TEST_MODE_ENV] === '1'
    return open ? NextResponse.next() : forbidden('token')
  }
  const provided = request.cookies.get(SERVER_TOKEN_COOKIE)?.value ?? request.headers.get(SERVER_TOKEN_HEADER)
  if (provided && sameToken(provided, expected)) return NextResponse.next()
  return forbidden('token')
}
