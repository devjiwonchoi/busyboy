import { timingSafeEqual } from "node:crypto";

import { cookies, headers } from "next/headers";
import { forbidden } from "next/navigation";

import { SERVER_TOKEN_COOKIE, SERVER_TOKEN_ENV, SERVER_TOKEN_HEADER } from "@/lib/server-token";

export async function requireTrustedRequest() {
  const [requestHeaders, requestCookies] = await Promise.all([headers(), cookies()]);
  const host = requestHeaders.get("host");
  const origin = requestHeaders.get("origin");
  const token =
    requestCookies.get(SERVER_TOKEN_COOKIE)?.value ?? requestHeaders.get(SERVER_TOKEN_HEADER);
  if (!isLoopbackHost(host) || (origin && origin !== `http://${host}`) || !isLaunchToken(token)) {
    forbidden();
  }
}

function isLoopbackHost(host: string | null) {
  if (!URL.canParse(`http://${host}`)) return false;
  const url = new URL(`http://${host}`);
  const port = process.env.PORT;
  return (
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") && (!port || url.port === port)
  );
}

function isLaunchToken(provided: string | null) {
  const expected = process.env[SERVER_TOKEN_ENV];
  if (!expected) return process.env.NODE_ENV === "development";
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
