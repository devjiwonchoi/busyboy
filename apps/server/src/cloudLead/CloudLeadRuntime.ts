// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - cloud lead modules are promise-based like the @vercel/sandbox SDK and run outside the Effect runtime.
/**
 * Runs a cloud thread's claude CLI in its own Vercel Sandbox.
 *
 * prepare() gets a sandbox ready for a thread (once, then reused): it starts
 * from the base snapshot, copies the user's Claude setup and the Mac worktree
 * in, installs changed dependencies, restores earlier claude transcripts and
 * starts the relay. The adapter then spawns claude through the relay, and the
 * thread's t3-code MCP calls come back over the same relay.
 *
 * syncToMac() copies the sandbox's working tree onto the Mac worktree, which is
 * a read-only mirror while the thread is in the cloud. It runs before every
 * checkpoint, so diffs, review gates and PR linking read the Mac as usual.
 *
 * A sandbox idle for idleStopMs is deleted; the Mac mirror and the transcript
 * backup are enough for the next turn to start a new one and resume.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";

import { REMOTE_REPO_DIR } from "./BaseSnapshot.ts";
import { collectLocalBundle, shellQuote, syncEnvironment } from "./EnvironmentSync.ts";
import type { LocalHost } from "./LocalHost.ts";
import { encodeProjectDir, rewriteHomePaths } from "./pathRewrite.ts";
import { RELAY_FILES } from "./relay/relaySource.generated.ts";
import { RelayClient, type RelaySocketFactory, type RemoteProcess } from "./RelayClient.ts";
import type { SandboxClient, SandboxHandle } from "./SandboxClient.ts";
import {
  captureWorkspace,
  applyWorkspace,
  localMirrorShell,
  sandboxMirrorShell,
  type MirrorShell,
} from "./WorkspaceMirror.ts";

export const RELAY_PORT = 8787;
export const RELAY_MCP_PORT = 8788;
const SANDBOX_TIMEOUT_MS = 5 * 60 * 60 * 1000;
const DEFAULT_IDLE_STOP_MS = 30 * 60 * 1000;
const RELAY_CONNECT_TIMEOUT_MS = 60_000;
const SETUP_TIMEOUT_MS = 15 * 60 * 1000;

/** Secrets a cloud lead needs, passed to the sandbox only as command env. */
export interface CloudLeadCredentials {
  readonly claudeOauthToken: string;
  readonly githubToken: string | null;
}

export interface CloudLeadRuntimeDeps {
  readonly client: () => Promise<SandboxClient>;
  readonly credentials: () => Promise<CloudLeadCredentials>;
  /** The base snapshot to start from; null starts from the plain image (tests). */
  readonly baseSnapshotId: (client: SandboxClient, worktreePath: string) => Promise<string | null>;
  /** The Mac files the environment sync reads. */
  readonly host: LocalHost;
  /** Where transcript backups live on the Mac. */
  readonly stateDir: string;
  readonly macShell?: MirrorShell;
  readonly socketFactory?: RelaySocketFactory;
  /** The relay's WebSocket URL for a sandbox; defaults to wss:// on its public domain. */
  readonly relayUrl?: (sandbox: SandboxHandle) => string;
  readonly idleStopMs?: number;
  readonly vcpus?: number;
  /** Relay ports inside the sandbox; tests that run "sandboxes" locally pick free ones. */
  readonly ports?: { readonly relay: number; readonly mcp: number };
  /** The model local claude picks when settings name none; see SyncLocations.defaultModel. */
  readonly defaultModel?: () => Promise<string | undefined>;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
}

export interface CloudSpawnOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal | undefined;
}

export interface CloudLaunch {
  readonly spawn: (options: CloudSpawnOptions) => RemoteProcess;
  /** The t3-code MCP URL as the sandbox sees it. */
  readonly mcpUrl: string;
}

interface CloudSession {
  readonly threadId: string;
  readonly sandbox: SandboxHandle;
  readonly relay: RelayClient;
  readonly macCwd: string;
  readonly remoteHome: string;
  readonly remoteCwd: string;
  readonly credentials: CloudLeadCredentials;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/** SDK env keys that configure claude itself and mean the same in the sandbox. */
const PASS_ENV = /^(CLAUDE_|ANTHROPIC_|MCP_|DISABLE_|MAX_|BASH_|ENABLE_|USE_BUILTIN_)/;
/** Mac credentials and Mac-only settings that must not reach the sandbox. */
const DROP_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_GIT_BASH_PATH",
]);

const isScript = (path: string) => /\.(c|m)?js$/.test(path);

export class CloudLeadRuntime {
  private readonly deps: CloudLeadRuntimeDeps;
  private readonly sessions = new Map<string, Promise<CloudSession>>();

  constructor(deps: CloudLeadRuntimeDeps) {
    this.deps = deps;
  }

  private get ports() {
    return this.deps.ports ?? { relay: RELAY_PORT, mcp: RELAY_MCP_PORT };
  }

  /** Gets the thread's sandbox ready and returns how to run claude in it. */
  async prepare(input: {
    readonly threadId: string;
    readonly worktreePath: string;
    readonly mcpEndpoint: string;
  }): Promise<CloudLaunch> {
    const session = await this.session(input);
    this.cancelIdleStop(session);
    const mcpPath = new URL(input.mcpEndpoint).pathname;
    return {
      spawn: (options) => this.spawn(session, options),
      mcpUrl: `http://127.0.0.1:${this.ports.mcp}${mcpPath}`,
    };
  }

  /** Copies the sandbox working tree onto the Mac worktree. A no-op without a live sandbox. */
  async syncToMac(threadId: string): Promise<{ readonly head: string } | null> {
    const pending = this.sessions.get(threadId);
    if (pending === undefined) return null;
    const session = await pending.catch(() => null);
    if (session === null) return null;
    const mac = this.deps.macShell ?? localMirrorShell();
    const macHead = (
      await mac.run(`git -C ${shellQuote(session.macCwd)} rev-parse HEAD`).catch(() => "")
    ).trim();
    const state = await captureWorkspace(
      sandboxMirrorShell(session.sandbox),
      session.remoteCwd,
      /^[0-9a-f]{40}$/.test(macHead) ? macHead : null,
    );
    await applyWorkspace(mac, session.macCwd, state);
    await this.backupTranscripts(session).catch((error: unknown) =>
      this.log("cloud-lead.transcript-backup-failed", { threadId, error: String(error) }),
    );
    this.scheduleIdleStop(session);
    return { head: state.head };
  }

  /** Deletes the thread's sandbox. The Mac mirror and transcripts stay. */
  async release(threadId: string): Promise<void> {
    const pending = this.sessions.get(threadId);
    if (pending === undefined) return;
    this.sessions.delete(threadId);
    const session = await pending.catch(() => null);
    if (session === null) return;
    this.cancelIdleStop(session);
    session.relay.close();
    await session.sandbox.delete().catch(() => undefined);
    this.log("cloud-lead.sandbox-released", { threadId, sandbox: session.sandbox.name });
  }

  async releaseAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((threadId) => this.release(threadId)));
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  private session(input: {
    readonly threadId: string;
    readonly worktreePath: string;
    readonly mcpEndpoint: string;
  }): Promise<CloudSession> {
    const existing = this.sessions.get(input.threadId);
    if (existing !== undefined) return existing;
    const created = this.create(input);
    this.sessions.set(input.threadId, created);
    // A failed start must not stick: the next turn tries again.
    created.catch(() => {
      if (this.sessions.get(input.threadId) === created) this.sessions.delete(input.threadId);
    });
    return created;
  }

  private async create(input: {
    readonly threadId: string;
    readonly worktreePath: string;
    readonly mcpEndpoint: string;
  }): Promise<CloudSession> {
    const started = Date.now();
    const [client, credentials] = await Promise.all([
      this.deps.client(),
      this.deps.credentials(),
    ]);
    const snapshotId = await this.deps.baseSnapshotId(client, input.worktreePath);
    const sandbox = await client.create({
      ...(snapshotId === null ? {} : { snapshotId }),
      vcpus: this.deps.vcpus ?? 4,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      ports: [this.ports.relay],
    });
    try {
      const remoteHome = (await sandbox.sh('printf %s "$HOME"')).trim();
      const remoteCwd = `${remoteHome}/${REMOTE_REPO_DIR}`;
      const localHome = this.deps.host.env.HOME ?? "";
      const defaultModel = await this.deps.defaultModel?.();
      const bundle = await collectLocalBundle(this.deps.host, {
        projectCwd: input.worktreePath,
        remoteCwd,
        localHome,
        remoteHome,
        ...(defaultModel === undefined ? {} : { defaultModel }),
      });
      await syncEnvironment(sandbox, bundle, remoteHome);
      await this.mirrorIn(sandbox, input.worktreePath, remoteCwd);
      await this.restoreTranscripts(input.threadId, sandbox, remoteHome, remoteCwd);
      const relay = await this.startRelay(sandbox, remoteHome, input.mcpEndpoint);
      this.log("cloud-lead.sandbox-ready", {
        threadId: input.threadId,
        sandbox: sandbox.name,
        ms: Date.now() - started,
        envSynced: bundle.files.length,
      });
      return {
        threadId: input.threadId,
        sandbox,
        relay,
        macCwd: input.worktreePath,
        remoteHome,
        remoteCwd,
        credentials,
        idleTimer: null,
      };
    } catch (error) {
      await sandbox.delete().catch(() => undefined);
      throw error;
    }
  }

  /** Puts the Mac worktree (branch, commits, edits) into the sandbox clone. */
  private async mirrorIn(sandbox: SandboxHandle, macCwd: string, remoteCwd: string) {
    const mac = this.deps.macShell ?? localMirrorShell();
    const remote = sandboxMirrorShell(sandbox);
    const remoteHead = (
      await remote.run(`git -C ${shellQuote(remoteCwd)} rev-parse HEAD 2>/dev/null || true`)
    ).trim();
    const branch = (
      await mac.run(`git -C ${shellQuote(macCwd)} symbolic-ref --short -q HEAD || true`)
    ).trim();
    const known = /^[0-9a-f]{40}$/.test(remoteHead) ? remoteHead : null;
    const state = await captureWorkspace(mac, macCwd, known);
    await applyWorkspace(remote, remoteCwd, state, branch.length > 0 ? branch : undefined);
    await sandbox.sh(
      [
        "set -e",
        `cd ${shellQuote(remoteCwd)}`,
        // Pushes and gh use GH_TOKEN from the claude process env, never a file.
        "git config --global credential.https://github.com.helper '!gh auth git-credential'",
        known === null
          ? "true"
          : `if ! git diff --quiet ${known} HEAD -- pnpm-lock.yaml; then ` +
            "pnpm install --frozen-lockfile --prefer-offline >/dev/null; fi",
      ].join("\n"),
      { timeoutMs: SETUP_TIMEOUT_MS },
    );
  }

  private async startRelay(
    sandbox: SandboxHandle,
    remoteHome: string,
    mcpEndpoint: string,
  ): Promise<RelayClient> {
    const dir = `${remoteHome}/.busyboy-cloud/relay`;
    await sandbox.writeFiles(
      Object.entries(RELAY_FILES).map(([name, content]) => ({
        path: `${dir}/${name}`,
        content: Buffer.from(content),
      })),
    );
    const token = NodeCrypto.randomBytes(32).toString("base64url");
    await sandbox.startDetached({
      cmd: "node",
      args: ["--experimental-strip-types", "--no-warnings", `${dir}/server.ts`],
      env: {
        BUSYBOY_RELAY_TOKEN: token,
        BUSYBOY_RELAY_PORT: String(this.ports.relay),
        BUSYBOY_RELAY_MCP_PORT: String(this.ports.mcp),
      },
    });
    const url =
      this.deps.relayUrl?.(sandbox) ?? sandbox.domain(this.ports.relay).replace(/^http/, "ws");
    const relay = new RelayClient({
      url,
      token,
      mcpOrigin: new URL(mcpEndpoint).origin,
      ...(this.deps.socketFactory === undefined ? {} : { socketFactory: this.deps.socketFactory }),
    });
    try {
      await relay.waitUntilConnected(RELAY_CONNECT_TIMEOUT_MS);
    } catch (error) {
      relay.close();
      throw error;
    }
    return relay;
  }

  private spawn(session: CloudSession, options: CloudSpawnOptions): RemoteProcess {
    const rewrite = (text: string) =>
      rewriteHomePaths(
        rewriteHomePaths(text, { localHome: session.macCwd, remoteHome: session.remoteCwd }),
        { localHome: this.deps.host.env.HOME ?? "/nonexistent", remoteHome: session.remoteHome },
      );
    // The SDK runs a script entry as `node cli.js ...`; the sandbox has claude on PATH.
    const args = isScript(options.command)
      ? options.args
      : options.args.length > 0 && isScript(options.args[0]!)
        ? options.args.slice(1)
        : options.args;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env)) {
      if (value === undefined || DROP_ENV.has(key) || !PASS_ENV.test(key)) continue;
      env[key] = rewrite(value);
    }
    env.HOME = session.remoteHome;
    env.CLAUDE_CODE_OAUTH_TOKEN = session.credentials.claudeOauthToken;
    if (session.credentials.githubToken !== null) env.GH_TOKEN = session.credentials.githubToken;
    const child = session.relay.spawnRemote({
      command: "claude",
      args: args.map(rewrite),
      cwd: options.cwd === undefined ? session.remoteCwd : rewrite(options.cwd),
      env,
    });
    if (options.signal !== undefined) {
      if (options.signal.aborted) child.kill("SIGTERM");
      else options.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    }
    this.cancelIdleStop(session);
    return child;
  }

  private transcriptBackupPath(threadId: string) {
    const name = NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 32);
    return `${this.deps.stateDir}/cloud-lead-sessions/${name}.tgz`;
  }

  private transcriptDir(session: { remoteHome: string; remoteCwd: string }) {
    return `${session.remoteHome}/.claude/projects/${encodeProjectDir(session.remoteCwd)}`;
  }

  /** Keeps the sandbox's claude transcripts on the Mac, so a new sandbox can resume. */
  private async backupTranscripts(session: CloudSession) {
    const dir = this.transcriptDir(session);
    const archive = "/tmp/busyboy-transcripts.tgz";
    await session.sandbox.sh(
      `rm -f ${archive}; if [ -d ${shellQuote(dir)} ]; then tar -czf ${archive} -C ${shellQuote(dir)} .; fi`,
    );
    const content = await session.sandbox.readFile(archive);
    if (content === null) return;
    const path = this.transcriptBackupPath(session.threadId);
    await NodeFs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await NodeFs.writeFile(path, content, { mode: 0o600 });
  }

  private async restoreTranscripts(
    threadId: string,
    sandbox: SandboxHandle,
    remoteHome: string,
    remoteCwd: string,
  ) {
    const content = await NodeFs.readFile(this.transcriptBackupPath(threadId)).catch(() => null);
    if (content === null) return;
    const archive = "/tmp/busyboy-transcripts.tgz";
    const dir = this.transcriptDir({ remoteHome, remoteCwd });
    try {
      await sandbox.writeFiles([{ path: archive, content }]);
      await sandbox.sh(`mkdir -p ${shellQuote(dir)} && tar -xzf ${archive} -C ${shellQuote(dir)}`);
    } catch (error) {
      // A transcript holding a token-shaped string is refused; the turn starts fresh instead.
      this.log("cloud-lead.transcript-restore-skipped", { threadId, error: String(error) });
    }
  }

  private scheduleIdleStop(session: CloudSession) {
    this.cancelIdleStop(session);
    session.idleTimer = setTimeout(() => {
      void this.release(session.threadId);
    }, this.deps.idleStopMs ?? DEFAULT_IDLE_STOP_MS);
    session.idleTimer.unref?.();
  }

  private cancelIdleStop(session: CloudSession) {
    if (session.idleTimer !== null) clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  private log(event: string, data: Record<string, unknown>) {
    this.deps.log?.(event, data);
  }
}
