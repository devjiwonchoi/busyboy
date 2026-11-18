import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { SERVER_TOKEN_COOKIE, SERVER_TOKEN_ENV, SERVER_TOKEN_HEADER } from "@/lib/server-token";
import { isSetupComplete, readSettingsAt, resolveDataFolder } from "@/server/config";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

function sameToken(provided: string, expected: string) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function forbidden(reason: string) {
  return new NextResponse(`Forbidden: ${reason}`, { status: 403 });
}

function isAllowedHost(host: string | null) {
  if (!host) return false;
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return false;
  const port = process.env.PORT;
  return !port || url.port === port;
}

export async function proxy(request: NextRequest) {
  const host = request.headers.get("host");
  if (!isAllowedHost(host)) return forbidden("host");

  const origin = request.headers.get("origin");
  if (origin && origin !== `http://${host}`) return forbidden("origin");

  const expected = process.env[SERVER_TOKEN_ENV];
  if (!expected) {
    if (process.env.NODE_ENV !== "development") return forbidden("token");
  } else {
    const provided =
      request.cookies.get(SERVER_TOKEN_COOKIE)?.value ?? request.headers.get(SERVER_TOKEN_HEADER);
    if (!(provided && sameToken(provided, expected))) return forbidden("token");
  }
  return (await setupRedirect(request)) ?? NextResponse.next();
}

async function setupRedirect(request: NextRequest) {
  if (request.nextUrl.pathname !== "/" || request.method !== "GET") return undefined;
  const folder = resolveDataFolder();
  if (isSetupComplete(await readSettingsAt(folder))) return undefined;
  return NextResponse.redirect(new URL("/setup", request.url));
}
