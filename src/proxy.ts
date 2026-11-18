import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import {
  MCP_MANAGER_PARAM,
  MCP_PATH,
  MCP_TASK_PROJECT_PARAM,
  MCP_TOKEN_HEADER,
  managerMcpTokenFor,
  mcpTokenFor,
  taskMcpTokenFor,
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
    if (!(provided && sameToken(provided, expected)) && !hasMcpToken(request, expected))
      return forbidden("token");
  }
  return (await setupRedirect(request)) ?? NextResponse.next();
}

// why: The MCP token is derived from the server token and opens only the MCP route.
function hasMcpToken(request: NextRequest, serverToken: string) {
  if (request.nextUrl.pathname !== MCP_PATH) return false;
  const provided = request.headers.get(MCP_TOKEN_HEADER);
  if (!provided) return false;
  if (sameToken(provided, mcpTokenFor(serverToken))) return true;
  const project = request.nextUrl.searchParams.get(MCP_TASK_PROJECT_PARAM);
  if (project && sameToken(provided, taskMcpTokenFor(serverToken, project))) return true;
  const manager = request.nextUrl.searchParams.get(MCP_MANAGER_PARAM);
  return Boolean(manager && sameToken(provided, managerMcpTokenFor(serverToken, manager)));
}

async function setupRedirect(request: NextRequest) {
  if (
    (request.nextUrl.pathname !== "/" && request.nextUrl.pathname !== "/settings") ||
    request.method !== "GET"
  )
    return undefined;
  const folder = resolveDataFolder(request.cookies.get(TEST_HOME_COOKIE)?.value);
  if (isSetupComplete(await readSettingsAt(folder))) return undefined;
  return NextResponse.redirect(new URL("/setup", request.url));
}
