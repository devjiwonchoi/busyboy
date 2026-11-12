// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CloudLeadRuntime,
  type CloudLeadRotationHandler,
  type CloudLeadRuntimeDeps,
  type CloudLeadOfflineHandler,
} from "./CloudLeadRuntime.ts";
import { encodeProjectDir } from "./pathRewrite.ts";
import { RelayClient, type RemoteProcess } from "./RelayClient.ts";
import { memoryCloudSessionStore } from "./CloudSessionStore.ts";
import { fakeLocalHost, localSandboxClient } from "./testkit.ts";
import { localMirrorShell } from "./WorkspaceMirror.ts";

const CLAUDE_TOKEN = "sk-ant-oat01-cloud-lead-test-token";
const GITHUB_TOKEN = "gho_cloudleadtesttoken0123456789";
const shell = localMirrorShell();
const cleanups: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const tempDir = async (prefix: string) => {
  const dir = await NodeFs.mkdtemp(`${NodeOs.tmpdir()}/${prefix}`);
  cleanups.push(() => NodeFs.rm(dir, { recursive: true, force: true }));
  return dir;
};

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      server.close(() => resolve(port));
    });
  });

const GIT_ENV =
  "export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t";

/**
 * The sandbox's claude: prints its argv, cwd and the env the runtime set, then
 * treats each stdin line as a turn. "commit <file>" writes and commits a file,
 * "edit <file>" leaves an uncommitted change.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const say = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
say({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  home: process.env.HOME,
  token: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  gh: process.env.GH_TOKEN,
  apiKey: process.env.ANTHROPIC_API_KEY ?? null,
  entry: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
  relayToken: process.env.BUSYBOY_RELAY_TOKEN ?? null,
});
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const [verb, file] = buffer.slice(0, index).split(" ");
    buffer = buffer.slice(index + 1);
    fs.writeFileSync(file, verb + "\\n");
    if (verb === "commit") execSync("git add -A && git commit -qm 'Add " + file + "'");
    say({ done: verb, file });
  }
});
// --linger: keep running after input ends, like a claude still finishing its turn.
process.stdin.on("end", () => {
  if (process.argv.includes("--linger")) setInterval(() => {}, 1000);
  else process.exit(0);
});
`;

/**
 * The sandbox's codex: `login status` passes when the cloud login is in
 * CODEX_HOME; otherwise it prints how it was started, echoes each stdin line,
 * and "refresh" rewrites the login the way a token refresh does.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const authPath = process.env.CODEX_HOME + "/auth.json";
const args = process.argv.slice(2);
if (args.includes("login")) {
  const ok = fs.existsSync(authPath) && fs.readFileSync(authPath, "utf8").includes("valid");
  process.stdout.write(ok ? "Logged in using ChatGPT\\n" : "Not logged in\\n");
  process.exit(ok ? 0 : 1);
}
const say = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
say({
  argv: args,
  cwd: process.cwd(),
  codexHome: process.env.CODEX_HOME,
  auth: fs.readFileSync(authPath, "utf8"),
  authEnv: process.env.BUSYBOY_CODEX_AUTH ?? null,
  apiKey: process.env.OPENAI_API_KEY ?? null,
});
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line === "refresh") fs.writeFileSync(authPath, '{"tokens":{"refresh_token":"valid-refreshed"}}');
    say({ got: line });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const setup = async (
  options: {
    readonly idleStopMs?: number;
    readonly macShell?: typeof shell;
    readonly runtime?: Partial<CloudLeadRuntimeDeps>;
    readonly codexAuth?: { value: string | null; saved: string[] };
  } = {},
) => {
  const root = await tempDir("cloud-runtime-");
  const macHome = `${root}/mac-home`;
  const mac = `${macHome}/worktrees/task`;
  const binDir = `${root}/bin`;
  await NodeFs.mkdir(binDir, { recursive: true });
  await NodeFs.writeFile(`${binDir}/claude`, FAKE_CLAUDE, { mode: 0o755 });
  await NodeFs.writeFile(`${binDir}/codex`, FAKE_CODEX, { mode: 0o755 });
  await shell.run(
    `mkdir -p '${mac}' && cd '${mac}' && ${GIT_ENV} && git init -q -b main && echo base > base.txt && git add . && git commit -qm base && git checkout -qb t3/task && echo mac > mac.txt && git add . && git commit -qm 'Mac commit' && echo wip >> base.txt`,
  );
  const baseCommit = (await shell.run(`git -C '${mac}' rev-parse main`)).trim();
  // Like the base snapshot: a clone of the repo, detached at an older main commit.
  const client = localSandboxClient({
    binDir,
    makeHome: async (home) => {
      await shell.run(
        `git clone -q '${mac}' '${home}/busyboy' && git -C '${home}/busyboy' checkout -q --detach ${baseCommit}`,
      );
    },
  });
  // The Mac's t3-code MCP endpoint.
  const mcpCalls: Array<{ url: string; auth: string | undefined }> = [];
  const mcp = NodeHttp.createServer((request, response) => {
    mcpCalls.push({ url: request.url ?? "", auth: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => new Promise((resolve) => mcp.close(resolve)));
  const mcpEndpoint = `http://127.0.0.1:${(mcp.address() as NodeNet.AddressInfo).port}/mcp`;
  const ports = { relay: await freePort(), mcp: await freePort() };
  const makeRuntime = (extra: Partial<CloudLeadRuntimeDeps> = {}) => {
    const made = new CloudLeadRuntime({
      client: async () => client,
      credentials: async () => ({ claudeOauthToken: CLAUDE_TOKEN, githubToken: GITHUB_TOKEN }),
      baseSnapshotId: async () => null,
      host: {
        ...fakeLocalHost({
          files: {
            [`${macHome}/.codex/config.toml`]: `model = "gpt-6.1-sol"\n[projects."${mac}"]\n`,
          },
        }),
        env: { HOME: macHome },
      },
      stateDir: `${root}/state`,
      ports,
      ...(options.idleStopMs === undefined ? {} : { idleStopMs: options.idleStopMs }),
      ...(options.macShell === undefined ? {} : { macShell: options.macShell }),
      ...options.runtime,
      ...(options.codexAuth === undefined
        ? {}
        : {
            codexAuth: {
              read: async () => options.codexAuth!.value,
              save: async (value: string) => {
                options.codexAuth!.saved.push(value);
                options.codexAuth!.value = value;
              },
            },
          }),
      ...extra,
    });
    cleanups.push(() => made.releaseAll());
    return made;
  };
  const runtime = makeRuntime();
  return { mac, macHome, client, runtime, makeRuntime, mcpEndpoint, mcpCalls, ports };
};

const lines = (child: RemoteProcess) => {
  const seen: Array<Record<string, unknown>> = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      seen.push(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>);
      buffer = buffer.slice(index + 1);
    }
  });
  return seen;
};

const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 10_000) => {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("CloudLeadRuntime after a server restart", () => {
  it("retries failed replay without acknowledging it and refreshes the kit after applying", async () => {
    const { mac, runtime, mcpEndpoint } = await setup();
    await runtime.prepare({
      threadId: "lead",
      worktreePath: mac,
      mcpEndpoint,
      mcpAuthorization: "Bearer secret",
    });
    const session = await runtime["sessions"].get(mac)!;
    const entry = {
      seq: 1,
      at: 1_000,
      kind: "call" as const,
      threadId: "lead",
      taskId: "task",
      tool: "task_todo_set",
      args: { todoId: "todo", done: true },
    };
    const apply = vi
      .fn<CloudLeadOfflineHandler["apply"]>()
      .mockRejectedValueOnce(new Error("replay defect"))
      .mockResolvedValue(undefined);
    const kit = vi.fn<CloudLeadOfflineHandler["kit"]>(async () => ({
      threads: [],
      specs: {},
      models: {},
      tools: [],
    }));
    // Set directly: setOfflineHandler would also start a replay of its own.
    runtime["offlineHandler"] = { kit, apply };
    const requests = vi
      .spyOn(session.relay, "requestControl")
      .mockResolvedValue({ ch: "ctl", op: "journal", entries: [entry] });
    const controls = vi.spyOn(session.relay, "sendControl");
    try {
      await expect(runtime["replayJournal"](session)).rejects.toThrow("replay defect");
      expect(controls.mock.calls).toEqual([]);
      expect(kit).toHaveBeenCalledTimes(0);
      await runtime["replayJournal"](session);
      expect(apply).toHaveBeenCalledTimes(2);
      expect(controls.mock.calls.map(([message]) => message.op)).toEqual([
        "journal-applied",
        "offline-kit",
      ]);
      expect(kit).toHaveBeenCalledTimes(1);
    } finally {
      requests.mockRestore();
      controls.mockRestore();
    }
  });

  it("sends the offline kit with the token hash after prepare", async () => {
    const { mac, runtime, mcpEndpoint } = await setup();
    const controls = vi.spyOn(RelayClient.prototype, "sendControl");
    try {
      const kit = vi.fn<CloudLeadOfflineHandler["kit"]>(async ({ threads }) => ({
        threads: threads.map((thread) => ({ ...thread, taskId: "task", role: "lead" as const })),
        specs: {},
        models: {},
        tools: [],
      }));
      runtime.setOfflineHandler({ kit, apply: async () => undefined });
      await runtime.prepare({
        threadId: "lead",
        worktreePath: mac,
        mcpEndpoint,
        mcpAuthorization: "Bearer secret",
      });
      expect(kit).toHaveBeenCalledWith({
        worktreeKey: mac,
        threads: [
          { threadId: "lead", tokenSha256: createHash("sha256").update("secret").digest("hex") },
        ],
      });
      expect(
        controls.mock.calls
          .map(([message]) => message)
          .find((message) => message.op === "offline-kit"),
      ).toMatchObject({
        op: "offline-kit",
        processes: [],
        threads: [
          {
            threadId: "lead",
            taskId: "task",
            role: "lead",
            tokenSha256: createHash("sha256").update("secret").digest("hex"),
          },
        ],
      });
    } finally {
      controls.mockRestore();
    }
  });

  it("attaches to the same sandbox, lets the old claude finish its turn, and mirrors its work", async () => {
    const store = memoryCloudSessionStore();
    const { mac, client, makeRuntime, mcpEndpoint } = await setup({ runtime: { store } });
    const before = makeRuntime({ store });
    const launch = await before.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    const child = launch.spawn({
      command: "claude",
      args: ["--resume", "claude-session-1"],
      env: {},
    });
    const output = lines(child);
    await waitFor(() => output.length > 0);

    const [record] = await store.list();
    expect(record).toMatchObject({
      worktreeKey: mac,
      threadId: "lead",
      sandboxName: "local-0",
      processes: [{ threadId: "lead", claudeSessionId: "claude-session-1" }],
    });
    expect(store.tokens.get(record!.relayTokenRef)?.length).toBeGreaterThanOrEqual(32);

    // A turn commits in the sandbox, and the Mac server stops before mirroring it.
    child.stdin.write("commit late.txt\n");
    await waitFor(() => output.some((line) => line.file === "late.txt"));
    await before.detachAll();
    expect(client.created[0]!.deleted()).toBe(false);

    // The next server attaches to the recorded sandbox; no new one is made.
    const after = makeRuntime({ store });
    await after.restore();
    expect(client.created).toHaveLength(1);
    expect(client.gets).toEqual([{ name: "local-0", resume: true }]);
    expect((await shell.run(`git -C '${mac}' log --format=%s -1`)).trim()).toBe("Add late.txt");

    // The old claude got end of input and finished; the next turn resumes in the same sandbox.
    const next = await after.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    expect((await store.list())[0]!.processes).toEqual([]);
    const resumed = next.spawn({
      command: "claude",
      args: ["--resume", "claude-session-1"],
      env: {},
    });
    const resumedOutput = lines(resumed);
    await waitFor(() => resumedOutput.length > 0);
    expect(resumedOutput[0]!.argv).toEqual(["--resume", "claude-session-1"]);
    expect(client.created).toHaveLength(1);
    resumed.stdin.end();

    await after.release("lead");
    expect(await store.list()).toEqual([]);
    expect(store.tokens.size).toBe(0);
  });

  it("resumes a sandbox that stopped itself and starts its relay again", async () => {
    const store = memoryCloudSessionStore();
    const { mac, client, makeRuntime, mcpEndpoint } = await setup();
    const before = makeRuntime({ store });
    await before.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    await before.detachAll();
    // The relay stopped its idle sandbox: processes gone, files kept.
    await client.created[0]!.stop();

    const after = makeRuntime({ store });
    const launch = await after.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    expect(client.created).toHaveLength(1);
    expect(client.created[0]!.stopped()).toBe(false);
    expect(client.gets).toEqual([{ name: "local-0", resume: true }]);
    const child = launch.spawn({ command: "claude", args: [], env: {} });
    const output = lines(child);
    await waitFor(() => output.length > 0);
    child.stdin.end();
  });

  it("mirrors and then releases a sandbox that stopped while the Mac slept", async () => {
    const store = memoryCloudSessionStore();
    const { mac, client, makeRuntime, mcpEndpoint } = await setup();
    const runtime = makeRuntime({ store, relayGiveUpAfterMs: 50 });
    const launch = await runtime.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    const child = launch.spawn({ command: "claude", args: [], env: {} });
    const output = lines(child);
    child.stdin.write("commit asleep.txt\n");
    await waitFor(() => output.some((line) => line.file === "asleep.txt"));
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    // The relay stops its idle sandbox; the Mac finds it stopped and lets go.
    await client.created[0]!.stop();
    await waitFor(() => !runtime.hasSession("lead"), 20_000);
    expect(await store.list()).toHaveLength(1);

    // A move to the Mac mirrors by worktree: the stopped sandbox is resumed and its work copied.
    await runtime.syncToMac(mac);
    expect((await shell.run(`git -C '${mac}' log --format=%s -1`)).trim()).toBe("Add asleep.txt");
    expect(client.created).toHaveLength(1);

    await runtime.release(mac);
    expect(client.created[0]!.deleted()).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it("fails a move to the Mac when the recorded sandbox cannot be reached, and keeps its record", async () => {
    const store = memoryCloudSessionStore();
    const { mac, client, makeRuntime, mcpEndpoint } = await setup();
    const before = makeRuntime({ store });
    await before.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    await before.detachAll();

    // Vercel is briefly unreachable when the next server tries to attach.
    const unreachable = makeRuntime({
      store,
      client: async () => ({
        ...client,
        get: async () => {
          throw new Error("Vercel API answered 503");
        },
      }),
    });
    await expect(unreachable.syncToMac(mac)).rejects.toThrow("503");
    await unreachable.release(mac);
    expect((await store.list()).map((record) => record.sandboxName)).toEqual(["local-0"]);
    expect(client.created[0]!.deleted()).toBe(false);

    // Once Vercel answers again, the same sandbox is mirrored and released.
    const after = makeRuntime({ store });
    await after.syncToMac(mac);
    await after.release(mac);
    expect(client.created[0]!.deleted()).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it("ends what a dead relay left running before a new turn resumes its session", async () => {
    const store = memoryCloudSessionStore();
    const { mac, client, makeRuntime, mcpEndpoint } = await setup();
    const before = makeRuntime({ store });
    const launch = await before.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    const session = `leftover-${Date.now()}`;
    const child = launch.spawn({
      command: "claude",
      args: ["--session-id", session, "--linger"],
      env: {},
    });
    const output = lines(child);
    await waitFor(() => output.length > 0);
    await before.detachAll();
    // The relay dies on its own; its claude keeps running.
    const home = client.created[0]!.home;
    await shell.run(`pkill -f '${home}/.busyboy-cloud/relay/server.ts' || true`);
    expect((await shell.run(`pgrep -f -- '${session}' || true`)).trim()).not.toBe("");

    const after = makeRuntime({ store });
    await after.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    await waitFor(async () => (await shell.run(`pgrep -f -- '${session}' || true`)).trim() === "");
    expect(client.created).toHaveLength(1);
  });

  it("never mirrors a recorded sandbox over Mac work it does not have", async () => {
    const store = memoryCloudSessionStore();
    const { mac, client, makeRuntime, mcpEndpoint } = await setup();
    const before = makeRuntime({ store });
    await before.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    await before.detachAll();
    // Its relay stopped it once idle (local sandboxes share the relay port).
    await client.created[0]!.stop();
    // The task came back to the Mac and got a commit the sandbox never saw.
    await shell.run(
      `cd '${mac}' && ${GIT_ENV} && echo local > local.txt && git add . && git commit -qm 'Mac work'`,
    );

    const after = makeRuntime({ store });
    await after.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    expect((await shell.run(`git -C '${mac}' log --format=%s -1`)).trim()).toBe("Mac work");
    expect(client.created).toHaveLength(2);
    expect(client.created[0]!.deleted()).toBe(false);
    expect((await store.list()).map((record) => record.sandboxName)).toEqual(["local-1"]);
    await client.created[0]!.delete();
  });

  it("leaves a recorded sandbox stopped when the Mac has uncommitted edits it does not have", async () => {
    const store = memoryCloudSessionStore();
    const { mac, client, makeRuntime, mcpEndpoint } = await setup();
    const before = makeRuntime({ store });
    await before.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    await before.detachAll();
    // Back on the Mac, the user edits a file without committing; HEAD stays the same.
    await shell.run(`cd '${mac}' && echo 'Mac edit' >> base.txt && echo new > untracked.txt`);

    const after = makeRuntime({ store });
    await after.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    expect(await NodeFs.readFile(`${mac}/base.txt`, "utf8")).toContain("Mac edit");
    expect(await NodeFs.readFile(`${mac}/untracked.txt`, "utf8")).toBe("new\n");
    // A new sandbox from the Mac; the old one is stopped (files kept), not left billing.
    expect(client.created).toHaveLength(2);
    expect(client.created[0]!.stopped()).toBe(true);
    expect(client.created[0]!.deleted()).toBe(false);
    expect((await store.list()).map((record) => record.sandboxName)).toEqual(["local-1"]);
    await client.created[0]!.delete();
  });

  it("keeps a new untracked Mac file and leaves the recorded sandbox stopped", async () => {
    const store = memoryCloudSessionStore();
    const { mac, client, makeRuntime, mcpEndpoint } = await setup();
    const before = makeRuntime({ store });
    await before.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    await before.detachAll();
    // Back on the Mac, the user starts a new file without adding it to git.
    await shell.run(`echo draft > '${mac}/new.ts'`);

    const after = makeRuntime({ store });
    await after.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    expect(await NodeFs.readFile(`${mac}/new.ts`, "utf8")).toBe("draft\n");
    expect(client.created).toHaveLength(2);
    expect(client.created[0]!.stopped()).toBe(true);
    await client.created[0]!.delete();
  });

  it("keeps the recorded sandbox when the Mac only gained ignored build output after a mirror", async () => {
    const store = memoryCloudSessionStore();
    const { mac, client, makeRuntime, mcpEndpoint } = await setup();
    const before = makeRuntime({ store });
    const launch = await before.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    const child = launch.spawn({ command: "claude", args: [], env: {} });
    const output = lines(child);
    child.stdin.write("commit cloud.txt\n");
    await waitFor(() => output.some((line) => line.file === "cloud.txt"));
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    await before.syncToMac(mac);
    // A gate ran tests on the Mac and left ignored output behind; then the server stopped.
    await shell.run(
      `mkdir -p '${mac}/coverage' && echo report > '${mac}/coverage/index.html' && echo coverage/ >> '${mac}/.git/info/exclude'`,
    );
    await before.detachAll();

    const after = makeRuntime({ store });
    await after.restore();
    expect(client.created).toHaveLength(1);
    expect(client.created[0]!.stopped()).toBe(false);
    expect((await store.list()).map((record) => record.sandboxName)).toEqual(["local-0"]);
    expect((await shell.run(`git -C '${mac}' log --format=%s -1`)).trim()).toBe("Add cloud.txt");
  });

  it("asks a fresh Vercel client for the relay's credential and whether the sandbox lives", async () => {
    const { mac, client, makeRuntime, mcpEndpoint } = await setup();
    let current: typeof client = client;
    const runtime = makeRuntime({
      client: async () => current,
      relayGiveUpAfterMs: 50,
      relayCredentialEveryMs: 50,
    });
    await runtime.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    // The Mac's Vercel login renewed: later calls must use the new client.
    const calls: string[] = [];
    current = {
      ...client,
      status: async (name) => {
        calls.push("status");
        return client.status(name);
      },
      relayCredential: async () => {
        calls.push("credential");
        throw new Error("no relay credential in tests");
      },
    };
    await waitFor(() => calls.includes("credential"));
    await client.created[0]!.stop();
    await waitFor(() => calls.includes("status"), 20_000);
  });

  it("starts a new sandbox when the recorded one is gone", async () => {
    const store = memoryCloudSessionStore();
    const { mac, client, makeRuntime, mcpEndpoint } = await setup();
    const before = makeRuntime({ store });
    await before.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    await before.detachAll();
    await client.created[0]!.delete();

    const after = makeRuntime({ store });
    await after.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    expect(client.created).toHaveLength(2);
    expect((await store.list()).map((record) => record.sandboxName)).toEqual(["local-1"]);
  });
});

describe("CloudLeadRuntime", () => {
  it("runs claude in the sandbox on the Mac branch and mirrors its work back", async () => {
    const { mac, macHome, client, runtime, mcpEndpoint, mcpCalls, ports } = await setup();

    const launch = await runtime.prepare({ threadId: "thread-1", worktreePath: mac, mcpEndpoint });
    const sandbox = client.created[0]!;
    const remote = `${sandbox.home}/busyboy`;

    // The sandbox clone is on the Mac branch with the Mac commit and edit.
    expect((await shell.run(`git -C '${remote}' symbolic-ref --short HEAD`)).trim()).toBe(
      "t3/task",
    );
    expect(await NodeFs.readFile(`${remote}/mac.txt`, "utf8")).toBe("mac\n");
    expect(await NodeFs.readFile(`${remote}/base.txt`, "utf8")).toBe("base\nwip\n");

    // The adapter's spawn options, as the SDK passes them on the Mac.
    const child = launch.spawn({
      command: `${macHome}/.local/bin/claude`,
      args: ["--add-dir", mac, "--output-format", "stream-json"],
      cwd: mac,
      env: {
        PATH: "/mac/bin",
        HOME: macHome,
        ANTHROPIC_API_KEY: "mac-api-key",
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      },
    });
    const output = lines(child);
    await waitFor(() => output.length > 0);
    expect(output[0]).toEqual({
      argv: ["--add-dir", remote, "--output-format", "stream-json"],
      cwd: await NodeFs.realpath(remote),
      home: sandbox.home,
      token: CLAUDE_TOKEN,
      gh: GITHUB_TOKEN,
      apiKey: null,
      entry: "sdk-ts",
      relayToken: null,
    });

    // The sandbox's MCP requests reach the Mac endpoint through the relay.
    expect(launch.mcpUrl).toBe(`http://127.0.0.1:${ports.mcp}/mcp`);
    const response = await fetch(launch.mcpUrl, {
      method: "POST",
      headers: { authorization: "Bearer thread-cred" },
      body: "{}",
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(mcpCalls).toEqual([{ url: "/mcp", auth: "Bearer thread-cred" }]);

    // A turn commits one file and leaves another uncommitted.
    child.stdin.write("commit cloud.txt\nedit notes.txt\n");
    await waitFor(() => output.some((line) => line.file === "notes.txt"));
    await runtime.syncToMac("thread-1");

    expect((await shell.run(`git -C '${mac}' log --format=%s -1`)).trim()).toBe("Add cloud.txt");
    expect((await shell.run(`git -C '${mac}' symbolic-ref --short HEAD`)).trim()).toBe("t3/task");
    expect(await NodeFs.readFile(`${mac}/notes.txt`, "utf8")).toBe("edit\n");
    expect((await shell.run(`git -C '${mac}' rev-parse HEAD`)).trim()).toBe(
      (await shell.run(`git -C '${remote}' rev-parse HEAD`)).trim(),
    );

    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    await runtime.release("thread-1");
    expect(sandbox.deleted()).toBe(true);
  });

  it("starts a new sandbox from the Mac mirror after the old one is gone", async () => {
    const { mac, client, runtime, mcpEndpoint } = await setup();
    const first = await runtime.prepare({ threadId: "thread-2", worktreePath: mac, mcpEndpoint });
    const child = first.spawn({ command: "claude", args: [], env: {} });
    const output = lines(child);
    child.stdin.write("commit one.txt\n");
    await waitFor(() => output.some((line) => line.done === "commit"));
    await runtime.syncToMac("thread-2");
    child.stdin.end();
    await runtime.release("thread-2");

    await runtime.prepare({ threadId: "thread-2", worktreePath: mac, mcpEndpoint });
    expect(client.created).toHaveLength(2);
    const remote = `${client.created[1]!.home}/busyboy`;
    expect((await shell.run(`git -C '${remote}' log --format=%s -1`)).trim()).toBe("Add one.txt");
  });

  it("never writes the tokens into sandbox files", async () => {
    const { mac, client, runtime, mcpEndpoint } = await setup();
    await runtime.prepare({ threadId: "thread-3", worktreePath: mac, mcpEndpoint });
    const home = client.created[0]!.home;
    const found = await shell.run(
      `grep -rl -e '${CLAUDE_TOKEN}' -e '${GITHUB_TOKEN}' '${home}' --exclude-dir=.git || true`,
    );
    expect(found.trim()).toBe("");
  });

  it("stops an idle sandbox only once no claude process is running", async () => {
    const { mac, client, runtime, mcpEndpoint } = await setup({ idleStopMs: 50 });
    const launch = await runtime.prepare({ threadId: "thread-4", worktreePath: mac, mcpEndpoint });
    const child = launch.spawn({ command: "claude", args: [], env: {} });
    const output = lines(child);
    await waitFor(() => output.length > 0);
    // A mid-turn sync (a gate reading the mirror) must not stop a running turn.
    await runtime.syncToMac("thread-4");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(client.created[0]!.deleted()).toBe(false);

    child.stdin.end();
    await waitFor(() => client.created[0]!.deleted());
    expect(runtime.hasSession("thread-4")).toBe(false);
  });

  it("mirrors unsynced work before deleting a sandbox, and runs overlapping syncs one at a time", async () => {
    const { mac, client, runtime, mcpEndpoint } = await setup();
    const launch = await runtime.prepare({ threadId: "thread-5", worktreePath: mac, mcpEndpoint });
    const child = launch.spawn({ command: "claude", args: [], env: {} });
    const output = lines(child);
    child.stdin.write("commit late.txt\n");
    await waitFor(() => output.some((line) => line.file === "late.txt"));

    // A turn end, a gate and a review step can ask at once; all must succeed.
    const results = await Promise.all([
      runtime.syncToMac("thread-5"),
      runtime.syncToMac("thread-5"),
      runtime.syncToMac("thread-5"),
    ]);
    expect(new Set(results.map((result) => result?.head)).size).toBe(1);

    child.stdin.write("commit last.txt\n");
    await waitFor(() => output.some((line) => line.file === "last.txt"));
    child.stdin.end();
    // No sync since that commit: release mirrors it before the sandbox goes.
    await runtime.release("thread-5");
    expect(client.created[0]!.deleted()).toBe(true);
    expect((await shell.run(`git -C '${mac}' log --format=%s -1`)).trim()).toBe("Add last.txt");
  });

  it("keeps a sandbox that a new turn picks up while its idle stop is mirroring", async () => {
    // Holds the idle stop inside its mirror until the test lets it go.
    let hold: Promise<void> | null = null;
    let release = () => {};
    const slowMac = {
      ...shell,
      run: async (script: string) => {
        if (hold !== null && script.includes("git reset")) await hold;
        return shell.run(script);
      },
    };
    const { mac, client, runtime, mcpEndpoint } = await setup({
      idleStopMs: 50,
      macShell: slowMac,
    });
    const first = await runtime.prepare({ threadId: "thread-6", worktreePath: mac, mcpEndpoint });
    hold = new Promise<void>((resolve) => (release = resolve));
    const child = first.spawn({ command: "claude", args: [], env: {} });
    const output = lines(child);
    await waitFor(() => output.length > 0);
    child.stdin.end();
    // The process ended, so the idle stop fires and blocks in its mirror.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // A new turn arrives meanwhile.
    const second = await runtime.prepare({ threadId: "thread-6", worktreePath: mac, mcpEndpoint });
    release();
    hold = null;
    // The turn starts its claude right away, as the adapter does.
    const next = second.spawn({ command: "claude", args: [], env: {} });
    const nextOutput = lines(next);
    await waitFor(() => nextOutput.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.created).toHaveLength(1);
    expect(client.created[0]!.deleted()).toBe(false);
    next.stdin.end();
  });

  it("makes a turn that starts during a release wait for a new sandbox", async () => {
    const { mac, client, runtime, mcpEndpoint } = await setup();
    await runtime.prepare({ threadId: "thread-7", worktreePath: mac, mcpEndpoint });
    const released = runtime.release("thread-7");
    // A checkpoint asking for a mirror during the release waits for its final mirror.
    let releaseDone = false;
    void released.then(() => (releaseDone = true));
    await runtime.syncToMac("thread-7");
    expect(releaseDone).toBe(true);
    const launch = await runtime.prepare({ threadId: "thread-7", worktreePath: mac, mcpEndpoint });
    await released;
    expect(client.created).toHaveLength(2);
    expect(client.created[0]!.deleted()).toBe(true);
    expect(client.created[1]!.deleted()).toBe(false);
    const child = launch.spawn({ command: "claude", args: [], env: {} });
    const output = lines(child);
    await waitFor(() => output.length > 0);
    child.stdin.end();
  });

  it("carries claude transcripts between the Mac and the thread's backup", async () => {
    const { mac, macHome, client, runtime, mcpEndpoint } = await setup();
    const macDir = `${macHome}/.claude/projects/${encodeProjectDir(await NodeFs.realpath(mac))}`;
    await NodeFs.mkdir(`${macDir}/s1/subagents`, { recursive: true });
    await NodeFs.mkdir(`${macDir}/memory`, { recursive: true });
    await NodeFs.writeFile(`${macDir}/s1.jsonl`, "mac turn\n");
    await NodeFs.writeFile(`${macDir}/s1/subagents/a.jsonl`, "sub\n");
    await NodeFs.writeFile(`${macDir}/memory/MEMORY.md`, "memory\n");
    const has = (sessionId: string, location: "local" | "cloud") =>
      runtime.hasTranscript({ threadId: "thread-8", macCwd: mac, sessionId, location });

    expect(await has("s1", "cloud")).toBe(false);
    await runtime.importTranscripts("thread-8", mac);
    // Again with a newer Mac copy: the backup takes it, nothing doubles.
    await NodeFs.writeFile(`${macDir}/s1.jsonl`, "mac turn\nmac turn 2\n");
    await runtime.importTranscripts("thread-8", mac);
    expect(await has("s1", "cloud")).toBe(true);
    expect(await has("s2", "cloud")).toBe(false);
    const backups = `${macHome}/../state/cloud-lead-sessions`;
    const [backup] = await NodeFs.readdir(backups);
    expect((await NodeFs.stat(`${backups}/${backup}`)).mode & 0o777).toBe(0o600);
    expect((await NodeFs.stat(backups)).mode & 0o777).toBe(0o700);
    const listed = (await shell.run(`tar -tzf '${backups}/${backup}'`)).split("\n");
    expect(listed.some((entry) => entry.includes("memory"))).toBe(false);

    // A new sandbox restores the session under its own path.
    await runtime.prepare({ threadId: "thread-8", worktreePath: mac, mcpEndpoint });
    const home = client.created[0]!.home;
    const remoteDir = `${home}/.claude/projects/${encodeProjectDir(`${home}/busyboy`)}`;
    expect(await NodeFs.readFile(`${remoteDir}/s1.jsonl`, "utf8")).toBe("mac turn\nmac turn 2\n");
    expect(await NodeFs.readFile(`${remoteDir}/s1/subagents/a.jsonl`, "utf8")).toBe("sub\n");

    // The sandbox's session continues, then comes back to the Mac.
    await NodeFs.appendFile(`${remoteDir}/s1.jsonl`, "cloud turn\n");
    await runtime.release("thread-8");
    await NodeFs.rm(`${macDir}/s1.jsonl`);
    expect(await has("s1", "local")).toBe(false);
    await runtime.exportTranscripts("thread-8", mac);
    await runtime.exportTranscripts("thread-8", mac);
    expect(await has("s1", "local")).toBe(true);
    expect(await NodeFs.readFile(`${macDir}/s1.jsonl`, "utf8")).toBe(
      "mac turn\nmac turn 2\ncloud turn\n",
    );
    expect((await NodeFs.stat(`${macDir}/s1.jsonl`)).mode & 0o777).toBe(0o600);
    expect(await NodeFs.readFile(`${macDir}/memory/MEMORY.md`, "utf8")).toBe("memory\n");
  });

  it("leaves no backup when the Mac has no transcripts", async () => {
    const { mac, macHome, runtime } = await setup();
    await runtime.importTranscripts("thread-9", mac);
    await runtime.exportTranscripts("thread-9", mac);
    expect(await NodeFs.readdir(`${macHome}/../state/cloud-lead-sessions`).catch(() => [])).toEqual(
      [],
    );
    expect(
      await runtime.hasTranscript({
        threadId: "thread-9",
        macCwd: mac,
        sessionId: "s1",
        location: "cloud",
      }),
    ).toBe(false);
  });

  describe("near the sandbox's lifetime limit", () => {
    const HOUR = 60 * 60 * 1000;
    /** A fake clock the runtime reads sandbox ages from, checked every 20ms. */
    const clocked = () => {
      const clock = { now: 0 };
      const calls: string[] = [];
      const handler: CloudLeadRotationHandler = {
        interrupt: async (threadId) => void calls.push(`interrupt ${threadId}`),
        resume: async (threadId) => void calls.push(`resume ${threadId}`),
        failed: async (threadId, reason) => void calls.push(`failed ${threadId}: ${reason}`),
      };
      return {
        clock,
        calls,
        handler,
        runtime: {
          now: () => clock.now,
          rotationCheckMs: 20,
        } satisfies Partial<CloudLeadRuntimeDeps>,
      };
    };
    const transcriptDir = (home: string) =>
      `${home}/.claude/projects/${encodeProjectDir(`${home}/busyboy`)}`;

    it("replaces an idle sandbox and the next turn resumes the same session", async () => {
      const { clock, calls, handler, runtime: clockDeps } = clocked();
      const { mac, client, runtime, mcpEndpoint } = await setup({ runtime: clockDeps });
      runtime.setRotationHandler(handler);
      const launch = await runtime.prepare({
        threadId: "thread-r1",
        worktreePath: mac,
        mcpEndpoint,
      });
      const first = client.created[0]!;
      const child = launch.spawn({ command: "claude", args: [], env: {} });
      const output = lines(child);
      child.stdin.write("edit wip.txt\n");
      await waitFor(() => output.some((line) => line.file === "wip.txt"));
      await NodeFs.mkdir(transcriptDir(first.home), { recursive: true });
      await NodeFs.writeFile(`${transcriptDir(first.home)}/s1.jsonl`, "turn 1\n");
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));

      // 23 hours in: not yet.
      clock.now = 23 * HOUR;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(first.deleted()).toBe(false);

      // 30 minutes before 24 hours, between turns: replaced right away, no turn stopped.
      clock.now = 23.5 * HOUR;
      await waitFor(() => first.deleted());
      expect(runtime.hasSession("thread-r1")).toBe(false);
      expect(calls).toEqual([]);
      expect(await NodeFs.readFile(`${mac}/wip.txt`, "utf8")).toBe("edit\n");

      await runtime.prepare({ threadId: "thread-r1", worktreePath: mac, mcpEndpoint });
      const second = client.created[1]!;
      expect(await NodeFs.readFile(`${transcriptDir(second.home)}/s1.jsonl`, "utf8")).toBe(
        "turn 1\n",
      );
      expect(await NodeFs.readFile(`${second.home}/busyboy/wip.txt`, "utf8")).toBe("edit\n");
    });

    it("stops a running turn, replaces the sandbox, then lets the queue run", async () => {
      const { clock, calls, runtime: clockDeps } = clocked();
      const { mac, client, runtime, mcpEndpoint } = await setup({ runtime: clockDeps });
      const launch = await runtime.prepare({
        threadId: "thread-r2",
        worktreePath: mac,
        mcpEndpoint,
      });
      const child = launch.spawn({ command: "claude", args: [], env: {} });
      const output = lines(child);
      child.stdin.write("edit midturn.txt\n");
      await waitFor(() => output.some((line) => line.file === "midturn.txt"));
      runtime.setRotationHandler({
        // Like run.interrupt with holdQueue: the turn's claude stops.
        interrupt: async (threadId) => {
          calls.push(`interrupt ${threadId}`);
          const exited = new Promise((resolve) => child.once("exit", resolve));
          child.kill("SIGTERM");
          await exited;
        },
        resume: async (threadId) => void calls.push(`resume ${threadId}`),
        failed: async (threadId, reason) => void calls.push(`failed ${threadId}: ${reason}`),
      });

      clock.now = 23.6 * HOUR;
      await waitFor(() => calls.includes("resume thread-r2"));
      expect(calls).toEqual(["interrupt thread-r2", "resume thread-r2"]);
      expect(client.created[0]!.deleted()).toBe(true);
      expect(await NodeFs.readFile(`${mac}/midturn.txt`, "utf8")).toBe("edit\n");
      await runtime.prepare({ threadId: "thread-r2", worktreePath: mac, mcpEndpoint });
      expect(client.created).toHaveLength(2);
    });

    it("stops the turns of the lead and of a child sharing its sandbox before replacing it", async () => {
      const { clock, calls, runtime: clockDeps } = clocked();
      const { mac, client, runtime, mcpEndpoint } = await setup({ runtime: clockDeps });
      const lead = await runtime.prepare({ threadId: "lead-r", worktreePath: mac, mcpEndpoint });
      const implement = await runtime.prepare({
        threadId: "implement-r",
        worktreePath: mac,
        mcpEndpoint,
      });
      const running = new Map([
        ["lead-r", lead.spawn({ command: "claude", args: [], env: {} })],
        ["implement-r", implement.spawn({ command: "claude", args: [], env: {} })],
      ]);
      const outputs = [...running.values()].map(lines);
      await waitFor(() => outputs.every((output) => output.length > 0));
      runtime.setRotationHandler({
        interrupt: async (threadId) => {
          calls.push(`interrupt ${threadId}`);
          const child = running.get(threadId)!;
          const exited = new Promise((resolve) => child.once("exit", resolve));
          child.kill("SIGTERM");
          await exited;
        },
        resume: async (threadId) => void calls.push(`resume ${threadId}`),
        failed: async (threadId, reason) => void calls.push(`failed ${threadId}: ${reason}`),
      });

      clock.now = 23.6 * HOUR;
      await waitFor(() => calls.filter((call) => call.startsWith("resume")).length === 2);
      expect(calls.toSorted()).toEqual([
        "interrupt implement-r",
        "interrupt lead-r",
        "resume implement-r",
        "resume lead-r",
      ]);
      expect(client.created[0]!.deleted()).toBe(true);
    });

    it("keeps the sandbox and reports once when it cannot be replaced", async () => {
      const { clock, calls, handler, runtime: clockDeps } = clocked();
      let broken = false;
      const brokenMac = {
        ...shell,
        run: async (script: string) => {
          if (broken && script.includes("git reset")) throw new Error("Mac disk is full");
          return shell.run(script);
        },
      };
      const { mac, client, runtime, mcpEndpoint } = await setup({
        macShell: brokenMac,
        runtime: clockDeps,
      });
      runtime.setRotationHandler(handler);
      await runtime.prepare({ threadId: "thread-r3", worktreePath: mac, mcpEndpoint });
      broken = true;
      clock.now = 23.9 * HOUR;
      await waitFor(() => calls.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/^failed thread-r3: .*Mac disk is full/s);
      expect(client.created[0]!.deleted()).toBe(false);
      expect(runtime.hasSession("thread-r3")).toBe(true);
    });

    it("waits while the lead is being moved, then replaces the sandbox", async () => {
      const { clock, calls, handler, runtime: clockDeps } = clocked();
      const { mac, client, runtime, mcpEndpoint } = await setup({ runtime: clockDeps });
      let moving = true;
      runtime.setRotationHandler({ ...handler, busy: () => moving });
      await runtime.prepare({ threadId: "thread-r5", worktreePath: mac, mcpEndpoint });
      clock.now = 23.9 * HOUR;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(client.created[0]!.deleted()).toBe(false);
      expect(calls).toEqual([]);

      moving = false;
      await waitFor(() => client.created[0]!.deleted());
      expect(calls).toEqual([]);
    });

    it("replaces a sandbox that is due when a turn starts", async () => {
      const { clock } = clocked();
      const { mac, client, runtime, mcpEndpoint } = await setup({
        runtime: { now: () => clock.now, rotationCheckMs: HOUR },
      });
      await runtime.prepare({ threadId: "thread-r4", worktreePath: mac, mcpEndpoint });
      clock.now = 24 * HOUR;
      await runtime.prepare({ threadId: "thread-r4", worktreePath: mac, mcpEndpoint });
      expect(client.created).toHaveLength(2);
      expect(client.created[0]!.deleted()).toBe(true);
    });
  });

  it("runs a lead's children in the lead's sandbox and checkout, and mirrors their work", async () => {
    const { mac, client, runtime, mcpEndpoint } = await setup();
    await runtime.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    // An implement child that shares the lead's worktree.
    const launch = await runtime.prepare({ threadId: "implement", worktreePath: mac, mcpEndpoint });
    expect(client.created).toHaveLength(1);

    const child = launch.spawn({ command: "claude", args: [], cwd: mac, env: {} });
    const output = lines(child);
    child.stdin.write("commit child.txt\n");
    await waitFor(() => output.some((line) => line.done === "commit"));
    const remote = `${client.created[0]!.home}/busyboy`;
    expect(output[0]!.cwd).toBe(await NodeFs.realpath(remote));

    // The child's turn end mirrors the shared sandbox onto the lead's Mac worktree.
    await runtime.syncToMac("implement");
    expect((await shell.run(`git -C '${mac}' log --format=%s -1`)).trim()).toBe("Add child.txt");

    // The child finishing does not free the lead's sandbox; the lead's release does.
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
    expect(client.created[0]!.deleted()).toBe(false);
    await runtime.release("lead");
    expect(client.created[0]!.deleted()).toBe(true);
  });

  it("runs codex app-server in the sandbox with the cloud login only as env, and saves its refresh", async () => {
    const codexAuth = {
      value: '{"tokens":{"refresh_token":"valid-cloud"}}' as string | null,
      saved: [] as string[],
    };
    const { mac, client, runtime, mcpEndpoint, ports } = await setup({ codexAuth });
    const launch = await runtime.prepare({ threadId: "fix", worktreePath: mac, mcpEndpoint });
    expect(await runtime.checkCodex(mac)).toEqual({ ok: true });

    const child = await launch.spawnCodex({
      args: ["app-server", "--listen", "stdio://"],
      env: { OPENAI_API_KEY: "mac-key", CODEX_HOME: "/mac/.codex", RUST_LOG: "warn" },
    });
    const output = lines(child);
    await waitFor(() => output.length > 0);
    const home = client.created[0]!.home;
    expect(output[0]).toEqual({
      argv: ["-c", 'sandbox_mode="danger-full-access"', "app-server", "--listen", "stdio://"],
      cwd: await NodeFs.realpath(`${home}/busyboy`),
      codexHome: `${home}/.codex`,
      auth: '{"tokens":{"refresh_token":"valid-cloud"}}',
      authEnv: null,
      apiKey: null,
    });

    // What the adapter sends: Mac paths and the Mac MCP endpoint, as the sandbox sees them.
    expect(launch.paths.toRemote(`{"cwd":"${mac}","url":"${mcpEndpoint}"}`)).toBe(
      `{"cwd":"${home}/busyboy","url":"http://127.0.0.1:${ports.mcp}/mcp"}`,
    );
    expect(launch.paths.toMac(`${home}/busyboy/src/a.ts`)).toBe(`${mac}/src/a.ts`);
    // The Mac's Codex config, with sandbox paths.
    expect(await NodeFs.readFile(`${home}/.codex/config.toml`, "utf8")).toBe(
      `model = "gpt-6.1-sol"\n[projects."${home}/busyboy"]\n`,
    );

    // Only one sandbox (one Mac worktree) uses the login at a time.
    expect(await runtime.checkCodex(`${mac}-other`)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("another cloud sandbox"),
    });

    child.stdin.write("refresh\n");
    await waitFor(() => output.some((line) => line.got === "refresh"));
    child.stdin.end();
    await waitFor(() => codexAuth.saved.length > 0);
    expect(codexAuth.saved).toEqual(['{"tokens":{"refresh_token":"valid-refreshed"}}']);
    await waitFor(async () => {
      const check = await runtime.checkCodex(`${mac}-other`);
      return !check.ok && check.reason.includes("not running");
    });
  });

  it("refuses Codex without a cloud login or when the login fails in the sandbox", async () => {
    const codexAuth = { value: null as string | null, saved: [] as string[] };
    const { mac, runtime, mcpEndpoint } = await setup({ codexAuth });
    expect(await runtime.checkCodex(mac)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("codex_auth_json"),
    });
    // A login file without tokens passes `codex login status`, so it is refused first.
    codexAuth.value = '{"OPENAI_API_KEY":null,"tokens":null}';
    expect(await runtime.checkCodex(mac)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no tokens"),
    });
    codexAuth.value = '{"tokens":{"refresh_token":"expired"}}';
    expect(await runtime.checkCodex(mac)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not running"),
    });
    await runtime.prepare({ threadId: "lead", worktreePath: mac, mcpEndpoint });
    expect(await runtime.checkCodex(mac)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Not logged in"),
    });
  });

  it("keeps codex's refreshed login for the next codex in the sandbox, and saves it before release", async () => {
    const codexAuth = {
      value: '{"tokens":{"refresh_token":"valid-cloud"}}' as string | null,
      saved: [] as string[],
    };
    const { mac, client, runtime, mcpEndpoint } = await setup({ codexAuth });
    const launch = await runtime.prepare({ threadId: "implement", worktreePath: mac, mcpEndpoint });
    const first = await launch.spawnCodex({ args: ["app-server"], env: {} });
    const firstOutput = lines(first);
    first.stdin.write("refresh\n");
    await waitFor(() => firstOutput.some((line) => line.got === "refresh"));

    // A fix step starts while the implement codex still runs: it must not put the old login back.
    const second = await launch.spawnCodex({ args: ["app-server"], env: {} });
    const secondOutput = lines(second);
    await waitFor(() => secondOutput.length > 0);
    expect(secondOutput[0]!.auth).toBe('{"tokens":{"refresh_token":"valid-refreshed"}}');

    // Released while codex runs: the refreshed login is saved before the sandbox goes.
    await runtime.release("implement");
    expect(client.created[0]!.deleted()).toBe(true);
    expect(codexAuth.saved).toEqual(['{"tokens":{"refresh_token":"valid-refreshed"}}']);
    // The released sandbox no longer holds the login: another worktree may use it.
    expect(await runtime.checkCodex(`${mac}-other`)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not running"),
    });
  });

  it("does not start codex in a sandbox released while it was getting ready", async () => {
    const codexAuth = {
      value: '{"tokens":{"refresh_token":"valid-cloud"}}' as string | null,
      saved: [] as string[],
    };
    const { mac, client, runtime, mcpEndpoint } = await setup({ codexAuth });
    const launch = await runtime.prepare({ threadId: "implement", worktreePath: mac, mcpEndpoint });
    // The first spawn copies the Codex config into the sandbox; the release lands meanwhile.
    const spawning = launch.spawnCodex({ args: ["app-server"], env: {} });
    const released = runtime.release("implement");
    await expect(spawning).rejects.toThrow("was stopped");
    await released;
    expect(client.created[0]!.deleted()).toBe(true);
    expect(await runtime.checkCodex(`${mac}-other`)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not running"),
    });
  });
});
