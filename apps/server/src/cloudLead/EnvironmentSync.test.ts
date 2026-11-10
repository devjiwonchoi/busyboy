// @effect-diagnostics nodeBuiltinImport:off - runs the sandbox hash script with a real node.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";

import { describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_JSON_FRAGMENT_PATH,
  collectLocalBundle,
  hashBundle,
  REMOTE_HASH_SCRIPT,
  SYNC_MARKER_PATH,
  syncEnvironment,
} from "./EnvironmentSync.ts";
import { fakeLocalHost, fakeSandbox } from "./testkit.ts";

const H = "/Users/me";
const locations = {
  localHome: H,
  remoteHome: "/vercel",
  projectCwd: "/Users/me/code/busyboy",
  remoteCwd: "/vercel/busyboy",
  defaultModel: "claude-opus-5-5",
};
const ACCOUNT = "acct_1";

const baseFiles = (): Record<string, string> => ({
  [`${H}/.claude/settings.json`]: JSON.stringify({
    permissions: { allow: ["Bash(git status)", "Read(/Users/me/code/busyboy/**)"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: `${H}/bin/notify.sh` }] }] },
    enabledPlugins: { "jwn@jwn": true },
    effortLevel: "high",
    env: {
      OPENAI_API_KEY: "plain-key-value-123",
      ANTHROPIC_MODEL: "opus",
      MAX_THINKING_TOKENS: "8000",
      STRIPE_KEY: "rk_live_value",
      SENTRY_DSN: "https://abc@sentry.io/1",
      DATABASE_URL: "postgres://app:hunter2pass@db/x",
      NOTES_ID: "sk-proj-abc123defghijklmnopqrstu",
    },
    apiKeyHelper: "/Users/me/bin/key.sh",
  }),
  ["/Users/me/code/busyboy/.claude/settings.local.json"]: JSON.stringify({
    permissions: {
      allow: [
        "Read(/Users/me/code/busyboy/docs/**)",
        "Bash(pnpm test)",
        "Bash(GH_TOKEN=ghp_abcdef123456 gh pr list)",
      ],
    },
  }),
  ["/Users/me/code/busyboy/CLAUDE.local.md"]: "local notes in /Users/me/code/busyboy",
  [`${H}/.claude/CLAUDE.md`]: "# me, repo at /Users/me/code/busyboy",
  [`${H}/.claude/skills/my-skill/SKILL.md`]: "skill",
  [`${H}/.claude/plugins/installed_plugins.json`]: JSON.stringify({
    version: 2,
    plugins: { "jwn@jwn": [{ installPath: `${H}/.claude/plugins/cache/jwn/jwn/0.0.0` }] },
  }),
  [`${H}/.claude/plugins/known_marketplaces.json`]: JSON.stringify({
    jwn: { installLocation: `${H}/.claude/plugins/marketplaces/jwn` },
  }),
  [`${H}/.claude/plugins/cache/jwn/jwn/0.0.0/.claude-plugin/plugin.json`]: "{}",
  [`${H}/.claude/plugins/synced/${ACCOUNT}/productivity/.claude-plugin/plugin.json`]:
    JSON.stringify({ name: "productivity", version: "0041" }),
  [`${H}/.claude/plugins/synced/${ACCOUNT}/productivity/skills/start/SKILL.md`]: "start",
  [`${H}/.claude/plugins/synced/${ACCOUNT}/productivity/.in_use`]: "",
  [`${H}/.claude/plugins/synced/${ACCOUNT}/manifest.json`]: "{}",
  [`${H}/.claude/skills/synced/${ACCOUNT}/docs/SKILL.md`]: "docs",
  [`${H}/.claude/skills/synced/${ACCOUNT}/manifest.json`]: "{}",
  [`${H}/.claude/projects/-Users-me-code-busyboy/memory/MEMORY.md`]:
    "- see /Users/me/code/busyboy/x",
  [`${H}/.claude/sessions/secret-session.jsonl`]: "not synced",
  [`${H}/.claude.json`]: JSON.stringify({
    userID: "private",
    mcpServers: {
      rea: { command: "/usr/local/bin/rea", env: { JAVA_HOME: "/x" } },
      remote: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "x", "X-Region": "us" },
      },
      local: {
        command: "npx",
        args: ["server", "--max-tokens", "100"],
        env: { LOG_LEVEL: "debug", GITHUB_TOKEN: "t" },
      },
      keyed: { type: "http", url: "https://example.com/mcp?key=abc" },
      argSecret: { command: "npx", args: ["server", "--api-key", "abc"] },
    },
  }),
});

const host = (files = baseFiles()) =>
  fakeLocalHost({
    files,
    exec: {
      "git config --global user.name": "Me\n",
      "git config --global user.email": "me@example.com\n",
    },
  });

const file = (bundle: Awaited<ReturnType<typeof collectLocalBundle>>, path: string) =>
  bundle.files.find((entry) => entry.path === path)?.content.toString("utf8");

describe("collectLocalBundle", () => {
  it("bundles settings, skills, plugins, memory and MCP with sandbox paths", async () => {
    const bundle = await collectLocalBundle(host(), locations);
    const paths = bundle.files.map((entry) => entry.path);

    const settings = JSON.parse(file(bundle, ".claude/settings.json")!);
    // A global rule naming the repo follows the repo to its sandbox path.
    expect(settings.permissions).toEqual({
      allow: ["Bash(git status)", "Read(/vercel/busyboy/**)"],
    });
    // Plain config env survives; only the secret-looking entry is dropped.
    expect(settings.env).toEqual({ ANTHROPIC_MODEL: "opus", MAX_THINKING_TOKENS: "8000" });
    expect(settings.apiKeyHelper).toBeUndefined();
    expect(bundle.files.some((entry) => entry.content.includes("plain-key-value-123"))).toBe(false);
    expect(settings.effortLevel).toBe("high");
    expect(settings.model).toBe("claude-opus-5-5");
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("/vercel/bin/notify.sh");
    expect(settings.enabledPlugins).toEqual({
      "jwn@jwn": true,
      "productivity@busyboy-synced": true,
      "anthropic-skills@busyboy-synced": true,
    });

    expect(file(bundle, ".claude/CLAUDE.md")).toBe("# me, repo at /vercel/busyboy");
    expect(file(bundle, ".claude/projects/-vercel-busyboy/memory/MEMORY.md")).toBe(
      "- see /vercel/busyboy/x",
    );
    expect(paths).toContain(".claude/skills/my-skill/SKILL.md");
    expect(paths).toContain(".claude/projects/-vercel-busyboy/memory/MEMORY.md");
    expect(paths.some((path) => path.includes("sessions"))).toBe(false);
    expect(paths.some((path) => path.includes("/synced/"))).toBe(false);
    expect(paths.some((path) => path.endsWith(".in_use"))).toBe(false);

    const installed = JSON.parse(file(bundle, ".claude/plugins/installed_plugins.json")!);
    expect(installed.plugins["jwn@jwn"][0].installPath).toBe(
      "/vercel/.claude/plugins/cache/jwn/jwn/0.0.0",
    );
    expect(installed.plugins["productivity@busyboy-synced"][0]).toMatchObject({
      installPath: "/vercel/.claude/plugins/marketplaces/busyboy-synced/productivity",
      version: "0041",
    });
    expect(paths).toContain(
      ".claude/plugins/marketplaces/busyboy-synced/productivity/skills/start/SKILL.md",
    );
    expect(paths).toContain(
      ".claude/plugins/marketplaces/busyboy-synced/anthropic-skills/skills/docs/SKILL.md",
    );
    expect(
      JSON.parse(file(bundle, ".claude/plugins/known_marketplaces.json")!)["busyboy-synced"].source,
    ).toEqual({ source: "directory", path: "/vercel/.claude/plugins/marketplaces/busyboy-synced" });

    const fragment = JSON.parse(file(bundle, CLAUDE_JSON_FRAGMENT_PATH)!);
    expect(Object.keys(fragment.mcpServers)).toEqual(["remote", "local", "keyed"]);
    expect(fragment.mcpServers.remote.headers).toEqual({ "X-Region": "us" });
    expect(fragment.mcpServers.local).toEqual({
      command: "npx",
      args: ["server", "--max-tokens", "100"],
      env: { LOG_LEVEL: "debug" },
    });
    expect(fragment.mcpServers.keyed.url).toBe("https://example.com/mcp");
    expect(fragment.userID).toBeUndefined();
    expect(bundle.droppedMcp.map((entry) => [entry.name, entry.kind])).toEqual([
      ["rea", "mac-stdio-mcp"],
    ]);
    // "<server>:<KEY>" is the name cloud_secret_save takes for kind mcp.
    expect(bundle.needsSecret).toEqual(["remote:Authorization", "local:GITHUB_TOKEN"]);
    expect(bundle.leftBehind.map((entry) => entry.item)).toEqual([
      "settings env OPENAI_API_KEY",
      "settings env STRIPE_KEY",
      "settings env SENTRY_DSN",
      "settings env DATABASE_URL",
      "settings env NOTES_ID",
      "settings apiKeyHelper",
      "MCP server keyed url query",
      "MCP server argSecret",
      // The token in the approved rule is masked instead of stopping the sync.
      "busyboy/.claude/settings.local.json",
    ]);

    const local = JSON.parse(file(bundle, "busyboy/.claude/settings.local.json")!);
    expect(local.permissions.allow).toEqual([
      "Read(/vercel/busyboy/docs/**)",
      "Bash(pnpm test)",
      "Bash(GH_TOKEN=*** gh pr list)",
    ]);
    expect(file(bundle, "busyboy/CLAUDE.local.md")).toBe("local notes in /vercel/busyboy");
    expect(bundle.managedFiles).toEqual([
      ".claude/CLAUDE.md",
      "busyboy/.claude/settings.local.json",
      "busyboy/CLAUDE.local.md",
    ]);
    expect(bundle.git).toEqual({ name: "Me", email: "me@example.com" });
  });

  it("keeps a model the user set", async () => {
    const files = baseFiles();
    files[`${H}/.claude/settings.json`] = JSON.stringify({ model: "sonnet" });
    const bundle = await collectLocalBundle(host(files), locations);
    expect(JSON.parse(file(bundle, ".claude/settings.json")!).model).toBe("sonnet");
  });
});

describe("syncEnvironment", () => {
  it("writes the bundle once, then skips while the hash is unchanged", async () => {
    const sandbox = fakeSandbox();
    const bundle = await collectLocalBundle(host(), locations);

    const first = await syncEnvironment(sandbox, bundle, "/vercel");
    expect(first.skipped).toBe(false);
    expect(sandbox.writes).toHaveLength(1);
    // Staging is cleared before writing, so a failed earlier sync can't leak in.
    expect(String(sandbox.commands[0]?.args?.[1])).toBe("rm -rf /tmp/busyboy-env-sync");
    const script = String(sandbox.commands.at(-1)?.args?.[1]);
    expect(script).toContain("rm -f '.claude/CLAUDE.md'");
    expect(script).toContain("git config --global user.email 'me@example.com'");
    expect(script).toContain(`> ~/${SYNC_MARKER_PATH}`);

    // The fake sandbox does not run the script, so write the marker it would leave.
    sandbox.files.set(
      `/vercel/${SYNC_MARKER_PATH}`,
      Buffer.from(JSON.stringify({ hash: bundle.hash })),
    );
    const commandsBefore = sandbox.commands.length;
    const second = await syncEnvironment(sandbox, bundle, "/vercel");
    expect(second).toMatchObject({ skipped: true, hash: bundle.hash });
    expect(sandbox.writes).toHaveLength(1);
    expect(sandbox.commands).toHaveLength(commandsBefore);
  });

  it("re-syncs when any synced file changes", async () => {
    const sandbox = fakeSandbox();
    const before = await collectLocalBundle(host(), locations);
    sandbox.files.set(
      `/vercel/${SYNC_MARKER_PATH}`,
      Buffer.from(JSON.stringify({ hash: before.hash })),
    );

    const files = baseFiles();
    files[`${H}/.claude/projects/-Users-me-code-busyboy/memory/MEMORY.md`] = "- new note";
    const after = await collectLocalBundle(host(files), locations);
    expect(after.hash).not.toBe(before.hash);
    expect((await syncEnvironment(sandbox, after, "/vercel")).skipped).toBe(false);
    expect(sandbox.writes).toHaveLength(1);
  });

  it("re-syncs when the git identity changes", async () => {
    const one = await collectLocalBundle(host(), locations);
    const other = fakeLocalHost({
      files: baseFiles(),
      exec: {
        "git config --global user.name": "Someone",
        "git config --global user.email": "me@example.com",
      },
    });
    expect((await collectLocalBundle(other, locations)).hash).not.toBe(one.hash);
  });
});

describe("REMOTE_HASH_SCRIPT", () => {
  it("computes the same hash as hashBundle over the same files", () => {
    const home = NodeFs.mkdtempSync(`${NodeOs.tmpdir()}/env-hash-`);
    try {
      const files = { ".claude/settings.json": '{"a":1}', "busyboy/CLAUDE.local.md": "notes" };
      for (const [path, content] of Object.entries(files)) {
        NodeFs.mkdirSync(`${home}/${path.slice(0, path.lastIndexOf("/"))}`, { recursive: true });
        NodeFs.writeFileSync(`${home}/${path}`, content);
      }
      NodeFs.writeFileSync(`${home}/.gitconfig`, "[user]\n\tname = Me\n\temail = me@example.com\n");
      NodeFs.writeFileSync(`${home}/manifest.json`, JSON.stringify({ paths: Object.keys(files) }));

      const remote = NodeChildProcess.execFileSync(
        process.execPath,
        ["-e", REMOTE_HASH_SCRIPT, `${home}/manifest.json`],
        {
          env: {
            PATH: process.env.PATH ?? "",
            HOME: home,
            GIT_CONFIG_GLOBAL: `${home}/.gitconfig`,
          },
        },
      ).toString();
      const sha = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
      const local = hashBundle(
        Object.entries(files).map(([path, content]) => [path, sha(content)] as const),
        { name: "Me", email: "me@example.com" },
      );
      expect(remote).toBe(local);
    } finally {
      NodeFs.rmSync(home, { recursive: true, force: true });
    }
  });
});
