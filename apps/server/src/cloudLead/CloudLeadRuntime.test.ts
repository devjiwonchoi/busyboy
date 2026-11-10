// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
import * as NodeFs from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  CloudLeadRuntime,
  type CloudLeadRotationHandler,
  type CloudLeadRuntimeDeps,
} from "./CloudLeadRuntime.ts";
import { encodeProjectDir } from "./pathRewrite.ts";
import type { RemoteProcess } from "./RelayClient.ts";
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
process.stdin.on("end", () => process.exit(0));
`;

const setup = async (
  options: {
    readonly idleStopMs?: number;
    readonly macShell?: typeof shell;
    readonly runtime?: Partial<CloudLeadRuntimeDeps>;
  } = {},
) => {
  const root = await tempDir("cloud-runtime-");
  const macHome = `${root}/mac-home`;
  const mac = `${macHome}/worktrees/task`;
  const binDir = `${root}/bin`;
  await NodeFs.mkdir(binDir, { recursive: true });
  await NodeFs.writeFile(`${binDir}/claude`, FAKE_CLAUDE, { mode: 0o755 });
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
  const runtime = new CloudLeadRuntime({
    client: async () => client,
    credentials: async () => ({ claudeOauthToken: CLAUDE_TOKEN, githubToken: GITHUB_TOKEN }),
    baseSnapshotId: async () => null,
    host: { ...fakeLocalHost({ files: {} }), env: { HOME: macHome } },
    stateDir: `${root}/state`,
    ports,
    ...(options.idleStopMs === undefined ? {} : { idleStopMs: options.idleStopMs }),
    ...(options.macShell === undefined ? {} : { macShell: options.macShell }),
    ...options.runtime,
  });
  cleanups.push(() => runtime.releaseAll());
  return { mac, macHome, client, runtime, mcpEndpoint, mcpCalls, ports };
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

const waitFor = async (check: () => boolean, timeoutMs = 10_000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

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
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.created).toHaveLength(1);
    expect(client.created[0]!.deleted()).toBe(false);
    const next = second.spawn({ command: "claude", args: [], env: {} });
    const nextOutput = lines(next);
    await waitFor(() => nextOutput.length > 0);
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
});
