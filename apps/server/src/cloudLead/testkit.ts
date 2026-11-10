// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
/** In-memory fakes for the cloud lead tests. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";

import type { LocalHost } from "./LocalHost.ts";
import type {
  CommandResult,
  RunCommandInput,
  SandboxClient,
  SandboxFile,
  SandboxHandle,
  SnapshotState,
} from "./SandboxClient.ts";
import { makeSecretMasker } from "./secretMask.ts";

export const fakeLocalHost = (input: {
  readonly files: Record<string, string>;
  readonly exec?: Record<string, string>;
}): LocalHost & {
  readonly written: Record<string, string>;
  readonly execCalls: Array<{ readonly command: string; readonly cwd?: string | undefined }>;
} => {
  const files = new Map(Object.entries(input.files));
  const written: Record<string, string> = {};
  const execCalls: Array<{ command: string; cwd?: string | undefined }> = [];
  return {
    written,
    execCalls,
    readFile: async (path) => {
      const content = files.get(path);
      return content === undefined ? null : Buffer.from(content);
    },
    writeFile: async (path, content) => {
      files.set(path, content);
      written[path] = content;
    },
    listFiles: async (dir) =>
      [...files.keys()]
        .filter((path) => path.startsWith(`${dir}/`))
        .map((path) => path.slice(dir.length + 1))
        .sort(),
    exec: async (cmd, args, options) => {
      const command = [cmd, ...args].join(" ");
      execCalls.push({ command, cwd: options?.cwd });
      return { exitCode: 0, stdout: input.exec?.[command] ?? "" };
    },
    firstMatchingLine: async () => {
      throw new Error("not used");
    },
    env: {},
  };
};

export interface FakeSandbox extends SandboxHandle {
  readonly files: Map<string, Buffer>;
  readonly commands: Array<RunCommandInput>;
  readonly writes: Array<ReadonlyArray<SandboxFile>>;
  readonly deleted: () => boolean;
}

export const fakeSandbox = (
  options: {
    readonly name?: string;
    readonly respond?: (input: RunCommandInput) => Partial<CommandResult>;
  } = {},
): FakeSandbox => {
  const files = new Map<string, Buffer>();
  const commands: Array<RunCommandInput> = [];
  const writes: Array<ReadonlyArray<SandboxFile>> = [];
  let deleted = false;
  const runCommand = async (input: RunCommandInput): Promise<CommandResult> => {
    commands.push(input);
    return { exitCode: 0, stdout: "", stderr: "", ...options.respond?.(input) };
  };
  return {
    name: options.name ?? "fake",
    sessionId: `${options.name ?? "fake"}-session`,
    expiresAt: undefined,
    files,
    commands,
    writes,
    deleted: () => deleted,
    runCommand,
    sh: async (script, rest = {}) => {
      const result = await runCommand({ ...rest, cmd: "bash", args: ["-lc", script] });
      if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}`);
      return result.stdout;
    },
    writeFiles: async (batch) => {
      writes.push(batch);
      for (const file of batch) files.set(file.path, file.content);
    },
    startDetached: async (input) => void (await runCommand(input)),
    domain: (port) => `https://${options.name ?? "fake"}-${port}.example.test`,
    extendTimeout: async () => undefined,
    readFile: async (path) => files.get(path) ?? null,
    snapshot: async () => ({ snapshotId: `snap-${commands.length}`, sizeBytes: 1 }),
    stop: async () => undefined,
    delete: async () => {
      deleted = true;
    },
  };
};

export const fakeSandboxClient = (
  snapshots: Record<string, SnapshotState> = {},
): SandboxClient & { readonly created: FakeSandbox[] } => {
  const created: FakeSandbox[] = [];
  return {
    created,
    create: async () => {
      const sandbox = fakeSandbox({ name: `sbx-${created.length}` });
      created.push(sandbox);
      return sandbox;
    },
    get: async (name) => fakeSandbox({ name }),
    status: async () => "running",
    relayCredential: async () => {
      throw new Error("no relay credential in tests");
    },
    snapshotState: async (id) => snapshots[id] ?? "missing",
    masker: () => makeSecretMasker([]),
  };
};

export type LocalSandbox = SandboxHandle & {
  readonly home: string;
  readonly deleted: () => boolean;
  readonly stopped: () => boolean;
  /** What an SDK call on a stopped persistent sandbox does: start a new session. */
  readonly resume: () => void;
};

/**
 * A "sandbox" that is a temp directory on this machine: commands run with
 * HOME set to it, files land at their absolute paths, and detached commands
 * (the relay) run as local processes. With `binDir` first on PATH, a fake
 * `claude` script answers the relay's spawn. Lets the cloud runtime run end
 * to end in tests without Vercel.
 */
export const localSandboxClient = (input: {
  /** Makes the sandbox home, e.g. clones the repo into <home>/busyboy. */
  readonly makeHome: (home: string) => Promise<void>;
  readonly binDir: string;
  /** The relay's Vercel credential; absent, the runtime falls back to Mac keep-alive. */
  readonly relayCredential?: SandboxClient["relayCredential"];
}): SandboxClient & {
  readonly created: Array<LocalSandbox>;
  /** Names passed to get, with whether they asked to resume. */
  readonly gets: Array<{ readonly name: string; readonly resume: boolean }>;
} => {
  const created: Array<LocalSandbox> = [];
  const gets: Array<{ name: string; resume: boolean }> = [];
  const children: NodeChildProcess.ChildProcess[] = [];
  const env = (home: string, extra: Readonly<Record<string, string>> = {}) => ({
    ...process.env,
    HOME: home,
    PATH: `${input.binDir}:${process.env.PATH ?? ""}`,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    GIT_CONFIG_GLOBAL: `${home}/.gitconfig`,
    ...extra,
  });
  const run = (home: string, command: RunCommandInput) =>
    new Promise<CommandResult>((resolve) => {
      NodeChildProcess.execFile(
        command.cmd,
        [...(command.args ?? [])],
        {
          cwd: command.cwd ?? home,
          env: env(home, command.env),
          maxBuffer: 64 * 1024 * 1024,
          encoding: "buffer",
        },
        (error, stdout, stderr) =>
          resolve({
            exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
            stdout: stdout.toString("utf8"),
            stderr: stderr.toString("utf8"),
          }),
      );
    });
  return {
    created,
    create: async (options) => {
      const home = await NodeFs.mkdtemp(`${NodeOs.tmpdir()}/sbx-home-`);
      await input.makeHome(home);
      let deleted = false;
      let stopped = false;
      let session = 0;
      const runCommand = (command: RunCommandInput) => run(home, command);
      const ports = options.ports ?? [];
      const name = `local-${created.length}`;
      const handle: LocalSandbox = {
        name,
        get sessionId() {
          return `${name}-session-${session}`;
        },
        expiresAt: undefined,
        home,
        deleted: () => deleted,
        stopped: () => stopped,
        resume: () => {
          if (!stopped) return;
          stopped = false;
          session += 1;
        },
        runCommand,
        sh: async (script: string, rest: Omit<RunCommandInput, "cmd" | "args"> = {}) => {
          const result = await runCommand({ ...rest, cmd: "bash", args: ["-c", script] });
          if (result.exitCode !== 0) {
            throw new Error(`exit ${result.exitCode}: ${result.stderr.slice(-2000)}`);
          }
          return result.stdout;
        },
        writeFiles: async (files: ReadonlyArray<SandboxFile>) => {
          for (const file of files) {
            await NodeFs.mkdir(file.path.slice(0, file.path.lastIndexOf("/")), { recursive: true });
            await NodeFs.writeFile(file.path, file.content);
          }
        },
        startDetached: async (command: RunCommandInput) => {
          const child = NodeChildProcess.spawn(command.cmd, [...(command.args ?? [])], {
            cwd: command.cwd ?? home,
            env: env(home, command.env),
            stdio: "ignore",
          });
          children.push(child);
          // Give the relay a moment to listen; the client retries anyway.
          await new Promise((resolve) => setTimeout(resolve, 200));
        },
        domain: (port: number) => {
          if (!ports.includes(port)) throw new Error(`Port ${port} is not exposed`);
          return `http://127.0.0.1:${port}`;
        },
        readFile: (path: string) => NodeFs.readFile(path).catch(() => null),
        extendTimeout: async () => undefined,
        snapshot: async () => ({ snapshotId: "local", sizeBytes: 0 }),
        // Like a VM stop: its processes end, its files stay.
        stop: async () => {
          stopped = true;
          for (const child of children.splice(0)) child.kill("SIGKILL");
          await run(home, { cmd: "pkill", args: ["-KILL", "-f", home] });
        },
        delete: async () => {
          deleted = true;
          for (const child of children.splice(0)) child.kill("SIGKILL");
          await run(home, { cmd: "pkill", args: ["-KILL", "-f", home] });
          await NodeFs.rm(home, { recursive: true, force: true });
        },
      };
      created.push(handle);
      return handle;
    },
    gets,
    get: async (name, options = {}) => {
      gets.push({ name, resume: options.resume === true });
      const found = created.find((sandbox) => sandbox.name === name && !sandbox.deleted());
      if (found === undefined) throw new Error(`No sandbox ${name}`);
      if (options.resume === true) found.resume();
      return found;
    },
    status: async (name) => {
      const found = created.find((sandbox) => sandbox.name === name && !sandbox.deleted());
      return found === undefined ? "missing" : found.stopped() ? "stopped" : "running";
    },
    relayCredential:
      input.relayCredential ??
      (async () => {
        throw new Error("no relay credential in tests");
      }),
    snapshotState: async () => "missing",
    masker: () => makeSecretMasker([]),
  };
};
