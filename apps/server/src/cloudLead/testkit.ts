/** In-memory fakes for the cloud lead tests. */
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
    snapshotState: async (id) => snapshots[id] ?? "missing",
    masker: () => makeSecretMasker([]),
  };
};
