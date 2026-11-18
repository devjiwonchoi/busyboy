import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import {
  accessSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import {
  _electron as electron,
  chromium,
  type Browser,
  type CDPSession,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";

const root = join(import.meta.dirname, "..");
const verifyDir = join(root, ".verify");
const evidenceDir = join(verifyDir, "evidence");
const statePath = join(verifyDir, "run.json");
const socketPath = join(verifyDir, "drive.sock");
const framesRoot = join(verifyDir, "frames");
const keeperLogPath = join(verifyDir, "keeper.log");
const serverLogPath = join(verifyDir, "server.log");
const readyMs = 180_000;
const actionMs = 45_000;
const host = "127.0.0.1";
const electronFiles = [
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  ".next/standalone/server.js",
];

const directorQuestion = "What does git worktree do? Answer in one sentence.";

type Surface = "next" | "electron";

type RunState = {
  phase: "starting" | "ready" | "failed";
  surface: Surface;
  pid: number;
  serverPid: number | null;
  port: number | null;
  url: string | null;
  cdp: string | null;
  dataDir: string;
  evidenceDir: string;
  revision: string;
  error?: string;
};

type Command = {
  cmd: string;
  surface?: Surface;
  name?: string;
  role?: string;
  text?: string;
  value?: string;
  key?: string;
  attribute?: string;
  timeout?: number;
};

type Result = {
  ok: boolean;
  message: string;
  data?: unknown;
};

type Recording = {
  name: string;
  dir: string;
  client: CDPSession;
  next: number;
  chain: Promise<void>;
};

type Drive = {
  surface: Surface;
  page: Page;
  browser: Browser | null;
  electronApp: ElectronApplication | null;
  server: ChildProcess | null;
  dataDir: string;
  url: string;
  cdp: string | null;
  recording: Recording | null;
};

const require = createRequire(import.meta.url);

function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function result(ok: boolean, message: string, data?: unknown): Result {
  return data === undefined ? { ok, message } : { ok, message, data };
}

function fail(message: string): Result {
  return result(false, message);
}

function option(args: string[], name: string) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function revision() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function readState(): RunState | undefined {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as RunState;
  } catch {
    return undefined;
  }
}

function writeState(state: RunState) {
  mkdirSync(verifyDir, { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, statePath);
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cmdline(pid: number) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replaceAll("\0", " ");
  } catch {
    return "";
  }
}

function environ(pid: number) {
  try {
    return readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0");
  } catch {
    return [];
  }
}

function envValue(pid: number, key: string) {
  const prefix = `${key}=`;
  return environ(pid)
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length);
}

function childPids(pid: number) {
  const children: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const parent = Number(/\)\s+\S+\s+(\d+)/.exec(stat)?.[1]);
      if (parent === pid) children.push(Number(entry));
    } catch {
      continue;
    }
  }
  return children;
}

function descendants(pid: number) {
  const found: number[] = [];
  const stack = [pid];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    found.push(current);
    stack.push(...childPids(current));
  }
  return found;
}

function killTree(pid: number) {
  for (const child of childPids(pid)) killTree(child);
  if (!alive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

function isOurDataDir(folder: string) {
  const path = resolve(folder);
  const temp = resolve(tmpdir());
  return path.startsWith(`${temp}${sep}`) && basename(path).startsWith("busyboy-verify-");
}

function evidenceName(name: string | undefined) {
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(
      "Pass --name with lowercase letters, numbers, and hyphens, such as director-send.",
    );
  }
  return name;
}

function tail(file: string) {
  try {
    return readFileSync(file, "utf8").split("\n").slice(-40).join("\n").trim();
  } catch {
    return "";
  }
}

function freePort() {
  return new Promise<number>((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, host, () => {
      const address = probe.address();
      probe.close(() => {
        if (address && typeof address === "object") resolvePort(address.port);
        else rejectPort(new Error("Could not reserve a port."));
      });
    });
  });
}

function missingElectronFiles() {
  return electronFiles.filter((file) => !exists(join(root, file)));
}

function exists(file: string) {
  try {
    accessSync(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function seedData(dataDir: string) {
  const settings = {
    version: 1,
    setupCompletedAt: new Date(0).toISOString(),
    defaultProvider: "claude",
  };
  writeFileSync(join(dataDir, "app-settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

function serverEnv(dataDir: string, port: number | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BUSYBOY_TOKEN;
  env.BUSYBOY_HOME = dataDir;
  env.BUSYBOY_TEST_MODE = "1";
  env.CLAUDE_CONFIG_DIR = join(dataDir, "claude-config");
  env.CODEX_HOME = join(dataDir, "codex-home");
  env.NEXT_TELEMETRY_DISABLED = "1";
  env.HOSTNAME = host;
  if (port !== undefined) env.PORT = String(port);
  return env;
}

function transcript(page: Page) {
  return page.getByRole("log", { name: "Transcript" });
}

function roleLocator(page: Page, role: string, name: string) {
  return page.getByRole(role as Parameters<Page["getByRole"]>[0], { name });
}

async function attributeIs(locator: Locator, attribute: string, value: string) {
  return (await locator.getAttribute(attribute).catch(() => null)) === value;
}

async function waitForAttribute(
  locator: Locator,
  attribute: string,
  value: string,
  timeout: number,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await attributeIs(locator, attribute, value)) return;
    await delay(100);
  }
  const actual = await locator.getAttribute(attribute).catch(() => null);
  throw new Error(
    `Timed out waiting for ${attribute}="${value}". The attribute is ${actual ?? "missing"}.`,
  );
}

async function sendMessage(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

async function openChat(drive: Drive) {
  await drive.page.goto(drive.url, { waitUntil: "domcontentloaded", timeout: readyMs });
  const log = transcript(drive.page);
  await log.waitFor({ timeout: readyMs });
  await waitForAttribute(log, "data-connected", "true", readyMs);
  await drive.page.getByRole("textbox", { name: "Message" }).waitFor({ timeout: actionMs });
  await drive.page.getByRole("button", { name: "Stop" }).waitFor({ timeout: actionMs });
}

async function directorSend(drive: Drive) {
  await openChat(drive);
  await sendMessage(drive.page, directorQuestion);
  const log = transcript(drive.page);
  await log
    .getByLabel("Your message")
    .filter({ hasText: directorQuestion })
    .waitFor({ timeout: actionMs });
  const file = join(drive.dataDir, "director", "transcript.jsonl");
  const deadline = Date.now() + actionMs;
  while (Date.now() < deadline) {
    if (exists(file) && readFileSync(file, "utf8").includes(directorQuestion)) return file;
    await delay(150);
  }
  throw new Error(`The message is on screen, and ${file} does not contain it.`);
}

async function runStep(drive: Drive, command: Command): Promise<Result> {
  const name = command.name;
  if (name === "open-chat") {
    await openChat(drive);
    return result(true, "The Director chat is open and the transcript is connected.");
  }
  if (name === "send-message") {
    if (!command.text) return fail("send-message needs --text.");
    await sendMessage(drive.page, command.text);
    await transcript(drive.page)
      .getByLabel("Your message")
      .filter({ hasText: command.text })
      .waitFor({ timeout: actionMs });
    return result(true, "The message is in the transcript.");
  }
  return fail(`Unknown step "${name ?? ""}". Steps: open-chat, send-message.`);
}

async function runJourney(drive: Drive, name: string | undefined): Promise<Result> {
  if (drive.surface === "electron") {
    return fail(
      "Chat and settings journeys run on the Next surface. The desktop server sets a launch token and ignores provider scripts.",
    );
  }
  if (name === "director-send") {
    const file = await directorSend(drive);
    return result(true, `The message is in the chat. ${file} contains "${directorQuestion}".`);
  }
  if (name === "first-run") {
    await firstRun(drive);
    return result(true, "A fresh profile signed in and opened the Director chat.");
  }
  return fail("Unknown journey. Journeys: director-send, first-run.");
}

async function firstRun(drive: Drive) {
  rmSync(join(drive.dataDir, "app-settings.json"), { force: true });
  await drive.page.goto(drive.url, { waitUntil: "domcontentloaded", timeout: readyMs });
  await drive.page
    .getByRole("heading", { name: "Sign in to an agent" })
    .waitFor({ timeout: readyMs });
  for (const heading of ["Pick a Director", "Add skills", "Always ask before", "Add projects"]) {
    if ((await drive.page.getByRole("heading", { name: heading }).count()) > 0)
      throw new Error(`Setup still shows ${heading}.`);
  }
  await drive.page.getByRole("button", { name: "Continue" }).click();
  const log = transcript(drive.page);
  await log.waitFor({ timeout: readyMs });
  await waitForAttribute(log, "data-connected", "true", readyMs);
  await drive.page
    .getByText("BusyBoy is ready. What should we work on?")
    .waitFor({ timeout: actionMs });
  const settings = readJson(join(drive.dataDir, "app-settings.json")) as {
    setupCompletedAt?: string | null;
  };
  if (!settings.setupCompletedAt) throw new Error("Continue did not finish setup.");
}

async function inspect(drive: Drive) {
  const log = transcript(drive.page);
  const connected =
    (await log.count()) > 0 ? await log.first().getAttribute("data-connected") : null;
  return {
    url: drive.page.url(),
    title: await drive.page.title(),
    transcriptConnected: connected,
    setupHeading:
      (await drive.page.getByRole("heading", { name: "Sign in to an agent" }).count()) > 0,
  };
}

async function screenshot(drive: Drive, name: string) {
  mkdirSync(evidenceDir, { recursive: true });
  const path = join(evidenceDir, `${evidenceName(name)}.png`);
  await drive.page.screenshot({ path, type: "png" });
  return path;
}

async function dump(drive: Drive, name: string) {
  mkdirSync(evidenceDir, { recursive: true });
  const path = join(evidenceDir, `${evidenceName(name)}.aria.txt`);
  const snapshot = await drive.page.locator("body").ariaSnapshot();
  const text = `url: ${drive.page.url()}\ntitle: ${await drive.page.title()}\n\n${snapshot}\n`;
  writeFileSync(path, text);
  return { path, text };
}

async function recordStart(drive: Drive, name: string) {
  if (drive.recording)
    throw new Error("A recording is already running. Run pnpm drive record stop first.");
  const safe = evidenceName(name);
  const dir = join(framesRoot, safe);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const client = await drive.page.context().newCDPSession(drive.page);
  const recording: Recording = { name: safe, dir, client, next: 0, chain: Promise.resolve() };
  const enqueue = (bytes: Buffer) => {
    recording.chain = recording.chain.then(async () => {
      const file = join(dir, `${String(recording.next).padStart(5, "0")}.jpeg`);
      recording.next += 1;
      await writeFile(file, bytes);
    });
  };
  client.on("Page.screencastFrame", (frame: { data: string; sessionId: number }) => {
    enqueue(Buffer.from(frame.data, "base64"));
    void client
      .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
      .catch(() => undefined);
  });
  await client.send("Page.startScreencast", {
    format: "jpeg",
    quality: 70,
    everyNthFrame: 1,
    maxWidth: 1280,
    maxHeight: 820,
  });
  enqueue(await drive.page.screenshot({ type: "jpeg", quality: 70 }));
  drive.recording = recording;
  return dir;
}

async function recordStop(drive: Drive) {
  const recording = drive.recording;
  if (!recording)
    throw new Error("No recording is running. Run pnpm drive record start --name <name> first.");
  enqueueStopFrame(recording, await drive.page.screenshot({ type: "jpeg", quality: 70 }));
  await recording.client.send("Page.stopScreencast").catch(() => undefined);
  await recording.chain;
  await recording.client.detach().catch(() => undefined);
  drive.recording = null;
  if (recording.next < 1) throw new Error("The recording captured no frames.");
  mkdirSync(evidenceDir, { recursive: true });
  const path = join(evidenceDir, `${recording.name}.webm`);
  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-y",
      "-framerate",
      "8",
      "-start_number",
      "0",
      "-i",
      "%05d.jpeg",
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuv420p",
      "-an",
      path,
    ],
    {
      cwd: recording.dir,
    },
  );
  const stderr: Buffer[] = [];
  ffmpeg.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number>((resolveCode) =>
    ffmpeg.once("close", (exit) => resolveCode(exit ?? 1)),
  );
  if (code !== 0 || !exists(path)) {
    throw new Error(`ffmpeg exited ${code}. ${Buffer.concat(stderr).toString("utf8").slice(-800)}`);
  }
  rmSync(recording.dir, { recursive: true, force: true });
  return path;
}

function enqueueStopFrame(recording: Recording, bytes: Buffer) {
  recording.chain = recording.chain.then(async () => {
    const file = join(recording.dir, `${String(recording.next).padStart(5, "0")}.jpeg`);
    recording.next += 1;
    await writeFile(file, bytes);
  });
}

async function handle(drive: Drive, command: Command): Promise<Result> {
  if (command.cmd === "inspect") return result(true, "Read the page.", await inspect(drive));
  if (command.cmd === "screenshot")
    return result(true, await screenshot(drive, command.name ?? ""), {
      path: join(evidenceDir, `${command.name}.png`),
    });
  if (command.cmd === "dump") {
    const dumped = await dump(drive, command.name ?? "");
    return result(true, dumped.text, { path: dumped.path });
  }
  if (command.cmd === "record-start")
    return result(true, `Recording to ${await recordStart(drive, command.name ?? "")}.`);
  if (command.cmd === "record-stop") return result(true, `Saved ${await recordStop(drive)}.`);
  if (command.cmd === "click") {
    if (!command.role || !command.name) return fail("click needs --role and --name.");
    await roleLocator(drive.page, command.role, command.name).click();
    return result(true, `Clicked ${command.role} "${command.name}".`);
  }
  if (command.cmd === "fill") {
    if (!command.role || !command.name || command.value === undefined)
      return fail("fill needs --role, --name, and --value.");
    await roleLocator(drive.page, command.role, command.name).fill(command.value);
    return result(true, `Filled ${command.role} "${command.name}".`);
  }
  if (command.cmd === "press") {
    if (!command.key) return fail("press needs --key.");
    await drive.page.keyboard.press(command.key);
    return result(true, `Pressed ${command.key}.`);
  }
  if (command.cmd === "wait") {
    if (!command.role || !command.name) return fail("wait needs --role and --name.");
    const locator = roleLocator(drive.page, command.role, command.name);
    const timeout = command.timeout ?? actionMs;
    await locator.first().waitFor({ timeout });
    if (command.text) await locator.filter({ hasText: command.text }).first().waitFor({ timeout });
    if (command.attribute && command.value !== undefined)
      await waitForAttribute(locator.first(), command.attribute, command.value, timeout);
    return result(true, `Found ${command.role} "${command.name}".`);
  }
  if (command.cmd === "step") return runStep(drive, { ...command, name: command.name });
  if (command.cmd === "journey") return runJourney(drive, command.name);
  return fail(`Unknown command ${command.cmd}.`);
}

async function launchBrowser(drive: Drive, cdpPort: number) {
  const browser = await chromium.launch({
    headless: true,
    args: [`--remote-debugging-port=${cdpPort}`],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    colorScheme: "dark",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(actionMs);
  drive.browser = browser;
  drive.page = page;
  drive.cdp = await cdpEndpoint(cdpPort);
}

async function cdpEndpoint(port: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${host}:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      const body = (await response.json()) as { webSocketDebuggerUrl?: string };
      if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
    } catch {
      await delay(100);
      continue;
    }
    await delay(100);
  }
  return `http://${host}:${port}`;
}

function debuggingEndpoint(pid: number | undefined) {
  if (!pid) return null;
  const match = /--remote-debugging-port=(\d+)/.exec(cmdline(pid));
  if (!match || match[1] === "0") return "playwright-electron";
  return `http://${host}:${match[1]}`;
}

function stringEnv(env: NodeJS.ProcessEnv) {
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return Object.fromEntries(entries);
}

async function launchNext(dataDir: string) {
  const port = await freePort();
  const url = `http://${host}:${port}`;
  const log = createWriteStream(serverLogPath, { flags: "a" });
  const server = spawn(
    "pnpm",
    ["exec", "next", "dev", "--hostname", host, "--port", String(port)],
    {
      cwd: root,
      env: serverEnv(dataDir, port),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout?.pipe(log);
  server.stderr?.pipe(log);
  let exited = false;
  server.once("exit", () => {
    exited = true;
  });
  const deadline = Date.now() + readyMs;
  while (Date.now() < deadline) {
    if (exited)
      throw new Error(
        `The Next server exited before it accepted connections.\n${tail(serverLogPath)}`,
      );
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await response.arrayBuffer().catch(() => undefined);
      if (response.status < 500) return { server, port, url };
    } catch {
      await delay(200);
      continue;
    }
    await delay(200);
  }
  throw new Error(`The Next server did not accept connections.\n${tail(serverLogPath)}`);
}

async function launchElectron(dataDir: string) {
  const missing = missingElectronFiles();
  if (missing.length > 0) {
    throw new Error(
      `The Electron surface needs ${missing.join(", ")}. Run pnpm build and pnpm build:electron.`,
    );
  }
  const executablePath = require("electron") as string;
  const app = await electron.launch({
    executablePath,
    args: [root],
    cwd: root,
    env: stringEnv(serverEnv(dataDir, undefined)),
    timeout: readyMs,
  });
  const page = await app.firstWindow({ timeout: readyMs });
  page.setDefaultTimeout(actionMs);
  await page.getByRole("heading", { name: "Sign in to an agent" }).waitFor({ timeout: readyMs });
  return { app, page, url: page.url() };
}

function serverPidFrom(spawned: ChildProcess, dataDir: string) {
  const rootPid = spawned.pid;
  if (!rootPid) return null;
  const match = descendants(rootPid).find(
    (pid) => envValue(pid, "BUSYBOY_HOME") === dataDir && cmdline(pid).includes("next"),
  );
  return match ?? rootPid;
}

async function keeper(surface: Surface) {
  mkdirSync(verifyDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), "busyboy-verify-"));
  const state: RunState = {
    phase: "starting",
    surface,
    pid: process.pid,
    serverPid: null,
    port: null,
    url: null,
    cdp: null,
    dataDir,
    evidenceDir,
    revision: revision(),
  };
  writeState(state);
  let drive: Drive | undefined;
  const failKeeper = async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeState({ ...state, phase: "failed", error: message });
    await release(drive, false);
    if (isOurDataDir(dataDir)) rmSync(dataDir, { recursive: true, force: true });
    process.exit(1);
  };
  try {
    if (surface === "electron") {
      const launched = await launchElectron(dataDir);
      drive = {
        surface,
        page: launched.page,
        browser: null,
        electronApp: launched.app,
        server: null,
        dataDir,
        url: launched.url,
        cdp: debuggingEndpoint(launched.app.process().pid),
        recording: null,
      };
      state.url = launched.url;
      state.cdp = drive.cdp;
      state.serverPid = launched.app.process().pid ?? null;
    } else {
      seedData(dataDir);
      const launched = await launchNext(dataDir);
      const browserDrive: Drive = {
        surface,
        page: undefined as unknown as Page,
        browser: null,
        electronApp: null,
        server: launched.server,
        dataDir,
        url: launched.url,
        cdp: null,
        recording: null,
      };
      drive = browserDrive;
      const cdpPort = await freePort();
      await launchBrowser(browserDrive, cdpPort);
      state.port = launched.port;
      state.url = launched.url;
      state.cdp = browserDrive.cdp;
      state.serverPid = serverPidFrom(launched.server, dataDir);
      await openChat(browserDrive);
      await browserDrive.page
        .getByText("BusyBoy is ready. What should we work on?")
        .waitFor({ timeout: actionMs });
    }
  } catch (error) {
    await failKeeper(error);
    return;
  }
  const ready = drive;
  if (!ready) return;
  rmSync(socketPath, { force: true });
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      void (async () => {
        let response: Result;
        try {
          const command = JSON.parse(line) as Command;
          if (command.cmd === "shutdown") {
            socket.end(
              `${JSON.stringify(result(true, "Stopped the BusyBoy instance this run started. Evidence remains in .verify/evidence."))}\n`,
            );
            await new Promise((resolveClose) => socket.once("close", resolveClose));
            await release(ready, true);
            process.exit(0);
          }
          response = await handle(ready, command);
        } catch (error) {
          response = fail(error instanceof Error ? error.message : String(error));
        }
        socket.end(`${JSON.stringify(response)}\n`);
      })();
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => resolveListen());
  });
  state.phase = "ready";
  writeState(state);
  const stop = () => {
    void release(ready, true).finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

async function release(drive: Drive | undefined, removeState: boolean) {
  if (drive?.recording) {
    await drive.recording.client.send("Page.stopScreencast").catch(() => undefined);
    await drive.recording.client.detach().catch(() => undefined);
  }
  await drive?.page.close().catch(() => undefined);
  await drive?.browser?.close().catch(() => undefined);
  await drive?.electronApp?.close().catch(() => undefined);
  if (drive?.server?.pid) killTree(drive.server.pid);
  const electronPid = drive?.electronApp?.process().pid;
  if (electronPid) killTree(electronPid);
  if (drive && isOurDataDir(drive.dataDir)) rmSync(drive.dataDir, { recursive: true, force: true });
  rmSync(framesRoot, { recursive: true, force: true });
  rmSync(serverLogPath, { force: true });
  rmSync(socketPath, { force: true });
  if (removeState) rmSync(statePath, { force: true });
}

function call(command: Command) {
  return new Promise<Result>((resolveCall, rejectCall) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.once("error", rejectCall);
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
    });
    socket.on("end", () => {
      try {
        resolveCall(JSON.parse(buffer) as Result);
      } catch {
        rejectCall(new Error(`The drive keeper returned ${buffer.slice(0, 400)}`));
      }
    });
    socket.end(`${JSON.stringify(command)}\n`);
  });
}

function print(response: Result) {
  process.stdout.write(`${response.message.trim()}\n`);
  if (!response.ok) process.exitCode = 1;
}

async function launchCommand(surface: Surface) {
  const current = readState();
  if (current && alive(current.pid) && cmdline(current.pid).includes("drive.mts")) {
    throw new Error(
      "A verification instance is already running. Run pnpm drive cleanup before launching another.",
    );
  }
  if (current) await cleanupLeftovers(current);
  mkdirSync(verifyDir, { recursive: true });
  const log = openSync(keeperLogPath, "w");
  const keeperEnv = { ...process.env };
  delete keeperEnv.BUSYBOY_TOKEN;
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      join(root, "scripts", "drive.mts"),
      "keeper",
      "--surface",
      surface,
    ],
    {
      cwd: root,
      env: keeperEnv,
      detached: true,
      stdio: ["ignore", log, log],
    },
  );
  child.unref();
  const deadline = Date.now() + readyMs + 15_000;
  while (Date.now() < deadline) {
    const state = readState();
    if (state?.phase === "ready") {
      process.stdout.write(
        `BusyBoy is usable at ${state.url}\nsurface: ${state.surface}\ndata: ${state.dataDir}\nevidence: ${state.evidenceDir}\ncdp: ${state.cdp ?? "none"}\n`,
      );
      return;
    }
    if (state?.phase === "failed") throw new Error(state.error ?? "Launch failed.");
    if (child.pid && !alive(child.pid))
      throw new Error(`The drive keeper exited.\n${tail(keeperLogPath)}`);
    await delay(250);
  }
  throw new Error(`Launch did not become usable.\n${tail(keeperLogPath)}\n${tail(serverLogPath)}`);
}

async function cleanupLeftovers(state: RunState) {
  if (alive(state.pid) && cmdline(state.pid).includes("drive.mts")) killTree(state.pid);
  if (
    state.serverPid &&
    alive(state.serverPid) &&
    (envValue(state.serverPid, "BUSYBOY_HOME") === state.dataDir ||
      cmdline(state.serverPid).includes("electron"))
  ) {
    killTree(state.serverPid);
  }
  for (const pid of state.serverPid ? descendants(state.serverPid) : []) {
    if (envValue(pid, "BUSYBOY_HOME") === state.dataDir) killTree(pid);
  }
  if (isOurDataDir(state.dataDir)) rmSync(state.dataDir, { recursive: true, force: true });
  rmSync(socketPath, { force: true });
  rmSync(statePath, { force: true });
  rmSync(serverLogPath, { force: true });
  rmSync(keeperLogPath, { force: true });
  rmSync(framesRoot, { recursive: true, force: true });
}

function portOwner(port: number) {
  const needle = `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
  let inode = "";
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts[1]?.toUpperCase() === needle && parts[3] === "0A") inode = parts[9] ?? "";
    }
  }
  if (!inode) return null;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[] = [];
    try {
      fds = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(`/proc/${entry}/fd/${fd}`) === `socket:[${inode}]`) return Number(entry);
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function doctor() {
  const state = readState();
  if (!state || state.phase !== "ready") {
    process.stdout.write("No verification instance is running.\n");
    process.exitCode = 1;
    return;
  }
  const lines: string[] = [];
  const problems: string[] = [];
  lines.push(`surface: ${state.surface}`);
  lines.push(`url: ${state.url ?? "unknown"}`);
  lines.push(`data: ${state.dataDir}`);
  lines.push(`evidence: ${state.evidenceDir}`);
  lines.push(`revision: ${state.revision}`);
  lines.push(`cdp: ${state.cdp ?? "none"}`);
  if (!alive(state.pid) || !cmdline(state.pid).includes("drive.mts"))
    problems.push("The drive keeper is not the process this run started.");
  else lines.push(`keeper: ${state.pid} alive`);
  const tree = state.serverPid
    ? descendants(state.serverPid).concat(descendants(state.pid))
    : descendants(state.pid);
  const server = tree.find(
    (pid) =>
      envValue(pid, "BUSYBOY_HOME") === state.dataDir &&
      (cmdline(pid).includes("next") ||
        cmdline(pid).includes("server.js") ||
        envValue(pid, "BUSYBOY_TOKEN")),
  );
  if (!server) problems.push("No server process from this run has the temporary data folder.");
  else lines.push(`server: ${server} alive`);
  if (state.port) {
    const owner = portOwner(state.port);
    if (owner && tree.includes(owner)) lines.push(`port ${state.port} owner: ${owner} (this run)`);
    else problems.push(`Port ${state.port} is owned by ${owner ?? "nobody"}, outside this run.`);
  }
  const serverTree = state.serverPid ? descendants(state.serverPid) : [];
  const tokenPid = serverTree.find((pid) => envValue(pid, "BUSYBOY_TOKEN"));
  if (state.surface === "next") {
    if (tokenPid) problems.push("A launch token is set on the Next server.");
    const home = server ? envValue(server, "BUSYBOY_HOME") : undefined;
    if (home !== state.dataDir)
      problems.push("The server data folder is not this run's temporary folder.");
  } else if (tokenPid) lines.push("desktop server: launch token is set");
  else
    problems.push(
      "The desktop server has no launch token, so this is not the Electron app this command starts.",
    );
  const missing = missingElectronFiles();
  lines.push(
    missing.length === 0
      ? "electron bundle: present"
      : `electron bundle: missing ${missing.join(", ")}`,
  );
  try {
    const response = await call({ cmd: "inspect" });
    const page = response.data as {
      title?: string;
      transcriptConnected?: string | null;
      setupHeading?: boolean;
      url?: string;
    };
    lines.push(`title: ${page.title ?? "unknown"}`);
    lines.push(`page: ${page.url ?? "unknown"}`);
    if (state.surface === "next") {
      if (page.transcriptConnected === "true") lines.push("transcript: connected");
      else problems.push("The transcript is not connected, so the chat is not usable yet.");
      if (!page.title?.includes("BusyBoy"))
        problems.push("The page title does not identify BusyBoy.");
    } else if (page.setupHeading) lines.push("setup: Sign in to an agent is visible");
    else problems.push("The desktop window is not showing Sign in to an agent.");
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  if (problems.length > 0) {
    process.stdout.write(`${problems.map((problem) => `problem: ${problem}`).join("\n")}\n`);
    process.exitCode = 1;
  }
}

function help() {
  return `pnpm drive launch [--surface next|electron]
pnpm drive doctor
pnpm drive step <open-chat|send-message> [--text TEXT]
pnpm drive journey <director-send|first-run>
pnpm drive click --role ROLE --name NAME
pnpm drive fill --role ROLE --name NAME --value VALUE
pnpm drive press --key KEY
pnpm drive wait --role ROLE --name NAME [--attribute NAME --value VALUE] [--text TEXT]
pnpm drive screenshot --name NAME
pnpm drive dump --name NAME
pnpm drive record start --name NAME
pnpm drive record stop
pnpm drive cleanup`;
}

async function client(args: string[]) {
  const [command, extra] = args;
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(`${help()}\n`);
    return;
  }
  if (command === "launch") {
    const surface = option(args, "surface") ?? "next";
    if (surface !== "next" && surface !== "electron")
      throw new Error("--surface must be next or electron.");
    await launchCommand(surface);
    return;
  }
  if (command === "doctor") {
    await doctor();
    return;
  }
  if (command === "cleanup") {
    const state = readState();
    if (state && alive(state.pid) && exists(socketPath)) {
      try {
        const response = await call({ cmd: "shutdown" });
        print(response);
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && alive(state.pid)) await delay(100);
        if (alive(state.pid)) await cleanupLeftovers(state);
        else rmSync(keeperLogPath, { force: true });
        return;
      } catch {
        await cleanupLeftovers(state);
        process.stdout.write(
          "Stopped the BusyBoy instance this run started. Evidence remains in .verify/evidence.\n",
        );
        return;
      }
    }
    if (state) await cleanupLeftovers(state);
    process.stdout.write("Nothing is running. Evidence remains in .verify/evidence.\n");
    return;
  }
  const state = readState();
  if (!state || state.phase !== "ready" || !alive(state.pid)) {
    throw new Error("No verification instance is running. Run pnpm drive launch first.");
  }
  if (command === "screenshot" || command === "dump") {
    const response = await call({ cmd: command, name: option(args, "name") });
    if (command === "dump" && response.ok) process.stdout.write(`${response.message}`);
    else print(response);
    if (
      command === "dump" &&
      response.ok &&
      response.data &&
      typeof response.data === "object" &&
      "path" in response.data
    ) {
      process.stdout.write(`\n${String((response.data as { path: string }).path)}\n`);
    }
    return;
  }
  if (command === "record") {
    if (extra === "start") print(await call({ cmd: "record-start", name: option(args, "name") }));
    else if (extra === "stop") print(await call({ cmd: "record-stop" }));
    else throw new Error("record needs start or stop.");
    return;
  }
  if (command === "step" || command === "journey") {
    print(await call({ cmd: command, name: extra, text: option(args, "text") }));
    return;
  }
  if (command === "click" || command === "fill" || command === "wait") {
    print(
      await call({
        cmd: command,
        role: option(args, "role"),
        name: option(args, "name"),
        value: option(args, "value"),
        text: option(args, "text"),
        attribute: option(args, "attribute"),
        timeout: option(args, "timeout") ? Number(option(args, "timeout")) : undefined,
      }),
    );
    return;
  }
  if (command === "press") {
    print(await call({ cmd: "press", key: option(args, "key") }));
    return;
  }
  throw new Error(`Unknown command "${command}".\n${help()}`);
}

const args = process.argv.slice(2);
if (args[0] === "keeper") {
  const surface = option(args, "surface") ?? "next";
  if (surface !== "next" && surface !== "electron") {
    process.stderr.write("--surface must be next or electron.\n");
    process.exit(1);
  }
  await keeper(surface);
} else {
  try {
    await client(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
