// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// The cloud lead modules are promise-based like the @vercel/sandbox SDK they
// drive; this is their only door to the Mac's filesystem and processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs/promises";

/** Joins POSIX path segments; cloud leads only run from macOS or Linux. */
export const joinPath = (...segments: ReadonlyArray<string>): string =>
  segments
    .filter((segment) => segment.length > 0)
    .join("/")
    .replace(/\/{2,}/g, "/");

export interface LocalHost {
  readonly readFile: (path: string) => Promise<Buffer | null>;
  /** Writes the file, creating parent directories. */
  readonly writeFile: (path: string, content: string) => Promise<void>;
  /** Files under dir, relative to it, skipping .git and node_modules. Empty when dir is missing. */
  readonly listFiles: (dir: string) => Promise<ReadonlyArray<string>>;
  readonly exec: (
    cmd: string,
    args: ReadonlyArray<string>,
    options?: { readonly cwd?: string },
  ) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
  /**
   * Starts a process and resolves with the first stdout line that matches,
   * then kills the process.
   */
  readonly firstMatchingLine: (input: {
    readonly cmd: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly match: (line: string) => boolean;
    readonly timeoutMs: number;
  }) => Promise<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const SKIPPED_DIRS = new Set([".git", "node_modules"]);

const listFilesRecursive = async (dir: string, prefix: string): Promise<string[]> => {
  const entries = await NodeFs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];
  const out: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      out.push(...(await listFilesRecursive(joinPath(dir, entry.name), relative)));
    } else if (entry.isFile()) {
      out.push(relative);
    }
  }
  return out;
};

export const nodeLocalHost: LocalHost = {
  readFile: (path) => NodeFs.readFile(path).catch(() => null),
  writeFile: async (path, content) => {
    const slash = path.lastIndexOf("/");
    if (slash > 0) await NodeFs.mkdir(path.slice(0, slash), { recursive: true });
    await NodeFs.writeFile(path, content);
  },
  listFiles: async (dir) => (await listFilesRecursive(dir, "")).sort(),
  exec: (cmd, args, options = {}) =>
    new Promise((resolve) => {
      NodeChildProcess.execFile(
        cmd,
        [...args],
        { cwd: options.cwd, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
          resolve({ exitCode: code, stdout: String(stdout) });
        },
      );
    }),
  firstMatchingLine: (input) =>
    new Promise((resolve, reject) => {
      // Its own process group, so the MCP servers claude starts are stopped with it.
      const child = NodeChildProcess.spawn(input.cmd, [...input.args], {
        cwd: input.cwd,
        env: { ...input.env },
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
      });
      const killGroup = (signal: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, signal);
        } catch {
          // Already gone.
        }
      };
      let buffer = "";
      let settled = false;
      const finish = (run: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), 2000).unref();
        run();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`${input.cmd} printed no matching line in time`))),
        input.timeoutMs,
      );
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (input.match(line)) return finish(() => resolve(line));
          newline = buffer.indexOf("\n");
        }
      });
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", () =>
        finish(() => reject(new Error(`${input.cmd} exited before a matching line`))),
      );
    }),
  env: process.env,
};
