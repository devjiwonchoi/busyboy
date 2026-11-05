// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Standalone Electron fixture without an Effect runtime.
// Electron main process for PreviewIsolation.journey.test.ts. It hosts a previewed page the way
// BusyBoy does (real <webview> preferences, attach hardening, guest preload and IPC sender
// policy), drives it like the agent tools and the element picker do, and prints the results.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { app, BrowserWindow, ipcMain, protocol, session, type WebContents } from "electron";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

import * as DesktopIpc from "../../ipc/DesktopIpc.ts";
import {
  ELEMENT_PICKED_CHANNEL,
  PASSKEY_GET_CHANNEL,
  PREVIEW_ELEMENT_CONTEXT_KEY,
  START_PICK_CHANNEL,
} from "../GuestProtocol.ts";
import { hardenPreviewWebPreferences, PREVIEW_WEBVIEW_PREFERENCES } from "../WebviewPreferences.ts";

interface JourneyConfig {
  readonly guestPreload: string;
  readonly hostPreload: string;
  readonly pageDir: string;
  readonly userData: string;
}

const config = JSON.parse(process.env["JOURNEY_CONFIG"] ?? "{}") as JourneyConfig;
const SECRET_CHANNEL = "journey.secret";
const PAGE_SCHEME = "journey-page";
const PREVIEW_PARTITION = "persist:busyboy-preview-journey";
const results: Record<string, unknown> = {};

app.setPath("userData", config.userData);
protocol.registerSchemesAsPrivileged([
  { scheme: "busyboy", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: PAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const startedAt = Date.now();
const finish = (error?: unknown) => {
  results["elapsedMs"] = Date.now() - startedAt;
  const message = error === undefined ? null : String((error as Error)?.stack ?? error);
  process.stdout.write(`JOURNEY_RESULT ${JSON.stringify({ results, error: message })}\n`);
  app.exit(0);
};

const delay = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

const withTimeout = <A>(promise: Promise<A>, label: string, millis = 20_000) =>
  Promise.race([
    promise,
    delay(millis).then(() => {
      throw new Error(`Timed out waiting for ${label}`);
    }),
  ]);

const waitUntil = async (check: () => Promise<boolean>, label: string) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const centerOf = (guest: WebContents, selector: string) =>
  guest.executeJavaScript(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
  ) as Promise<{ x: number; y: number }>;

const click = (guest: WebContents, point: { x: number; y: number }) => {
  guest.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
  guest.sendInputEvent({
    type: "mouseDown",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  guest.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
};

const invokeSecret = `window.journey.invoke(${JSON.stringify(SECRET_CHANNEL)}).then(
  (value) => ({ value }),
  (error) => ({ error: String(error && error.message) }),
)`;

async function run() {
  // The previewed page is served from its own origin. A custom protocol keeps the test off
  // Chromium's network service, which can restart on a busy machine.
  const servePage = (request: Request) => {
    const name = new URL(request.url).pathname.slice(1) || "index.html";
    const file = NodePath.join(config.pageDir, NodePath.basename(name));
    if (!NodeFS.existsSync(file)) return new Response(null, { status: 404 });
    return new Response(NodeFS.readFileSync(file), {
      headers: { "content-type": CONTENT_TYPES[NodePath.extname(file)] ?? "text/plain" },
    });
  };
  // The preview uses its own partition session; the web-page window uses the default one.
  protocol.handle(PAGE_SCHEME, servePage);
  session.fromPartition(PREVIEW_PARTITION).protocol.handle(PAGE_SCHEME, servePage);
  const guestUrl = `${PAGE_SCHEME}://site/`;

  // The app's real IPC layer and sender policy, guarding one privileged method.
  const ipc = DesktopIpc.make(ipcMain, DesktopIpc.appWindowSenderPolicy("busyboy://app/"));
  const scope = Effect.runSync(Scope.make());
  Effect.runSync(
    ipc
      .handle({ channel: SECRET_CHANNEL, handler: () => Effect.succeed("bearer-token") })
      .pipe(Effect.provideService(Scope.Scope, scope)),
  );

  const hostHtml = `<!doctype html><html><body style="margin:0">
    <webview id="guest" src="${guestUrl}" partition="${PREVIEW_PARTITION}"
      webpreferences="${PREVIEW_WEBVIEW_PREFERENCES}"
      preload="${NodeURL.pathToFileURL(config.guestPreload).href}"
      style="display:inline-flex;width:800px;height:600px"></webview>
  </body></html>`;
  protocol.handle(
    "busyboy",
    () => new Response(hostHtml, { headers: { "content-type": "text/html" } }),
  );

  const host = new BrowserWindow({
    show: false,
    width: 820,
    height: 640,
    webPreferences: {
      preload: config.hostPreload,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });
  host.webContents.on("will-attach-webview", (_event, webPreferences, params) => {
    hardenPreviewWebPreferences(webPreferences, {
      partition: params.partition ?? "",
      preloadPath: config.guestPreload,
      passkeyBridge: true,
    });
  });
  const guestLoaded = new Promise<WebContents>((resolve) => {
    host.webContents.on("did-attach-webview", (_event, guest) => {
      guest.once("did-finish-load", () => resolve(guest));
    });
  });
  await host.loadURL("busyboy://app/");
  const guest = await withTimeout(guestLoaded, "the previewed page to load");
  await waitUntil(
    async () => (await guest.executeJavaScript(`!!document.querySelector("button")`)) === true,
    "React to render",
  );

  // 1. The guest really runs isolated and sandboxed, and the page's own world has no Electron API, but has the two page-world helpers.
  // Present at runtime but missing from Electron's type declarations.
  const preferences = (
    guest as WebContents & { getLastWebPreferences(): Electron.WebPreferences | null }
  ).getLastWebPreferences();
  results["guestPreferences"] = {
    contextIsolation: preferences?.contextIsolation ?? null,
    sandbox: preferences?.sandbox ?? null,
    nodeIntegration: preferences?.nodeIntegration ?? null,
  };
  results["pageWorld"] = await guest.executeJavaScript(`({
    require: typeof require,
    process: typeof process,
    ipcRenderer: typeof ipcRenderer,
    passkeyShim: !String(CredentialsContainer.prototype.get).includes("[native code]"),
    elementContextHelper: typeof globalThis[Symbol.for(${JSON.stringify(PREVIEW_ELEMENT_CONTEXT_KEY)})],
  })`);

  // 2. preview_evaluate runs in the page.
  results["evaluate"] = await guest.executeJavaScript(`document.querySelector("h1").textContent`);

  // 3. preview_click sends real input events.
  click(guest, await centerOf(guest, "button"));
  await waitUntil(
    async () =>
      (await guest.executeJavaScript(`document.querySelector("button").textContent`)) ===
      "Count: 1",
    "the click to reach React",
  );
  results["click"] = await guest.executeJavaScript(`document.querySelector("button").textContent`);

  // 4. The element picker still returns React component context.
  const picked = new Promise<unknown>((resolve) => {
    guest.ipc.on(ELEMENT_PICKED_CHANNEL, (_event, annotation: unknown) => resolve(annotation));
  });
  guest.send(START_PICK_CHANNEL, undefined, false);
  await delay(300);
  click(guest, await centerOf(guest, "button"));
  await delay(500);
  guest.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  guest.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
  const annotation = (await withTimeout(picked, "the picked element")) as {
    elements?: ReadonlyArray<{ element?: { tagName?: string; componentName?: string | null } }>;
  } | null;
  const element = annotation?.elements?.[0]?.element;
  results["picked"] = {
    tagName: element?.tagName ?? null,
    componentName: element?.componentName ?? null,
  };

  // 5. A page's passkey request still crosses the bridge, binary challenge intact.
  let passkeyRequest: unknown = null;
  guest.ipc.handle(PASSKEY_GET_CHANNEL, (_event, publicKey: { challenge?: unknown }) => {
    const challenge = publicKey?.challenge;
    passkeyRequest = {
      challenge: ArrayBuffer.isView(challenge)
        ? [...new Uint8Array(challenge.buffer, challenge.byteOffset, challenge.byteLength)]
        : challenge instanceof ArrayBuffer
          ? [...new Uint8Array(challenge)]
          : null,
    };
    return { success: false, error: "NotAllowedError" };
  });
  const passkeyError = await guest.executeJavaScript(
    `navigator.credentials.get({ publicKey: { challenge: new Uint8Array([1, 2, 3]) } })
      .then(() => "resolved", (error) => error.name)`,
  );
  results["passkey"] = { request: passkeyRequest, pageSees: passkeyError };

  // 6. Privileged IPC answers the app window only.
  results["appWindowInvoke"] = await host.webContents.executeJavaScript(invokeSecret);
  const webWindow = new BrowserWindow({
    show: false,
    webPreferences: { preload: config.hostPreload, contextIsolation: true, sandbox: true },
  });
  await webWindow.loadURL("data:text/html,<p>A web page</p>");
  results["webWindowInvoke"] = await webWindow.webContents.executeJavaScript(invokeSecret);

  finish();
}

app.whenReady().then(run).catch(finish);
