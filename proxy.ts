import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { SERVER_TOKEN_COOKIE, SERVER_TOKEN_ENV, SERVER_TOKEN_HEADER } from '@/lib/server-token'
import { isSetupComplete, readSettingsAt, resolveDataFolder, TEST_HOME_COOKIE } from '@/server/config'

function sameToken(provided: string, expected: string) {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// The desktop app starts the server with a per-launch token and gives the
// window a matching cookie, so other local processes cannot use the server.
// Without BUSYBOY_TOKEN (next dev, tests) every request is allowed.
export async function proxy(request: NextRequest) {
  const expected = process.env[SERVER_TOKEN_ENV]
  if (expected) {
    const provided = request.cookies.get(SERVER_TOKEN_COOKIE)?.value ?? request.headers.get(SERVER_TOKEN_HEADER)
    if (!provided || !sameToken(provided, expected)) return new NextResponse('Forbidden', { status: 403 })
  }
  return (await setupRedirect(request)) ?? NextResponse.next()
}

// Opening the main screen goes to setup until setup is complete.
async function setupRedirect(request: NextRequest) {
  if (request.nextUrl.pathname !== '/' || request.method !== 'GET') return undefined
  const folder = resolveDataFolder(request.cookies.get(TEST_HOME_COOKIE)?.value)
  if (isSetupComplete(await readSettingsAt(folder))) return undefined
  return NextResponse.redirect(new URL('/setup', request.url))
}
