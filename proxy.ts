import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { SERVER_TOKEN_COOKIE, SERVER_TOKEN_ENV, SERVER_TOKEN_HEADER } from '@/lib/server-token'

function sameToken(provided: string, expected: string) {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// The desktop app starts the server with a per-launch token and gives the
// window a matching cookie, so other local processes cannot use the server.
// Without BUSYBOY_TOKEN (next dev, tests) every request is allowed.
export function proxy(request: NextRequest) {
  const expected = process.env[SERVER_TOKEN_ENV]
  if (!expected) return NextResponse.next()
  const provided = request.cookies.get(SERVER_TOKEN_COOKIE)?.value ?? request.headers.get(SERVER_TOKEN_HEADER)
  if (provided && sameToken(provided, expected)) return NextResponse.next()
  return new NextResponse('Forbidden', { status: 403 })
}
