import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { SERVER_TOKEN_COOKIE, SERVER_TOKEN_ENV, SERVER_TOKEN_HEADER } from "@/lib/server-token";
import { isSetupComplete, readSettings } from "@/server/config";

export async function proxy(request: NextRequest) {
  if (!isTrusted(request)) return new NextResponse(null, { status: 403 });
  // why: A redirect from the page would stream after the Cache Components shell, so it is sent before render.
  if (
    request.method === "GET" &&
    request.nextUrl.pathname === "/" &&
    !isSetupComplete(await readSettings())
  ) {
    return NextResponse.redirect(new URL("/setup", request.url));
  }
  return NextResponse.next();
}

function isTrusted(request: NextRequest) {
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  return isLoopbackHost(host) && (!origin || origin === `http://${host}`) && hasToken(request);
}

// why: Only loopback hosts are accepted, which blocks DNS rebinding.
function isLoopbackHost(host: string | null) {
  if (!URL.canParse(`http://${host}`)) return false;
  const url = new URL(`http://${host}`);
  const port = process.env.PORT;
  return (
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") && (!port || url.port === port)
  );
}

// why: Without a launch token only next dev is allowed. NODE_ENV is inlined at build time, so a production build fails closed.
function hasToken(request: NextRequest) {
  const expected = process.env[SERVER_TOKEN_ENV];
  if (!expected) return process.env.NODE_ENV === "development";
  const provided =
    request.cookies.get(SERVER_TOKEN_COOKIE)?.value ?? request.headers.get(SERVER_TOKEN_HEADER);
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
