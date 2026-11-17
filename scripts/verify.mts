import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

import {
  ancestorPids,
  cmdline,
  delay,
  environ,
  errorText,
  isAlive,
  listenersOn,
  matchesProcess,
  outputDir,
  readBuildId,
  readGitSha,
  readSession,
  removeOwnedData,
  repoRoot,
  writeSession,
  type Session,
  type Surface,
} from "./verify-session.mts";

const USAGE = `pnpm verify <command>

  launch [--surface web|electron] --out <dir>
  doctor --out <dir>
  open --path <path> --out <dir>
  click --role <role> --name <name> [--exact] [--force] --out <dir>
  fill --role <role> --name <name> --value <text> [--exact] --out <dir>
  press --key <key> --out <dir>
  type --text <text> --out <dir>
  wait --role <role> --name <name> [--state visible|hidden|attached] [--attr <name> --value <text>] [--exact] --out <dir>
  text --role <role> --name <name> [--exact] --out <dir>
  snapshot [--role <role> --name <name>] [--exact] [--path <file>] --out <dir>
  screenshot --path <file> [--full-page] --out <dir>
  video save --path <file> --out <dir>
  cleanup --out <dir>

--out falls back to BUSYBOY_VERIFY_OUT. Paths for screenshot, snapshot, and video stay inside that folder.
`;

type Flags = Map<string, string | boolean>;

function parse(argv: string[]) {
  const command = argv[0] ?? "help";
  const flags: Flags = new Map();
  const positionals: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) flags.set(key, true);
    else {
      flags.set(key, next);
      index += 1;
    }
  }
  return { command, flags, positionals };
}

function textFlag(flags: Flags, name: string) {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function call(session: Session, body: Record<string, unknown>, timeoutMs: number) {
  return new Promise<unknown>((resolve, reject) => {
    const socket = connect(session.controlPort, "127.0.0.1");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("The verification process did not answer in time."));
    }, timeoutMs);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        const message = JSON.parse(buffer.slice(0, newline)) as {
          ok?: boolean;
          result?: unknown;
          error?: string;
        };
        if (!message.ok) reject(new Error(message.error ?? "The command failed."));
        else resolve(message.result);
      } catch (error) {
        reject(error);
      }
    });
    socket.write(`${JSON.stringify(body)}\n`);
  });
}

function supervisorAlive(session: Session) {
  return isAlive(session.pid) && cmdline(session.pid).includes("verify-supervisor.mts");
}

async function launch(flags: Flags) {
  const outDir = outputDir(textFlag(flags, "out"));
  const surfaceFlag = textFlag(flags, "surface") ?? "web";
  if (surfaceFlag !== "web" && surfaceFlag !== "electron") {
    throw new Error("Surface must be web or electron.");
  }
  const surface: Surface = surfaceFlag;
  if (existsSync(join(outDir, "session.json"))) {
    try {
      const existing = readSession(outDir);
      if (!existing.stopped && supervisorAlive(existing)) {
        throw new Error(
          `A verification instance is already running. Run pnpm verify cleanup --out ${outDir}`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("A verification instance"))
        throw error;
    }
  }
  const child = spawn(
    process.execPath,
    [join(repoRoot(), "scripts", "verify-supervisor.mts"), "--out", outDir, "--surface", surface],
    { cwd: repoRoot(), detached: true, stdio: "ignore" },
  );
  child.unref();
  const deadline = Date.now() + 120_000;
  let session: Session | null = null;
  while (Date.now() < deadline) {
    if (existsSync(join(outDir, "session.json"))) {
      try {
        session = readSession(outDir);
      } catch {
        session = null;
      }
      if (session?.error) throw new Error(`${session.error}\nLogs: ${session.logDir}`);
      if (session?.ready) {
        print({
          ok: true,
          surface: session.surface,
          url: session.url,
          outDir: session.outDir,
          dataDir: session.dataDir,
          buildId: session.buildId,
          gitSha: session.gitSha,
          scripted: session.scripted,
          logDir: session.logDir,
        });
        return;
      }
    }
    if (child.pid && !isAlive(child.pid)) {
      const detail = session?.error
        ? `${session.error}\nLogs: ${session.logDir}`
        : "It wrote no error.";
      throw new Error(`The verification process exited before BusyBoy was usable. ${detail}`);
    }
    await delay(100);
  }
  throw new Error("BusyBoy was not usable within 120 seconds.");
}

function ownedListener(session: Session, pid: number) {
  return pid === session.serverPid || ancestorPids(pid).includes(session.pid);
}

async function doctor(flags: Flags) {
  const outDir = outputDir(textFlag(flags, "out"));
  let session: Session;
  try {
    session = readSession(outDir);
  } catch (error) {
    print({ ok: false, reasons: [errorText(error)] });
    process.exitCode = 1;
    return;
  }
  const reasons: string[] = [];
  if (session.stopped) reasons.push("This instance has been cleaned up.");
  if (!supervisorAlive(session)) reasons.push("The verification process is not running.");
  if (reasons.length > 0) {
    print({
      ok: false,
      surface: session.surface,
      url: session.url,
      dataDir: session.dataDir,
      outDir: session.outDir,
      buildId: session.buildId,
      gitSha: session.gitSha,
      scripted: session.scripted,
      ready: false,
      stopped: session.stopped,
      logDir: session.logDir,
      probe: null,
      reasons,
    });
    process.exitCode = 1;
    return;
  }
  if (!session.verifyId) reasons.push("This session has no verify id.");
  else if (!matchesProcess(session.serverPid, session.serverExe, null, session.verifyId)) {
    reasons.push("The app process is not the one this run started.");
  }
  const listeners = session.port ? listenersOn(session.port) : [];
  if (!session.stopped && listeners.length === 0) {
    reasons.push(`Nothing is listening on port ${session.port}.`);
  } else if (listeners.some((listener) => !listener.loopback)) {
    reasons.push(
      `Port ${session.port} is not bound to loopback (${listeners.map((listener) => listener.local).join(", ")}).`,
    );
  } else if (listeners.some((listener) => !ownedListener(session, listener.pid))) {
    reasons.push("The app port is not owned by this verification process.");
  }
  if (session.controlPort) {
    const control = listenersOn(session.controlPort);
    if (!control.some((listener) => listener.pid === session.pid && listener.loopback)) {
      reasons.push("The control port is not owned by the verification process.");
    }
  }
  try {
    const buildId = readBuildId(repoRoot());
    const gitSha = readGitSha(repoRoot());
    if (buildId !== session.buildId) {
      reasons.push(
        `The checkout build is ${buildId}, but this instance launched ${session.buildId}.`,
      );
    }
    if (gitSha !== session.gitSha) {
      reasons.push(`HEAD is ${gitSha}, but this instance launched ${session.gitSha}.`);
    }
  } catch (error) {
    reasons.push(errorText(error));
  }
  if (
    session.verifyId &&
    matchesProcess(session.serverPid, session.serverExe, null, session.verifyId)
  ) {
    const env = environ(session.serverPid ?? 0);
    if (env.size === 0) reasons.push("Could not read the app environment.");
    else if (env.get("BUSYBOY_HOME") !== session.dataDir) {
      reasons.push("BUSYBOY_HOME is not this run's data folder.");
    }
    if (session.surface === "web" && env.size > 0) {
      if (env.get("BUSYBOY_TEST_MODE") !== "1") reasons.push("The web app is not in test mode.");
      if (env.has("BUSYBOY_TOKEN")) {
        reasons.push("The web app has a launch token, so scripted providers are off.");
      }
    }
  }
  let probe: unknown = null;
  if (reasons.length === 0) {
    try {
      probe = await call(session, { op: "probe" }, 20_000);
      const state = probe as { titled?: boolean; ready?: boolean; screen?: string };
      if (state.titled !== true) reasons.push("The page title does not identify BusyBoy.");
      if (state.ready !== true)
        reasons.push(`The ${state.screen ?? "current"} screen is not usable.`);
    } catch (error) {
      reasons.push(errorText(error));
    }
  }
  print({
    ok: reasons.length === 0,
    surface: session.surface,
    url: session.url,
    dataDir: session.dataDir,
    outDir: session.outDir,
    buildId: session.buildId,
    gitSha: session.gitSha,
    scripted: session.scripted,
    ready: session.ready,
    stopped: session.stopped,
    logDir: session.logDir,
    probe,
    reasons,
  });
  if (reasons.length > 0) process.exitCode = 1;
}

async function forceStop(session: Session) {
  const targets: [number | null, string | null, string | null, string | null][] = [
    [session.browserPid, session.browserExe, session.browserMark, null],
    [session.serverPid, session.serverExe, null, session.verifyId ?? null],
    [session.displayPid, session.displayExe, ":99", null],
    [session.pid, process.execPath, "verify-supervisor.mts", null],
  ];
  for (const [pid, executable, mark, verifyId] of targets) {
    if (pid === null || !matchesProcess(pid, executable, mark, verifyId)) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
  }
  await delay(300);
  for (const [pid, executable, mark, verifyId] of targets) {
    if (pid === null || !matchesProcess(pid, executable, mark, verifyId)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
  }
  removeOwnedData(session);
  session.ready = false;
  session.stopped = true;
  writeSession(session);
}

async function cleanup(flags: Flags) {
  const outDir = outputDir(textFlag(flags, "out"));
  const session = readSession(outDir);
  if (supervisorAlive(session)) {
    try {
      await call(session, { op: "shutdown" }, 60_000);
    } catch {
      await forceStop(session);
      print({
        ok: true,
        stopped: true,
        outDir: session.outDir,
        evidence: session.outDir,
      });
      return;
    }
  }
  await forceStop(session);
  print({
    ok: true,
    stopped: true,
    outDir: session.outDir,
    evidence: session.outDir,
  });
}

async function drive(command: string, flags: Flags, positionals: string[]) {
  const outDir = outputDir(textFlag(flags, "out"));
  const session = readSession(outDir);
  if (!supervisorAlive(session))
    throw new Error("No verification instance is running. Launch one first.");
  const body: Record<string, unknown> = { op: command };
  if (flags.has("exact")) body.exact = true;
  if (flags.has("force")) body.force = true;
  if (flags.has("full-page")) body.fullPage = true;
  for (const key of ["role", "name", "value", "key", "text", "path", "attr", "state"]) {
    const value = textFlag(flags, key);
    if (value !== undefined) body[key] = value;
  }
  if (command === "video") {
    if (positionals[0] !== "save") throw new Error("Use pnpm verify video save --path <file>.");
    body.op = "video-save";
  }
  const timeout = command === "video" ? 60_000 : 30_000;
  print(await call(session, body, timeout));
}

async function main() {
  const { command, flags, positionals } = parse(process.argv.slice(2));
  if (command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  if (command === "launch") {
    await launch(flags);
    return;
  }
  if (command === "doctor") {
    await doctor(flags);
    return;
  }
  if (command === "cleanup") {
    await cleanup(flags);
    return;
  }
  const commands = new Set([
    "open",
    "click",
    "fill",
    "press",
    "type",
    "wait",
    "text",
    "snapshot",
    "screenshot",
    "video",
  ]);
  if (!commands.has(command)) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  await drive(command, flags, positionals);
}

try {
  await main();
} catch (error) {
  console.error(errorText(error));
  process.exitCode = 1;
}
