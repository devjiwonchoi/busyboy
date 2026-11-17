import { execFileSync } from "node:child_process";
import {
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export type Surface = "web" | "electron";

export type Session = {
  surface: Surface;
  pid: number;
  serverPid: number | null;
  serverExe: string | null;
  serverMark: string | null;
  browserPid: number | null;
  browserExe: string | null;
  browserMark: string | null;
  displayPid: number | null;
  displayExe: string | null;
  url: string;
  controlPort: number;
  dataDir: string;
  outDir: string;
  buildId: string;
  gitSha: string;
  port: number;
  cdpPort: number | null;
  verifyId: string;
  scripted: boolean;
  ready: boolean;
  stopped: boolean;
  logDir: string;
  error?: string;
};

export const SESSION_NAME = "session.json";

export function repoRoot() {
  return join(import.meta.dirname, "..");
}

export function sessionPath(outDir: string) {
  return join(resolve(outDir), SESSION_NAME);
}

export function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isSurface(value: unknown): value is Surface {
  return value === "web" || value === "electron";
}

function isSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Partial<Session>;
  return (
    isSurface(session.surface) &&
    typeof session.pid === "number" &&
    typeof session.outDir === "string" &&
    typeof session.dataDir === "string" &&
    typeof session.controlPort === "number" &&
    typeof session.buildId === "string" &&
    typeof session.gitSha === "string"
  );
}

export function readSession(outDir: string): Session {
  const file = sessionPath(outDir);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`No verification session at ${file}. ${errorText(error)}`);
  }
  if (!isSession(value))
    throw new Error(`The session file at ${file} is not a BusyBoy verification session.`);
  return value;
}

export function writeSession(session: Session) {
  const file = sessionPath(session.outDir);
  mkdirSync(session.outDir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`);
  renameSync(temporary, file);
}

export function readBuildId(root: string) {
  return readFileSync(join(root, ".next", "BUILD_ID"), "utf8").trim();
}

export function readGitSha(root: string) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

export function cmdline(pid: number) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replaceAll("\0", " ").trim();
  } catch {
    return "";
  }
}

export function executableOf(pid: number) {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return "";
  }
}

export function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function matchesProcess(
  pid: number | null,
  executable: string | null,
  mark: string | null,
  verifyId: string | null = null,
) {
  if (!pid || !isAlive(pid)) return false;
  if (executable && executableOf(pid) !== executable) return false;
  if (mark && !cmdline(pid).includes(mark)) return false;
  if (verifyId && environ(pid).get("BUSYBOY_VERIFY_ID") !== verifyId) return false;
  return true;
}

export async function stopProcess(
  pid: number | null,
  executable: string | null,
  mark: string | null = null,
  verifyId: string | null = null,
) {
  if (!matchesProcess(pid, executable, mark, verifyId)) return;
  if (!pid || !ancestorPids(pid).includes(process.pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await delay(50);
  }
  if (matchesProcess(pid, executable, mark, verifyId) && ancestorPids(pid).includes(process.pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return;
    }
  }
}

export function environ(pid: number) {
  const map = new Map<string, string>();
  try {
    const raw = readFileSync(`/proc/${pid}/environ`).toString("utf8");
    for (const entry of raw.split("\0")) {
      const eq = entry.indexOf("=");
      if (eq <= 0) continue;
      map.set(entry.slice(0, eq), entry.slice(eq + 1));
    }
  } catch {
    return map;
  }
  return map;
}

function parentPid(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const ppid = Number(stat.slice(close + 2).split(" ")[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

export function descendantPids(rootPid: number) {
  const byParent = new Map<number, number[]>();
  let entries: string[] = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const parent = parentPid(pid);
    if (!parent) continue;
    const list = byParent.get(parent);
    if (list) list.push(pid);
    else byParent.set(parent, [pid]);
  }
  const found: number[] = [];
  const stack = [...(byParent.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    found.push(pid);
    for (const child of byParent.get(pid) ?? []) stack.push(child);
  }
  return found;
}

export function ancestorPids(pid: number) {
  const chain = [pid];
  let current = pid;
  for (let guard = 0; guard < 32; guard += 1) {
    const parent = parentPid(current);
    if (!parent || parent === current || parent === 1) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

const LOOPBACK = new Set(["0100007F", "00000000000000000000000001000000"]);

export type Listener = { pid: number; loopback: boolean; local: string };

export function listenersOn(port: number): Listener[] {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Map<string, { loopback: boolean; local: string }>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10 || parts[3] !== "0A") continue;
      const local = parts[1] ?? "";
      const colon = local.lastIndexOf(":");
      if (colon < 0 || local.slice(colon + 1).toUpperCase() !== hexPort) continue;
      const ip = local.slice(0, colon).toUpperCase();
      inodes.set(parts[9] ?? "", { loopback: LOOPBACK.has(ip), local });
    }
  }
  if (inodes.size === 0) return [];
  const found: Listener[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const fdDir = `/proc/${entry}/fd`;
    let fds: string[];
    try {
      fds = readdirSync(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = readlinkSync(join(fdDir, fd));
      } catch {
        continue;
      }
      const match = /^socket:\[(\d+)\]$/.exec(link);
      const inode = match ? inodes.get(match[1] ?? "") : undefined;
      if (!inode) continue;
      found.push({ pid: Number(entry), loopback: inode.loopback, local: inode.local });
      break;
    }
  }
  return found;
}

export function evidencePath(outDir: string, input: string) {
  if (!input) throw new Error("Pass a file path inside the output folder.");
  const root = resolve(outDir);
  const resolved = resolve(root, input);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Evidence must stay inside ${root}.`);
  }
  if (resolved === root) throw new Error("Evidence path must be a file inside the output folder.");
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

export function removeOwnedData(session: Session) {
  const marker = join(session.dataDir, "verify.json");
  let owned = false;
  try {
    const body = JSON.parse(readFileSync(marker, "utf8")) as { pid?: number; purpose?: string };
    owned = body.purpose === "busyboy-verify" && body.pid === session.pid;
  } catch {
    owned = false;
  }
  if (!owned) return;
  rmSync(session.dataDir, { recursive: true, force: true });
}

export function outputDir(value: string | undefined) {
  const raw = value || process.env.BUSYBOY_VERIFY_OUT;
  if (!raw) throw new Error("Pass --out <dir> or set BUSYBOY_VERIFY_OUT.");
  if (!isAbsolute(raw) && raw.split(/[\\/]/).includes("..")) {
    throw new Error("The output folder must not climb out of the current directory with ..");
  }
  return resolve(raw);
}
