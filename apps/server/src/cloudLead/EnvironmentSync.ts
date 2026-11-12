/**
 * Copies the user's personal Claude setup to a sandbox at start: settings
 * (permissions, hooks, enabled plugins, model, effort), skills, agents,
 * commands, plugins and marketplaces, CLAUDE.md, project memory, user MCP
 * servers and the git identity. Mac paths are rewritten for the sandbox home.
 * When the bundle hash matches the one the sandbox already has, nothing is
 * written.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - effect/Crypto has no sync sha256; cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
import * as NodeCrypto from "node:crypto";

import { joinPath, type LocalHost } from "./LocalHost.ts";
import { classifyMcpServer, type LocalOnlyMatch, type McpServerConfig } from "./localOnly.ts";
import { encodeProjectDir, rewriteHomePaths, type HomeMapping } from "./pathRewrite.ts";
import type { SandboxHandle } from "./SandboxClient.ts";
import { containsSecret, makeSecretMasker } from "./secretMask.ts";

export interface SyncLocations extends HomeMapping {
  /** The repository the lead works in on the Mac. */
  readonly projectCwd: string;
  /** The same repository inside the sandbox. */
  readonly remoteCwd: string;
  /**
   * The model local claude picks when settings name none. The Mac default
   * comes from the claude.ai plan, which the sandbox token cannot see, so it is
   * written into the sandbox settings explicitly.
   */
  readonly defaultModel?: string;
}

export interface BundleFile {
  /** Relative to the home directory. */
  readonly path: string;
  readonly content: Buffer;
}

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface EnvironmentBundle {
  readonly files: ReadonlyArray<BundleFile>;
  readonly git: GitIdentity;
  readonly hash: string;
  readonly droppedMcp: ReadonlyArray<{ readonly name: string } & LocalOnlyMatch>;
  /**
   * MCP env/header secrets left behind, as "<server>:<KEY>": the name
   * cloud_secret_save takes for kind mcp, so the value can be passed back as env.
   */
  readonly needsSecret: ReadonlyArray<string>;
  /** Other secret-looking config the sandbox does not get, with why. */
  readonly leftBehind: ReadonlyArray<LeftBehind>;
  /** Home-relative directories and files the sync owns and replaces on each run. */
  readonly managedDirs: ReadonlyArray<string>;
  readonly managedFiles: ReadonlyArray<string>;
}

export interface LeftBehind {
  readonly item: string;
  readonly reason: string;
}

export const SYNC_MARKER_PATH = ".busyboy-cloud/env-sync.json";
export const CLAUDE_JSON_FRAGMENT_PATH = ".busyboy-cloud/claude-json-fragment.json";
const STAGING_DIR = "/tmp/busyboy-env-sync";

const WHOLE_DIRS = [".claude/skills", ".claude/agents", ".claude/commands"];
const PLUGIN_DIRS = [".claude/plugins/marketplaces", ".claude/plugins/cache"];
const PLAIN_FILES = [".claude/CLAUDE.md"];
const SETTINGS = ".claude/settings.json";
const INSTALLED_PLUGINS = ".claude/plugins/installed_plugins.json";
const KNOWN_MARKETPLACES = ".claude/plugins/known_marketplaces.json";

/**
 * Plugins and skills synced from the claude.ai account live under
 * plugins/synced and skills/synced. The sandbox token cannot sync them, so
 * they are repackaged as an installed local marketplace instead.
 */
const SYNCED_PLUGINS_DIR = ".claude/plugins/synced";
const SYNCED_SKILLS_DIR = ".claude/skills/synced";
export const SYNCED_MARKETPLACE = "busyboy-synced";
const SYNCED_MARKETPLACE_DIR = `.claude/plugins/marketplaces/${SYNCED_MARKETPLACE}`;
/** Synced account skills show up locally as "anthropic-skills:<skill>". */
const SYNCED_SKILLS_PLUGIN = "anthropic-skills";

const sha256 = (data: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(data).digest("hex");

/**
 * The bundle hash: sha256 over sorted [path, sha256(content)] pairs and the git
 * identity. REMOTE_HASH_SCRIPT computes the same thing inside the sandbox.
 */
export const hashBundle = (
  entries: ReadonlyArray<readonly [path: string, contentSha: string]>,
  git: GitIdentity,
): string =>
  sha256(
    JSON.stringify({
      files: [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      git: [git.name, git.email],
    }),
  );

/** node -e script: argv[1] = manifest JSON path ({paths}), prints the bundle hash of the live files. */
export const REMOTE_HASH_SCRIPT = `
const fs = require("fs"), crypto = require("crypto"), cp = require("child_process");
const sha = (d) => crypto.createHash("sha256").update(d).digest("hex");
const home = process.env.HOME;
const { paths } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const git = (k) => { try { return cp.execFileSync("git", ["config", "--global", k], { encoding: "utf8" }).trim(); } catch { return ""; } };
const files = paths.map((p) => { try { return [p, sha(fs.readFileSync(home + "/" + p))]; } catch { return [p, "missing"]; } });
files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
process.stdout.write(sha(JSON.stringify({ files, git: [git("user.name"), git("user.email")] })));
`;

const MERGE_CLAUDE_JSON_SCRIPT = `
const fs = require("fs");
const target = process.env.HOME + "/.claude.json";
let current = {};
try { current = JSON.parse(fs.readFileSync(target, "utf8")); } catch {}
const fragment = JSON.parse(fs.readFileSync(process.env.HOME + "/${CLAUDE_JSON_FRAGMENT_PATH}", "utf8"));
fs.writeFileSync(target, JSON.stringify({ ...current, ...fragment }, null, 2));
`;

export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const readGitIdentity = async (host: LocalHost): Promise<GitIdentity> => {
  const read = async (key: string) =>
    (await host.exec("git", ["config", "--global", key])).stdout.trim();
  return { name: await read("user.name"), email: await read("user.email") };
};

/** Settings keys that hold or produce credentials; the sandbox gets its auth as command env. */
const CREDENTIAL_SETTINGS = [
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "otelHeadersHelper",
];

/** An env/header key that names a credential. "MAX_THINKING_TOKENS" is not one; "GITHUB_TOKEN" is. */
const SECRET_KEY =
  /(^|[_-])(api[_-]?key|private[_-]?key|key|token|secret|password|passwd|credentials?|auth|authorization|cookie|dsn|pat)([_-]|$)/i;
/** A flag that carries a credential, as "--api-key X" or "--token=X". */
const SECRET_FLAG = /^--?(api[-_]?key|token|access[-_]?token|auth[-_]?token|secret|password)(=|$)/i;

const isSecretEntry = (key: string, value: unknown) =>
  SECRET_KEY.test(key) || containsSecret(String(value), []);

/** Keeps env entries that are plain config and returns the keys that look like secrets. */
const splitSecretEnv = (env: unknown) => {
  const kept: Record<string, unknown> = {};
  const secretKeys: string[] = [];
  for (const [key, value] of Object.entries(record(env))) {
    if (isSecretEntry(key, value)) secretKeys.push(key);
    else kept[key] = value;
  }
  return { kept, secretKeys };
};

/** Drops secret-looking settings env entries and credential helpers. */
const withoutSettingsSecrets = (settings: Record<string, unknown>, leftBehind: LeftBehind[]) => {
  const clean = { ...settings };
  if (clean.env !== undefined) {
    const { kept, secretKeys } = splitSecretEnv(clean.env);
    for (const key of secretKeys) {
      leftBehind.push({ item: `settings env ${key}`, reason: "looks like a secret" });
    }
    clean.env = kept;
  }
  for (const key of CREDENTIAL_SETTINGS) {
    if (key in clean) {
      leftBehind.push({
        item: `settings ${key}`,
        reason: "credential helper; the sandbox gets auth as env",
      });
      delete clean[key];
    }
  }
  return clean;
};

const filterMcpServers = (raw: unknown) => {
  const kept: Record<string, McpServerConfig> = {};
  const droppedMcp: Array<{ name: string } & LocalOnlyMatch> = [];
  const needsSecret: string[] = [];
  const leftBehind: LeftBehind[] = [];
  if (raw === null || typeof raw !== "object") return { kept, droppedMcp, needsSecret, leftBehind };
  for (const [name, value] of Object.entries(raw as Record<string, McpServerConfig>)) {
    const localOnly = classifyMcpServer(name, value);
    if (localOnly !== null) {
      droppedMcp.push({ name, ...localOnly });
      continue;
    }
    const { env, headers, ...rest } = value as McpServerConfig & {
      env?: Record<string, string>;
      headers?: Record<string, string>;
    };
    // A secret passed as an argument can't be split out, so the server stays behind.
    const args = Array.isArray(rest.args) ? rest.args.map(String) : [];
    if (args.some((arg) => SECRET_FLAG.test(arg) || containsSecret(arg, []))) {
      leftBehind.push({ item: `MCP server ${name}`, reason: "a secret is passed as an argument" });
      continue;
    }
    const server: Record<string, unknown> = { ...rest };
    const secretEnv = splitSecretEnv(env);
    if (env !== undefined) server.env = secretEnv.kept;
    const secretHeaders = splitSecretEnv(headers);
    if (headers !== undefined) server.headers = secretHeaders.kept;
    for (const key of [...secretEnv.secretKeys, ...secretHeaders.secretKeys]) {
      needsSecret.push(`${name}:${key}`);
    }
    if (typeof rest.url === "string" && rest.url.includes("?")) {
      leftBehind.push({ item: `MCP server ${name} url query`, reason: "may hold a secret" });
      server.url = rest.url.slice(0, rest.url.indexOf("?"));
    }
    kept[name] = server as McpServerConfig;
  }
  return { kept, droppedMcp, needsSecret, leftBehind };
};

const parseJson = (content: Buffer | null): Record<string, unknown> => {
  if (content === null) return {};
  try {
    const parsed: unknown = JSON.parse(content.toString("utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};

interface SyncedPlugin {
  readonly name: string;
  readonly version: string;
  readonly files: ReadonlyArray<BundleFile>;
}

/** plugins/synced/<account>/<plugin>/... and skills/synced/<account>/<skill>/... as plugin folders. */
const collectSyncedPlugins = async (
  host: LocalHost,
  localHome: string,
): Promise<ReadonlyArray<SyncedPlugin>> => {
  const plugins = new Map<string, { version: string; files: BundleFile[] }>();
  const add = (name: string, version: string, file: BundleFile) => {
    const entry = plugins.get(name) ?? { version, files: [] };
    entry.files.push(file);
    plugins.set(name, entry);
  };

  const pluginFiles = await host.listFiles(joinPath(localHome, SYNCED_PLUGINS_DIR));
  for (const manifest of pluginFiles.filter((file) =>
    /^[^/]+\/[^/]+\/\.claude-plugin\/plugin\.json$/.test(file),
  )) {
    const [account, name] = manifest.split("/") as [string, string];
    const meta = parseJson(await host.readFile(joinPath(localHome, SYNCED_PLUGINS_DIR, manifest)));
    const version = typeof meta.version === "string" ? meta.version : "0.0.0";
    const prefix = `${account}/${name}/`;
    for (const file of pluginFiles.filter((path) => path.startsWith(prefix))) {
      const relative = file.slice(prefix.length);
      if (relative === ".in_use") continue;
      const content = await host.readFile(joinPath(localHome, SYNCED_PLUGINS_DIR, file));
      if (content !== null) add(name, version, { path: relative, content });
    }
  }

  const skillFiles = await host.listFiles(joinPath(localHome, SYNCED_SKILLS_DIR));
  const skillDirs = new Set(
    skillFiles
      .filter((file) => /^[^/]+\/[^/]+\/SKILL\.md$/.test(file))
      .map((file) => file.split("/").slice(0, 2).join("/")),
  );
  for (const file of skillFiles) {
    const [account, skill] = file.split("/");
    if (!skillDirs.has(`${account}/${skill}`)) continue;
    const content = await host.readFile(joinPath(localHome, SYNCED_SKILLS_DIR, file));
    if (content === null) continue;
    add(SYNCED_SKILLS_PLUGIN, "0.0.0", {
      path: joinPath("skills", file.split("/").slice(1).join("/")),
      content,
    });
  }
  const skillsPlugin = plugins.get(SYNCED_SKILLS_PLUGIN);
  if (skillsPlugin !== undefined) {
    skillsPlugin.files.push({
      path: ".claude-plugin/plugin.json",
      content: Buffer.from(
        JSON.stringify({
          name: SYNCED_SKILLS_PLUGIN,
          version: "0.0.0",
          description: "Synced skills",
        }),
      ),
    });
  }

  return [...plugins.entries()]
    .map(([name, entry]) => ({ name, version: entry.version, files: entry.files }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
};

/** The sandbox repo as a home-relative path; the repo must live under the sandbox home. */
const remoteRepoPath = (locations: SyncLocations) => {
  const prefix = `${locations.remoteHome.replace(/\/$/, "")}/`;
  if (!locations.remoteCwd.startsWith(prefix)) {
    throw new Error(`The sandbox repo ${locations.remoteCwd} must be under ${prefix}`);
  }
  return locations.remoteCwd.slice(prefix.length).replace(/\/$/, "");
};

export const collectLocalBundle = async (
  host: LocalHost,
  locations: SyncLocations,
): Promise<EnvironmentBundle> => {
  const files: BundleFile[] = [];
  const leftBehind: LeftBehind[] = [];
  const repo = remoteRepoPath(locations);
  const projectFiles = {
    settingsLocal: joinPath(repo, ".claude/settings.local.json"),
    claudeLocal: joinPath(repo, "CLAUDE.local.md"),
  };
  const fromHome = (relative: string) => joinPath(locations.localHome, relative);
  // The repo path first (it may sit at a different place under the home), then the home.
  const rewrite = (text: string) =>
    rewriteHomePaths(
      rewriteHomePaths(text, { localHome: locations.projectCwd, remoteHome: locations.remoteCwd }),
      locations,
    );
  const rewriteText = (content: Buffer) => Buffer.from(rewrite(content.toString("utf8")));
  const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2));

  for (const relative of PLAIN_FILES) {
    const content = await host.readFile(fromHome(relative));
    if (content !== null) files.push({ path: relative, content: rewriteText(content) });
  }
  for (const dir of [...WHOLE_DIRS, ...PLUGIN_DIRS]) {
    for (const file of await host.listFiles(fromHome(dir))) {
      const path = joinPath(dir, file);
      if (path.startsWith(`${SYNCED_SKILLS_DIR}/`)) continue;
      const content = await host.readFile(fromHome(path));
      if (content !== null) files.push({ path, content });
    }
  }

  const settings = withoutSettingsSecrets(
    JSON.parse(rewrite(JSON.stringify(parseJson(await host.readFile(fromHome(SETTINGS)))))),
    leftBehind,
  );
  const installed = JSON.parse(
    rewrite(JSON.stringify(parseJson(await host.readFile(fromHome(INSTALLED_PLUGINS))))),
  ) as Record<string, unknown>;
  const known = JSON.parse(
    rewrite(JSON.stringify(parseJson(await host.readFile(fromHome(KNOWN_MARKETPLACES))))),
  ) as Record<string, unknown>;

  const synced = await collectSyncedPlugins(host, locations.localHome);
  if (synced.length > 0) {
    const marketplacePath = joinPath(locations.remoteHome, SYNCED_MARKETPLACE_DIR);
    for (const plugin of synced) {
      for (const file of plugin.files) {
        files.push({
          path: joinPath(SYNCED_MARKETPLACE_DIR, plugin.name, file.path),
          content: file.content,
        });
      }
    }
    files.push({
      path: joinPath(SYNCED_MARKETPLACE_DIR, ".claude-plugin/marketplace.json"),
      content: json({
        name: SYNCED_MARKETPLACE,
        owner: { name: "BusyBoy" },
        plugins: synced.map((plugin) => ({ name: plugin.name, source: `./${plugin.name}` })),
      }),
    });
    known[SYNCED_MARKETPLACE] = {
      source: { source: "directory", path: marketplacePath },
      installLocation: marketplacePath,
      lastUpdated: new Date(0).toISOString(),
    };
    const installedPlugins = record(installed.plugins);
    const enabled = record(settings.enabledPlugins);
    for (const plugin of synced) {
      const id = `${plugin.name}@${SYNCED_MARKETPLACE}`;
      installedPlugins[id] = [
        {
          scope: "user",
          installPath: joinPath(marketplacePath, plugin.name),
          version: plugin.version,
          installedAt: new Date(0).toISOString(),
          lastUpdated: new Date(0).toISOString(),
        },
      ];
      enabled[id] = true;
    }
    installed.version ??= 2;
    installed.plugins = installedPlugins;
    settings.enabledPlugins = enabled;
  }
  if (locations.defaultModel !== undefined && typeof settings.model !== "string") {
    settings.model = locations.defaultModel;
  }
  files.push({ path: SETTINGS, content: json(settings) });
  if (Object.keys(installed).length > 0)
    files.push({ path: INSTALLED_PLUGINS, content: json(installed) });
  if (Object.keys(known).length > 0) files.push({ path: KNOWN_MARKETPLACES, content: json(known) });

  // Project-local, gitignored files: permission rules that pile up per project, and CLAUDE.local.md.
  const settingsLocal = await host.readFile(
    joinPath(locations.projectCwd, ".claude/settings.local.json"),
  );
  if (settingsLocal !== null) {
    files.push({
      path: projectFiles.settingsLocal,
      content: json(
        withoutSettingsSecrets(
          JSON.parse(rewrite(JSON.stringify(parseJson(settingsLocal)))),
          leftBehind,
        ),
      ),
    });
  }
  const claudeLocal = await host.readFile(joinPath(locations.projectCwd, "CLAUDE.local.md"));
  if (claudeLocal !== null) {
    files.push({
      path: projectFiles.claudeLocal,
      content: Buffer.from(rewrite(claudeLocal.toString("utf8"))),
    });
  }

  const localMemory = joinPath(
    ".claude/projects",
    encodeProjectDir(locations.projectCwd),
    "memory",
  );
  const remoteMemory = joinPath(
    ".claude/projects",
    encodeProjectDir(locations.remoteCwd),
    "memory",
  );
  for (const file of await host.listFiles(fromHome(localMemory))) {
    const content = await host.readFile(fromHome(joinPath(localMemory, file)));
    if (content === null) continue;
    files.push({
      path: joinPath(remoteMemory, file),
      content: file.endsWith(".md") ? rewriteText(content) : content,
    });
  }

  const claudeJson = await host.readFile(fromHome(".claude.json"));
  let mcpRaw: unknown = undefined;
  if (claudeJson !== null) {
    try {
      mcpRaw = (JSON.parse(claudeJson.toString("utf8")) as { mcpServers?: unknown }).mcpServers;
    } catch {
      mcpRaw = undefined;
    }
  }
  const { kept, droppedMcp, needsSecret, leftBehind: mcpLeftBehind } = filterMcpServers(mcpRaw);
  leftBehind.push(...mcpLeftBehind);
  const fragment = { hasCompletedOnboarding: true, mcpServers: kept };
  files.push({
    path: CLAUDE_JSON_FRAGMENT_PATH,
    content: Buffer.from(rewrite(JSON.stringify(fragment, null, 2))),
  });

  // A token can also sit in a permission rule, a memory note or a skill. Mask it
  // there instead of letting SandboxClient refuse the whole sync.
  const { mask } = makeSecretMasker([]);
  const masked = files.map((entry) => {
    if (entry.content.includes(0)) return entry;
    const text = entry.content.toString("utf8");
    const clean = mask(text);
    if (clean === text) return entry;
    leftBehind.push({ item: entry.path, reason: "a token in it was masked" });
    return { path: entry.path, content: Buffer.from(clean) };
  });
  files.splice(0, files.length, ...masked);

  const git = await readGitIdentity(host);
  const hash = hashBundle(
    files.map((file) => [file.path, sha256(file.content)] as const),
    git,
  );
  return {
    files,
    git,
    hash,
    droppedMcp,
    needsSecret,
    leftBehind,
    managedDirs: [...WHOLE_DIRS, ".claude/plugins", remoteMemory],
    managedFiles: [...PLAIN_FILES, projectFiles.settingsLocal, projectFiles.claudeLocal],
  };
};

export interface SyncResult {
  readonly skipped: boolean;
  readonly hash: string;
  readonly fileCount: number;
  readonly bytes: number;
}

const readRemoteMarker = async (sandbox: SandboxHandle, remoteHome: string) => {
  const raw = await sandbox.readFile(joinPath(remoteHome, SYNC_MARKER_PATH)).catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw.toString("utf8")) as { hash?: string };
  } catch {
    return null;
  }
};

export const syncEnvironment = async (
  sandbox: SandboxHandle,
  bundle: EnvironmentBundle,
  remoteHome: string,
): Promise<SyncResult> => {
  const bytes = bundle.files.reduce((sum, file) => sum + file.content.length, 0);
  const summary = { hash: bundle.hash, fileCount: bundle.files.length, bytes };
  const marker = await readRemoteMarker(sandbox, remoteHome);
  if (marker?.hash === bundle.hash) return { skipped: true, ...summary };

  // Leftovers from an earlier failed sync must not be copied in again.
  await sandbox.sh(`rm -rf ${STAGING_DIR}`);
  await sandbox.writeFiles(
    bundle.files.map((file) => ({
      path: joinPath(STAGING_DIR, "files", file.path),
      content: file.content,
    })),
  );
  const markerJson = JSON.stringify({ hash: bundle.hash, syncedAt: new Date().toISOString() });
  await sandbox.sh(
    [
      "set -e",
      "cd ~",
      ...bundle.managedDirs.map((dir) => `rm -rf ${shellQuote(dir)}`),
      ...bundle.managedFiles.map((file) => `rm -f ${shellQuote(file)}`),
      "mkdir -p ~/.claude ~/.busyboy-cloud",
      `cp -a ${STAGING_DIR}/files/. ~/`,
      `node -e ${shellQuote(MERGE_CLAUDE_JSON_SCRIPT)}`,
      `git config --global user.name ${shellQuote(bundle.git.name)}`,
      `git config --global user.email ${shellQuote(bundle.git.email)}`,
      `printf '%s' ${shellQuote(markerJson)} > ~/${SYNC_MARKER_PATH}`,
      `rm -rf ${STAGING_DIR}`,
    ].join("\n"),
  );
  return { skipped: false, ...summary };
};

/** Hash of the synced files as they are now in the sandbox, comparable to bundle.hash. */
export const remoteBundleHash = async (
  sandbox: SandboxHandle,
  bundle: EnvironmentBundle,
): Promise<string> => {
  const manifest = "/tmp/busyboy-env-manifest.json";
  await sandbox.writeFiles([
    {
      path: manifest,
      content: Buffer.from(JSON.stringify({ paths: bundle.files.map((file) => file.path) })),
    },
  ]);
  return (await sandbox.sh(`node -e ${shellQuote(REMOTE_HASH_SCRIPT)} ${manifest}`)).trim();
};
