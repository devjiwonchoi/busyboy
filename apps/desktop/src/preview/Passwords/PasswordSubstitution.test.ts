// @effect-diagnostics nodeBuiltinImport:off - Decodes the bodies CDP carries as base64.
// @effect-diagnostics globalTimers:off - Lets the fake debugger's promise callbacks settle.
import { describe, expect, it } from "@effect/vitest";
import { Buffer } from "node:buffer";

import { armSubstitution, makeStandIn, substitutedBody } from "./PasswordSubstitution.ts";

const password = 'p@ss "word" 1';
const standIn = makeStandIn(password);
const pageOrigin = "https://example.com";
const decoded = (base64: string | null) =>
  base64 === null ? null : Buffer.from(base64, "base64").toString("utf8");

/** A debugger that records the commands sent to it. */
const fakeDebugger = () => {
  const sent: Array<{ readonly method: string; readonly params?: unknown }> = [];
  return {
    sent,
    debuggee: {
      sendCommand: async (method: string, params?: unknown) => {
        sent.push({ method, params });
        return {};
      },
    } as unknown as Electron.Debugger,
  };
};

const paused = (requestId: string, body: string, url = `${pageOrigin}/session`) => ({
  requestId,
  request: {
    url,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    postData: body,
  },
});

describe("PasswordSubstitution", () => {
  it("makes a stand-in that reads the same in a URL, a form and JSON", () => {
    expect(standIn).toMatch(/^[A-Za-z0-9]{16,}$/);
    expect(encodeURIComponent(standIn)).toBe(standIn);
    expect(JSON.stringify(standIn)).toBe(`"${standIn}"`);
    expect(makeStandIn(password)).not.toBe(standIn);
  });

  it("writes the password into a form or JSON body bound for the page's origin", () => {
    expect(
      decoded(
        substitutedBody({
          request: paused("1", `user=octo&pw=${standIn}`).request,
          standIn,
          password,
          pageOrigin,
        }),
      ),
    ).toBe(`user=octo&pw=${encodeURIComponent(password).replace(/%20/g, "+")}`);
    expect(
      decoded(
        substitutedBody({
          request: {
            url: `${pageOrigin}/api/login`,
            method: "POST",
            headers: { "content-type": "application/json" },
            postDataEntries: [
              { bytes: Buffer.from(`{"password":"${standIn}"}`).toString("base64") },
            ],
          },
          standIn,
          password,
          pageOrigin,
        }),
      ),
    ).toBe(JSON.stringify({ password }));
  });

  it("never writes the password anywhere else", () => {
    const attempt = (request: Parameters<typeof substitutedBody>[0]["request"]) =>
      substitutedBody({ request, standIn, password, pageOrigin });
    // Another origin, even on the same site.
    expect(attempt(paused("1", `pw=${standIn}`, "https://login.example.com/").request)).toBe(null);
    // A URL, which could be echoed back or logged.
    expect(attempt({ url: `${pageOrigin}/search?q=${standIn}`, method: "GET" })).toBe(null);
    // A body without the stand-in.
    expect(attempt(paused("1", "pw=typed-by-hand").request)).toBe(null);
  });

  it("swaps once, answers every paused request, then turns interception off", async () => {
    const { sent, debuggee } = fakeDebugger();
    const substitution = armSubstitution({
      debuggee,
      standIn,
      password,
      pageOrigin,
      keepInterceptingMs: 0,
    });
    await substitution.ready;
    expect(sent[0]).toEqual({
      method: "Fetch.enable",
      params: { patterns: [{ urlPattern: `${pageOrigin}/*`, requestStage: "Request" }] },
    });

    expect(substitution.onDebuggerMessage("Fetch.requestPaused", paused("a", "x=1"))).toBe(true);
    substitution.onDebuggerMessage("Fetch.requestPaused", paused("b", `pw=${standIn}`));
    // A second request with the stand-in, say to an endpoint that echoes it, gets the stand-in.
    substitution.onDebuggerMessage("Fetch.requestPaused", paused("c", `comment=${standIn}`));
    expect(await substitution.done).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const continued = sent.filter((command) => command.method === "Fetch.continueRequest");
    expect(continued.map((command) => command.params)).toEqual([
      { requestId: "a" },
      { requestId: "b", postData: expect.any(String) },
      { requestId: "c" },
    ]);
    expect(sent.at(-1)?.method).toBe("Fetch.disable");
    // Once off, other debugger events go back to the agent.
    expect(substitution.onDebuggerMessage("Fetch.requestPaused", paused("d", "x=1"))).toBe(false);
    expect(substitution.onDebuggerMessage("Network.requestWillBeSent", {})).toBe(false);
  });

  it("turns interception off when the sign-in gives up", async () => {
    const { sent, debuggee } = fakeDebugger();
    const substitution = armSubstitution({ debuggee, standIn, password, pageOrigin });
    await substitution.ready;
    substitution.cancel();

    expect(await substitution.done).toBe(false);
    expect(sent.map((command) => command.method)).toEqual(["Fetch.enable", "Fetch.disable"]);
  });
});
