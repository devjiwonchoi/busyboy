import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";

import {
  delay,
  errorText,
  evidencePath,
  cmdline,
  descendantPids,
  executableOf,
  readBuildId,
  readGitSha,
  removeOwnedData,
  repoRoot,
  stopProcess,
  writeSession,
  type Session,
  type Surface,
} from "./verify-session.mts";

const root = repoRoot();
const DRIVE_TIMEOUT = 20_000;
const READY_TIMEOUT = 45_000;

const runtime: {
  session: Session | null;
  server: ChildProcess | null;
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
  display: ChildProcess | null;
  stopping: boolean;
} = {
  session: null,
  server: null,
  browser: null,
  context: null,
  page: null,
  display: null,
  stopping: false,
};

function log(line: string) {
  const session = runtime.session;
  if (!session) return;
  appendFileSync(join(session.logDir, "supervisor.log"), `${line}\n`);
}

function tail(file: string) {
  try {
    return readFileSync(file, "utf8").slice(-2_000);
  } catch {
    return "";
  }
}

function flag(argv: string[], name: string) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function seedData(folder: string) {
  mkdirSync(folder, { recursive: true });
  const projects = ["web", "api"].map((name) => {
    const project = join(folder, "projects", name);
    mkdirSync(project, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(project, "README.md"), `# ${name}\n`);
    git("add", ".");
    git(
      "-c",
      "user.name=BusyBoy Verify",
      "-c",
      "user.email=verify@example.com",
      "commit",
      "-q",
      "-m",
      "Initial commit",
    );
    return { name, path: project, addedAt: new Date(0).toISOString() };
  });
  const settings = {
    version: 1,
    setupCompletedAt: new Date(0).toISOString(),
    defaultProvider: "claude",
    theme: "dark",
    companion: null,
    companionImage: null,
    projects,
    managers: [],
    alwaysAsk: null,
  };
  writeFileSync(join(folder, "app-settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  writeFileSync(
    join(folder, "verify.json"),
    `${JSON.stringify({ purpose: "busyboy-verify", pid: process.pid }, null, 2)}\n`,
  );
}

function freePort() {
  return new Promise<number>((resolvePort, reject) => {
    const probe = createTcpServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") resolvePort(address.port);
        else reject(new Error("Could not reserve a port."));
      });
    });
  });
}

function serverEnv(session: Session) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BUSYBOY_TOKEN;
  Object.assign(env, {
    BUSYBOY_VERIFY_ID: session.verifyId,
    PORT: String(session.port),
    HOSTNAME: "127.0.0.1",
    BUSYBOY_TEST_MODE: "1",
    BUSYBOY_TEST_SHELL:
      process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh",
    BUSYBOY_PROVIDER_SCRIPTS: join(root, "tests/provider-scripts"),
    BUSYBOY_HOME: session.dataDir,
    CLAUDE_CONFIG_DIR: join(session.dataDir, "claude-config"),
    CODEX_HOME: join(session.dataDir, "codex-home"),
    BUSYBOY_GH_PATH: join(root, "tests/fake-gh/gh"),
    BUSYBOY_DIRECTOR_BATCH_MS: "2000",
    BUSYBOY_DIRECTOR_IDLE_COMPACT_MS: "1500",
    BUSYBOY_DIRECTOR_COMPACT_CHARS: "1000",
    NEXT_TELEMETRY_DISABLED: "1",
  });
  return env;
}

async function waitForHttp(url: string, child: ChildProcess, logFile: string) {
  const deadline = Date.now() + READY_TIMEOUT;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`The app process exited before it was ready.\n${tail(logFile)}`);
    }
    let status = 0;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      if (response.ok || response.status === 403) status = response.status;
    } catch {
      status = 0;
    }
    if (status) return status;
    await delay(100);
  }
  throw new Error(
    `The app did not accept connections within ${READY_TIMEOUT} ms.\n${tail(logFile)}`,
  );
}

function watch(page: Page, logFile: string) {
  appendFileSync(logFile, "");
  page.on("console", (message) => {
    appendFileSync(logFile, `[${message.type()}] ${message.text()}\n`);
  });
  page.on("pageerror", (error) => {
    appendFileSync(logFile, `[pageerror] ${error.message}\n`);
  });
}

async function screenState(page: Page) {
  const url = page.url();
  const title = await page.title().catch(() => "");
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    return { url, title, screen: "unknown", ready: false };
  }
  if (pathname.startsWith("/settings")) {
    return {
      url,
      title,
      screen: "settings",
      ready: await page.getByRole("main", { name: "Settings" }).isVisible(),
    };
  }
  if (pathname.startsWith("/setup")) {
    return {
      url,
      title,
      screen: "setup",
      ready: await page.getByRole("main", { name: "Setup" }).isVisible(),
    };
  }
  const transcript = page.getByRole("log", { name: "Transcript" });
  const connected =
    (await transcript.count()) > 0 && (await transcript.getAttribute("data-connected")) === "true";
  const message = await page.getByRole("textbox", { name: "Message" }).isVisible();
  return { url, title, screen: "chat", ready: connected && message };
}

async function waitUntilUsable(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: READY_TIMEOUT });
  const deadline = Date.now() + READY_TIMEOUT;
  let state = await screenState(page);
  while (!state.ready && Date.now() < deadline) {
    await delay(100);
    state = await screenState(page);
  }
  if (!state.ready) {
    throw new Error(
      `BusyBoy answered but the ${state.screen} screen was not usable. Title: ${state.title || "(empty)"}.`,
    );
  }
  return state;
}

function locate(page: Page, role: string, name?: string, exact?: boolean) {
  const options: { name?: string; exact?: boolean } = {};
  if (name !== undefined) options.name = name;
  if (exact) options.exact = true;
  return page.getByRole(role as Parameters<Page["getByRole"]>[0], options);
}

function appUrl(base: string, path: string) {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new Error("The path must start with / and stay on this BusyBoy.");
  }
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin) throw new Error("The path left this BusyBoy.");
  return url.toString();
}

async function ensureDisplay(session: Session) {
  if (process.env.DISPLAY) return;
  const child = spawn("Xvfb", [":99", "-screen", "0", "1280x720x24"], { stdio: "ignore" });
  runtime.display = child;
  session.displayPid = child.pid ?? null;
  session.displayExe = child.pid ? executableOf(child.pid) : null;
  process.env.DISPLAY = ":99";
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync("/tmp/.X11-unix/X99")) return;
    if (child.exitCode !== null) throw new Error("Xvfb exited before the display was ready.");
    await delay(50);
  }
  throw new Error("Xvfb did not create a display. Electron needs DISPLAY or Xvfb.");
}

async function startWeb(session: Session) {
  const standalone = join(root, ".next", "standalone", "server.js");
  if (!existsSync(standalone))
    throw new Error("No .next/standalone/server.js. Run pnpm build first.");
  const logFile = join(session.logDir, "server.log");
  const logFd = openSync(logFile, "a");
  const child = spawn(process.execPath, [join(root, "scripts", "start-standalone.mts")], {
    cwd: root,
    env: serverEnv(session),
    stdio: ["ignore", logFd, logFd],
  });
  runtime.server = child;
  session.serverPid = child.pid ?? null;
  session.serverExe = child.pid ? executableOf(child.pid) : null;
  session.serverMark = "start-standalone.mts";
  writeSession(session);
  const status = await waitForHttp(session.url, child, logFile);
  if (status !== 200) throw new Error(`The web app returned HTTP ${status} before it was usable.`);
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
  runtime.browser = browser;
  const descendants = descendantPids(process.pid);
  const chrome = descendants.find((pid) => {
    const command = cmdline(pid);
    return command.includes("chrome") && !command.includes("--type=");
  });
  if (!chrome) {
    throw new Error(
      `Could not find the browser process.\n${descendants
        .map((pid) => cmdline(pid))
        .filter(Boolean)
        .join("\n")}`,
    );
  }
  session.browserPid = chrome;
  session.browserExe = executableOf(chrome);
  session.browserMark = "--disable-dev-shm-usage";
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    colorScheme: "dark",
    recordVideo: { dir: join(session.outDir, "video"), size: { width: 1280, height: 720 } },
  });
  runtime.context = context;
  const page = await context.newPage();
  runtime.page = page;
  watch(page, join(session.logDir, "browser.log"));
  await waitUntilUsable(page, session.url);
}

function electronBinary() {
  const binary = createRequire(import.meta.url)("electron") as unknown;
  if (typeof binary !== "string" || !existsSync(binary)) {
    throw new Error("The Electron binary is not installed. Run pnpm install.");
  }
  return binary;
}

async function startElectron(session: Session) {
  if (!existsSync(join(root, ".next", "standalone", "server.js"))) {
    throw new Error("No .next/standalone/server.js. Run pnpm build first.");
  }
  if (!existsSync(join(root, "dist-electron", "main.cjs"))) {
    throw new Error("No dist-electron/main.cjs. Run pnpm build:electron first.");
  }
  await ensureDisplay(session);
  const cdpPort = await freePort();
  session.cdpPort = cdpPort;
  const logFile = join(session.logDir, "server.log");
  const logFd = openSync(logFile, "a");
  const userData = join(session.dataDir, "electron-user-data");
  mkdirSync(userData, { recursive: true });
  const child = spawn(
    electronBinary(),
    [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userData}`, root],
    {
      cwd: root,
      env: serverEnv(session),
      stdio: ["ignore", logFd, logFd],
    },
  );
  runtime.server = child;
  session.serverPid = child.pid ?? null;
  session.serverExe = child.pid ? executableOf(child.pid) : null;
  session.serverMark = `--remote-debugging-port=${cdpPort}`;
  writeSession(session);
  const cdp = `http://127.0.0.1:${cdpPort}`;
  const deadline = Date.now() + READY_TIMEOUT;
  let opened = false;
  while (!opened && Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Electron exited before it was ready.\n${tail(logFile)}`);
    }
    try {
      const response = await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      opened = response.ok;
    } catch {
      opened = false;
    }
    if (!opened) await delay(100);
  }
  if (!opened) throw new Error(`Electron did not open a debugging port.\n${tail(logFile)}`);
  const browser = await chromium.connectOverCDP(cdp);
  runtime.browser = browser;
  const openedPage = () => {
    for (const context of browser.contexts()) {
      for (const candidate of context.pages()) {
        if (/^http:\/\/127\.0\.0\.1:\d+/.test(candidate.url())) return { context, candidate };
      }
    }
    return null;
  };
  const pageDeadline = Date.now() + READY_TIMEOUT;
  let found = openedPage();
  while (!found && Date.now() < pageDeadline) {
    await delay(100);
    found = openedPage();
  }
  if (!found) throw new Error("The Electron window did not open BusyBoy.");
  const page = found.candidate;
  runtime.context = found.context;
  runtime.page = page;
  session.url = new URL(page.url()).origin;
  session.port = Number(new URL(page.url()).port);
  watch(page, join(session.logDir, "browser.log"));
  await waitUntilUsable(page, `${session.url}/`);
}

function requirePage() {
  const page = runtime.page;
  if (!page || page.isClosed()) throw new Error("The BusyBoy window is not open.");
  return page;
}

function stringField(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${key}.`);
  return value;
}

function optionalString(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Expected ${key} to be a string.`);
  return value;
}

async function reopen(url: string) {
  const context = runtime.context;
  const session = runtime.session;
  if (!context || !session) throw new Error("The browser context is gone.");
  const page = await context.newPage();
  runtime.page = page;
  watch(page, join(session.logDir, "browser.log"));
  await waitUntilUsable(page, url);
}

async function saveVideo(destination: string | null) {
  const page = requirePage();
  const video = page.video();
  if (!video) {
    if (destination) {
      throw new Error(
        "Video recording is available on the web surface. Take a screenshot on Electron.",
      );
    }
    return;
  }
  const session = runtime.session;
  if (!session) throw new Error("No verification session.");
  const target = destination ?? evidencePath(session.outDir, join("video", "session.webm"));
  const url = page.url();
  await page.close();
  runtime.page = null;
  await video.saveAs(target);
  if (destination) await reopen(url);
}

async function drive(body: Record<string, unknown>) {
  const op = stringField(body, "op");
  const session = runtime.session;
  if (!session) throw new Error("No verification session.");
  if (op === "probe") {
    const page = requirePage();
    const state = await screenState(page);
    return {
      ...state,
      titled: state.title.includes("BusyBoy"),
      surface: session.surface,
      scripted: session.scripted,
    };
  }
  if (op === "open") {
    const page = requirePage();
    const target = appUrl(session.url, stringField(body, "path"));
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: READY_TIMEOUT });
    const state = await screenState(page);
    const deadline = Date.now() + DRIVE_TIMEOUT;
    let current = state;
    while (!current.ready && Date.now() < deadline) {
      await delay(100);
      current = await screenState(page);
    }
    if (!current.ready) throw new Error(`The ${current.screen} screen did not become usable.`);
    return current;
  }
  if (op === "press") {
    await requirePage().keyboard.press(stringField(body, "key"));
    return { key: body.key };
  }
  if (op === "type") {
    await requirePage().keyboard.type(stringField(body, "text"));
    return { typed: body.text };
  }
  if (op === "screenshot") {
    const path = evidencePath(session.outDir, stringField(body, "path"));
    await requirePage().screenshot({
      path,
      fullPage: body.fullPage === true,
      timeout: DRIVE_TIMEOUT,
    });
    return { path };
  }
  if (op === "video-save") {
    const path = evidencePath(session.outDir, stringField(body, "path"));
    await saveVideo(path);
    return { path };
  }
  if (op === "shutdown") return { stopped: true };
  const page = requirePage();
  const role = optionalString(body, "role");
  const name = optionalString(body, "name");
  const exact = body.exact === true;
  if (op === "snapshot") {
    const target = role ? locate(page, role, name, exact) : page.locator("body");
    const snapshot = await target.ariaSnapshot({ timeout: DRIVE_TIMEOUT });
    const path = optionalString(body, "path");
    const file = path ? evidencePath(session.outDir, path) : null;
    if (file) writeFileSync(file, snapshot);
    return { path: file, snapshot };
  }
  if (!role || name === undefined) throw new Error("Pass a role and a name.");
  const target = locate(page, role, name, exact);
  if (op === "click") {
    await target.click({ timeout: DRIVE_TIMEOUT, force: body.force === true });
    return { role, name };
  }
  if (op === "fill") {
    const value = stringField(body, "value");
    await target.fill(value, { timeout: DRIVE_TIMEOUT });
    return { role, name, value };
  }
  if (op === "text") {
    await target.waitFor({ state: "visible", timeout: DRIVE_TIMEOUT });
    return { role, name, text: await target.innerText({ timeout: DRIVE_TIMEOUT }) };
  }
  if (op === "wait") {
    const state = optionalString(body, "state") ?? "visible";
    if (state !== "visible" && state !== "hidden" && state !== "attached") {
      throw new Error("State must be visible, hidden, or attached.");
    }
    const attr = optionalString(body, "attr");
    if (attr) {
      await target.waitFor({ state: "visible", timeout: DRIVE_TIMEOUT });
      const value = stringField(body, "value");
      const deadline = Date.now() + DRIVE_TIMEOUT;
      let current = await target.getAttribute(attr);
      while (current !== value && Date.now() < deadline) {
        await delay(100);
        current = await target.getAttribute(attr);
      }
      if (current !== value)
        throw new Error(`${role} ${name} ${attr} is ${current ?? "missing"}, not ${value}.`);
      return { role, name, attr, value };
    }
    await target.waitFor({ state, timeout: DRIVE_TIMEOUT });
    return { role, name, state };
  }
  throw new Error(`Unknown command ${op}.`);
}

function listen() {
  const server = createTcpServer((socket: Socket) => {
    let buffer = "";
    let chain: Promise<void> = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        chain = chain.then(async () => {
          let response: { ok: boolean; result?: unknown; error?: string };
          let shutdown = false;
          try {
            const body = JSON.parse(line) as Record<string, unknown>;
            shutdown = body.op === "shutdown";
            if (shutdown) await finish("cleanup");
            const result = shutdown ? { stopped: true } : await drive(body);
            response = { ok: true, result };
          } catch (error) {
            response = { ok: false, error: errorText(error) };
            shutdown = false;
          }
          if (!socket.destroyed) {
            socket.write(`${JSON.stringify(response)}\n`, () => {
              if (shutdown) process.exit(0);
            });
          } else if (shutdown) process.exit(0);
        });
      }
    });
  });
  return new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolvePort(address.port);
      else reject(new Error("Could not listen for drive commands."));
    });
  });
}

async function finish(reason: string) {
  if (runtime.stopping) return;
  runtime.stopping = true;
  const session = runtime.session;
  log(reason);
  if (reason === "cleanup") {
    await saveVideo(null).catch((error: unknown) => log(errorText(error)));
  }
  await runtime.browser?.close().catch((error: unknown) => log(errorText(error)));
  runtime.browser = null;
  runtime.page = null;
  runtime.context = null;
  if (session) {
    await stopProcess(session.serverPid, session.serverExe, null, session.verifyId);
    await stopProcess(session.browserPid, session.browserExe, session.browserMark);
    await stopProcess(session.displayPid, session.displayExe, ":99");
    removeOwnedData(session);
    session.ready = false;
    session.stopped = reason === "cleanup";
    writeSession(session);
  }
}

async function captureFailure() {
  const session = runtime.session;
  const page = runtime.page;
  if (!session || !page || page.isClosed()) return;
  const path = evidencePath(session.outDir, "launch-failure.png");
  await page.screenshot({ path, timeout: 5_000 });
  log(`Wrote ${path}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const outDir = flag(argv, "out");
  const surfaceFlag = flag(argv, "surface") ?? "web";
  if (!outDir) throw new Error("The supervisor needs --out.");
  if (surfaceFlag !== "web" && surfaceFlag !== "electron") {
    throw new Error("Surface must be web or electron.");
  }
  const surface: Surface = surfaceFlag;
  const logDir = join(outDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), "busyboy-verify-"));
  let buildId = "";
  try {
    buildId = readBuildId(root);
  } catch {
    buildId = "";
  }
  const session: Session = {
    surface,
    pid: process.pid,
    serverPid: null,
    serverExe: null,
    serverMark: null,
    browserPid: null,
    browserExe: null,
    browserMark: null,
    displayPid: null,
    displayExe: null,
    url: "",
    controlPort: 0,
    dataDir,
    outDir,
    buildId,
    gitSha: readGitSha(root),
    port: await freePort(),
    cdpPort: null,
    verifyId: randomUUID(),
    scripted: surface === "web",
    ready: false,
    stopped: false,
    logDir,
  };
  runtime.session = session;
  session.url = `http://127.0.0.1:${session.port}`;
  writeSession(session);
  if (!session.buildId) throw new Error("No .next/BUILD_ID. Run pnpm build first.");
  seedData(dataDir);
  if (surface === "electron") await startElectron(session);
  else await startWeb(session);
  session.controlPort = await listen();
  session.ready = true;
  writeSession(session);
  log(`Ready ${session.surface} ${session.url}`);
  await new Promise(() => {});
}

process.once("SIGTERM", () => {
  void finish("signal").finally(() => process.exit(0));
});
process.once("SIGINT", () => {
  void finish("signal").finally(() => process.exit(0));
});

try {
  await main();
} catch (error) {
  const session = runtime.session;
  if (session) {
    session.error = errorText(error);
    session.ready = false;
    writeSession(session);
    await captureFailure().catch(() => {});
    await finish("failed");
  }
  process.exit(1);
}
