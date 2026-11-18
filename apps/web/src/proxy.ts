import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import {
  SERVER_TOKEN_COOKIE,
  SERVER_TOKEN_ENV,
  SERVER_TOKEN_HEADER,
  TEST_MODE_ENV,
} from "@/lib/server-token";
import {
  isSetupComplete,
  readSettingsAt,
  resolveDataFolder,
  TEST_HOME_COOKIE,
} from "@/server/config";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

function sameToken(provided: string, expected: string) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function forbidden(reason: string) {
  return new NextResponse(`Forbidden: ${reason}`, { status: 403 });
}

// why: Only loopback hosts are accepted, which blocks DNS rebinding.
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

// why: Without a launch token, only next dev and test mode are allowed. Anything else fails closed.
export async function proxy(request: NextRequest) {
  const host = request.headers.get("host");
  if (!isAllowedHost(host)) return forbidden("host");

  const origin = request.headers.get("origin");
  if (origin && origin !== `http://${host}`) return forbidden("origin");

  const expected = process.env[SERVER_TOKEN_ENV];
  if (!expected) {
    // why: NODE_ENV is inlined at build time, so a production build cannot take the dev path.
    const open = process.env.NODE_ENV === "development" || process.env[TEST_MODE_ENV] === "1";
    if (!open) return forbidden("token");
  } else {
    const provided =
      request.cookies.get(SERVER_TOKEN_COOKIE)?.value ?? request.headers.get(SERVER_TOKEN_HEADER);
    if (!(provided && sameToken(provided, expected))) return forbidden("token");
  }
  return (await setupRedirect(request)) ?? NextResponse.next();
}

async function setupRedirect(request: NextRequest) {
  if (request.nextUrl.pathname !== "/" || request.method !== "GET") return undefined;
  const folder = resolveDataFolder(request.cookies.get(TEST_HOME_COOKIE)?.value);
  if (isSetupComplete(await readSettingsAt(folder))) return undefined;
  return NextResponse.redirect(new URL("/setup", request.url));
}
