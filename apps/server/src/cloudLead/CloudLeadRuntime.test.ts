import * as NodeFs from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { CloudLeadRuntime } from "./CloudLeadRuntime.ts";
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

const setup = async () => {
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
    makeHome: (home) =>
      shell.run(
        `git clone -q '${mac}' '${home}/busyboy' && git -C '${home}/busyboy' checkout -q --detach ${baseCommit}`,
      ),
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
    expect((await shell.run(`git -C '${mac}' symbolic-ref --short HEAD`)).trim()).toBe(
      "t3/task",
    );
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
    expect((await shell.run(`git -C '${remote}' log --format=%s -1`)).trim()).toBe(
      "Add one.txt",
    );
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
});
