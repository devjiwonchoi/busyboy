// @effect-diagnostics nodeBuiltinImport:off - a plain HTTP server stands in for the site.

import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";

import type { PreviewAutomationNetworkEntry } from "@t3tools/contracts";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeCredentialGuard, type CredentialGuard } from "./CredentialGuard.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

const SECRET = "Hunter2 Secret!";
// Every form the password could reach an agent in.
const LEAKS = [
  SECRET,
  encodeURIComponent(SECRET),
  encodeURIComponent(SECRET).replaceAll("%20", "+"),
  new URLSearchParams({ v: SECRET }).toString().slice(2),
  Buffer.from(SECRET).toString("base64"),
];

const LOGIN_PAGE = `<!doctype html><title>Sign in</title>
<form action="/welcome" method="get">
  <label>User <input name="user" value="ada"></label>
  <label>Password <input id="pw" name="pw" type="password"></label>
  <button type="button" id="reveal" onclick="pw.type = pw.type === 'password' ? 'text' : 'password'">Show password</button>
  <button id="submit">Sign in</button>
</form>
<script>
  pw.addEventListener("change", () => {
    console.log("password is " + pw.value);
    localStorage.setItem("pw", pw.value);
  });
</script>`;

describe("filled passwords stay out of agent tools", () => {
  let browser: Browser;
  let server: NodeHttp.Server;
  let origin: string;
  // Everything any page sent to the server, so a script's fetch would show up here.
  let received: Array<string>;
  let context: BrowserContext;
  let guard: CredentialGuard;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    server = NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push(`${request.url} ${body}`);
        response.setHeader("content-type", "text/html");
        if (request.url === "/login") response.end(LOGIN_PAGE);
        else response.end(`<!doctype html><title>Plain</title><p>No password here</p>`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
  });
  beforeEach(async () => {
    received = [];
    context = await browser.newContext();
    guard = makeCredentialGuard();
  });
  afterEach(async () => {
    await context.close();
  });

  /** A tab as the server browser sets one up, with the agent tools that read it. */
  const openTab = async (url: string) => {
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await guard.install({ page, cdp });
    const consoleEntries: Array<{ level: string; text: string; timestamp: string }> = [];
    const networkEntries: Array<PreviewAutomationNetworkEntry> = [];
    page.on("console", (message) =>
      consoleEntries.push({ level: message.type(), text: message.text(), timestamp: "" }),
    );
    page.on("response", (response) =>
      networkEntries.push({
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
        failed: false,
        timestamp: "",
      }),
    );
    await page.goto(url);
    const tab = { page, cdp };
    const agent = {
      tab,
      // Like the server's request handler: every answer and error passes the mask.
      evaluate: async (expression: string, siblings: ReadonlyArray<typeof tab> = []) => {
        try {
          await guard.assertMayEvaluate(tab, siblings);
          return guard.mask(await ServerBrowserPage.evaluate(page, cdp, { expression }, 5_000));
        } catch (cause) {
          throw new Error(guard.maskText((cause as Error).message));
        }
      },
      snapshot: async () =>
        guard.mask(
          await guard.snapshot(tab, (remembered) =>
            ServerBrowserPage.snapshot({
              page,
              cdp,
              renderScale: 1,
              consoleEntries,
              networkEntries,
              actionTimeline: [],
              remembered,
            }),
          ),
        ),
      status: () => guard.mask({ url: page.url(), title: "" }),
      type: (selector: string, text: string) =>
        ServerBrowserPage.type(page, { selector, text, clear: true }),
    };
    return agent;
  };

  /** The person types their password and moves on, as autofill or a keyboard would. */
  const personFills = async (page: Page) => {
    await page.fill("#pw", SECRET);
    await page.locator("#pw").blur();
  };

  const expectNoLeak = (output: unknown) => {
    const text = JSON.stringify(output);
    for (const leak of LEAKS) expect(text).not.toContain(JSON.stringify(leak).slice(1, -1));
  };

  it("refuses scripts on a sign-in page, before and after the person fills it", async () => {
    const agent = await openTab(`${origin}/login`);

    // A script planted before the fill could catch the typing, so none runs here.
    await expect(
      agent.evaluate(
        `document.addEventListener("input", (e) => fetch("/steal?" + e.target.value))`,
      ),
    ).rejects.toThrow(/password field/);

    await personFills(agent.tab.page);
    const attempts = [
      `document.querySelector("#pw").value`,
      `btoa(document.querySelector("#pw").value)`,
      `fetch("/steal", { method: "POST", body: document.querySelector("#pw").value }).then(() => "sent")`,
      `[...new FormData(document.forms[0])].map(([k, v]) => k + "=" + v).join("&")`,
      `(document.querySelector("#pw").type = "text", document.body.innerText)`,
      `(() => { const s = document.createElement("script"); s.textContent = 'fetch("/steal?" + pw.value)'; document.body.append(s); })()`,
    ];
    for (const expression of attempts) {
      const error = await agent.evaluate(expression).then(
        () => undefined,
        (cause: Error) => cause,
      );
      expect(error?.message).toMatch(/password field/);
      expectNoLeak(error?.message);
    }
    // Nothing reached the server but the page itself.
    expect(received.filter((line) => line.startsWith("/steal"))).toEqual([]);
    expect(await agent.tab.page.inputValue("#pw")).toBe(SECRET);
  });

  it("masks the password in snapshots, logs, and addresses, even when the page shows it", async () => {
    const agent = await openTab(`${origin}/login`);
    await personFills(agent.tab.page);

    const hidden = await agent.snapshot();
    expectNoLeak(hidden);
    // The page logged it on change; the console entry is masked.
    expect(hidden.consoleEntries.map((entry) => entry.text)).toContain(
      `password is ${ServerBrowserPage.MASKED_VALUE}`,
    );
    expect(hidden.screenshot.width).toBeGreaterThan(1);

    // "Show password" turns the field into plain text, and the screenshot would show it.
    await agent.tab.page.click("#reveal");
    const shown = await agent.snapshot();
    expectNoLeak(shown);
    expect(shown.screenshot.width).toBe(1);
    expect(shown.visibleText).toContain("Screenshot hidden");
    // Recording frames are dropped while it shows, and kept again once hidden.
    expect(await guard.mayShowFrame(agent.tab)).toBe(false);
    await agent.tab.page.click("#reveal");
    expect(await guard.mayShowFrame(agent.tab)).toBe(true);

    // Signing in sends the password in the address, which the network log and status show.
    await Promise.all([agent.tab.page.waitForURL(/welcome/), agent.tab.page.click("#submit")]);
    expect(agent.tab.page.url()).toContain(new URLSearchParams({ v: SECRET }).toString().slice(2));
    expectNoLeak(agent.status());
    expectNoLeak(await agent.snapshot());
  });

  it("keeps scripts off the site after the fill, in this tab and others", async () => {
    const agent = await openTab(`${origin}/login`);
    // The person signs in before any agent tool looks at the page.
    await personFills(agent.tab.page);
    await Promise.all([agent.tab.page.waitForURL(/welcome/), agent.tab.page.click("#submit")]);

    // No password field here, but the page saved it in storage.
    await expect(agent.evaluate(`localStorage.getItem("pw")`)).rejects.toThrow(
      /a password was filled there/,
    );
    const other = await openTab(`${origin}/plain`);
    await expect(other.evaluate(`localStorage.getItem("pw")`, [agent.tab])).rejects.toThrow(
      /a password was filled there/,
    );
    // A different site can't reach that storage, so scripts still run there.
    const elsewhere = await openTab(origin.replace("localhost", "127.0.0.1") + "/plain");
    expect(await elsewhere.evaluate(`document.title`, [agent.tab])).toBe("Plain");
    expect(received.filter((line) => line.startsWith("/steal"))).toEqual([]);
  });

  it("leaves typing a password to the person", async () => {
    const agent = await openTab(`${origin}/login`);
    await expect(agent.type("#pw", "agent-guess")).rejects.toThrow(/preview_sign_in/);
    await expect(agent.evaluate(`document.title`)).rejects.toThrow(/password field/);
  });

  it("runs scripts as before on pages without passwords", async () => {
    const agent = await openTab(`${origin}/plain`);
    expect(await agent.evaluate(`document.title`)).toBe("Plain");
    // The fill watcher's channel lives in its own world, out of the page's reach.
    expect(await agent.evaluate(`typeof __t3CredentialFill`)).toBe("undefined");
    expect((await agent.snapshot()).screenshot.width).toBeGreaterThan(1);
  });
});
