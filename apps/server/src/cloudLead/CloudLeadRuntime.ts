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
 *
 * One Mac worktree has one sandbox. A cloud lead's children (implement, fix,
 * review) work in the lead's worktree, so they share its sandbox and checkout,
 * and the mirror, idle stop and release cover all of them. Codex children run
 * `codex app-server` there through the same relay.
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
/**
 * A sandbox stops on its own this long after the server stops extending it,
 * so a crashed or killed server does not leave one billing for hours.
 */
const SANDBOX_TIMEOUT_MS = 45 * 60 * 1000;
const KEEPALIVE_EVERY_MS = 10 * 60 * 1000;
const MAX_IDLE_SYNC_FAILURES = 3;
const DEFAULT_IDLE_STOP_MS = 30 * 60 * 1000;
const RELAY_CONNECT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ROTATION_MARGIN_MS = 30 * 60 * 1000;
const DEFAULT_ROTATION_CHECK_MS = 60 * 1000;
const SETUP_TIMEOUT_MS = 15 * 60 * 1000;

/** Secrets a cloud lead needs, passed to the sandbox only as command env. */
export interface CloudLeadCredentials {
  readonly claudeOauthToken: string;
  readonly githubToken: string | null;
}

/**
 * The cloud's own ChatGPT login for Codex (an auth.json from a separate
 * `codex login`, never the Mac's: two machines refreshing one login log each
 * other out). Codex refreshes it while it runs, so the newest copy is saved back.
 */
export interface CodexCloudAuth {
  readonly read: () => Promise<string | null>;
  readonly save: (authJson: string) => Promise<void>;
}

/**
 * transient: the login may work again soon (another sandbox holds it, the
 * sandbox is not up), so a fallback should cover only the current step.
 */
export type CodexCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly transient: boolean };

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
  /** Absent: Codex never runs in the cloud and its children fall back to Claude. */
  readonly codexAuth?: CodexCloudAuth;
  readonly log?: (event: string, data: Record<string, unknown>) => void;
  /** How long a sandbox may live; it is replaced rotationMarginMs before that. */
  readonly maxLifetimeMs?: number;
  readonly rotationMarginMs?: number;
  /** How often a live sandbox looks at its age. */
  readonly rotationCheckMs?: number;
  /** The clock sandbox ages are read from; tests pass a fake one. */
  readonly now?: () => number;
}

/**
 * What the service layer does around a sandbox replaced mid-turn: stop the
 * turn with its queue held, then let the queue run on the new sandbox. A
 * failed replacement is reported so the user can bring the lead to the Mac.
 */
export interface CloudLeadRotationHandler {
  /** True while the lead is being moved; the rotation waits for the next check. */
  readonly busy?: (threadId: string) => boolean;
  /** Stops the thread's running turn, holding its queue; resolves once it ended. */
  readonly interrupt: (threadId: string) => Promise<void>;
  readonly resume: (threadId: string) => Promise<void>;
  readonly failed: (threadId: string, reason: string) => Promise<void>;
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
  /** Starts `codex app-server` in the sandbox with the cloud Codex login. */
  readonly spawnCodex: (options: CodexSpawnOptions) => Promise<RemoteProcess>;
  /** The t3-code MCP URL as the sandbox sees it. */
  readonly mcpUrl: string;
  /** Maps Mac paths and the Mac MCP endpoint to what the sandbox sees, and back. */
  readonly paths: {
    readonly toRemote: (text: string) => string;
    readonly toMac: (text: string) => string;
  };
}

export interface CodexSpawnOptions {
  /** Arguments after `codex`, such as ["app-server"]. */
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface PrepareInput {
  readonly threadId: string;
  /** The Mac worktree; threads in the same one share a sandbox. */
  readonly worktreePath: string;
  readonly mcpEndpoint: string;
}

interface CloudSession {
  /** The Mac worktree this sandbox mirrors; every thread working there shares it. */
  readonly key: string;
  /** The thread whose turn started the sandbox, usually the lead. */
  readonly threadId: string;
  /** Running remote processes per thread, so a replacement can stop each one's turn. */
  readonly runningThreads: Map<string, number>;
  readonly sandbox: SandboxHandle;
  readonly relay: RelayClient;
  readonly macCwd: string;
  readonly remoteHome: string;
  readonly remoteCwd: string;
  readonly credentials: CloudLeadCredentials;
  idleTimer: ReturnType<typeof setTimeout> | null;
  readonly keepAlive: ReturnType<typeof setInterval>;
  /** Remote processes (claude, codex) still running; the sandbox only idles out at zero. */
  running: number;
  codexRunning: number;
  codexConfigSynced: boolean;
  /** codex started here with the cloud login, so the sandbox may hold a refreshed copy. */
  codexAuthInstalled: boolean;
  idleSyncFailures: number;
  /** How many turns prepared this sandbox; an idle stop gives up if it changes. */
  uses: number;
  released: boolean;
  /** When the sandbox was created, on deps.now's clock. */
  readonly createdAt: number;
  rotationCheck: ReturnType<typeof setInterval> | null;
  /** A failed replacement is not tried again on the same sandbox. */
  rotation: "idle" | "rotating" | "failed";
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

/**
 * Copies claude session files (<id>.jsonl and its <id>/ folder) from $1 to $2,
 * readable only by the user. Project memory and other files stay put.
 */
const TRANSCRIPT_SHELL = `set -e
umask 077
copy_sessions() {
  for f in "$1"/*.jsonl; do
    [ -f "$f" ] || continue
    name=$(basename "$f" .jsonl)
    cp "$f" "$2/$name.jsonl"
    chmod 600 "$2/$name.jsonl"
    if [ -d "$1/$name" ]; then
      rm -rf "$2/$name"
      cp -R "$1/$name" "$2/$name"
      chmod -R go-rwx "$2/$name"
    fi
  done
}`;

/** Codex env keys that configure codex itself; credentials never come from the Mac. */
const CODEX_PASS_ENV = /^(CODEX_|RUST_LOG$)/;
const CODEX_DROP_ENV = new Set(["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY"]);
/** Codex's own sandbox (bubblewrap) cannot start in a Vercel VM; the VM is the sandbox. */
const CODEX_CLOUD_ARGS = ["-c", 'sandbox_mode="danger-full-access"'];
const CODEX_CHECK_TIMEOUT_MS = 60_000;

export class CloudLeadRuntime {
  private readonly deps: CloudLeadRuntimeDeps;
  private readonly sessions = new Map<string, Promise<CloudSession>>();
  private readonly syncs = new Map<string, Promise<{ readonly head: string } | null>>();
  /** Sandboxes being mirrored a last time and deleted; a new turn waits for these. */
  private readonly releasing = new Map<string, Promise<void>>();
  private rotationHandler: CloudLeadRotationHandler | null = null;
  /** Thread -> the Mac worktree (session key) it last prepared in. */
  private readonly worktrees = new Map<string, string>();
  /** The one sandbox using the cloud Codex login: a login refreshed in two places logs out. */
  private codexHolder: string | null = null;

  constructor(deps: CloudLeadRuntimeDeps) {
    this.deps = deps;
  }

  setRotationHandler(handler: CloudLeadRotationHandler | null) {
    this.rotationHandler = handler;
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  private get ports() {
    return this.deps.ports ?? { relay: RELAY_PORT, mcp: RELAY_MCP_PORT };
  }

  /** Gets the thread's sandbox ready and returns how to run claude or codex in it. */
  async prepare(input: PrepareInput): Promise<CloudLaunch> {
    this.worktrees.set(input.threadId, input.worktreePath);
    const session = await this.session(input);
    // Released between the lookup and now: wait for that and take a new sandbox.
    if (session.released) return this.prepare(input);
    // Near its limit and between turns: replace it before this turn starts.
    if (session.running === 0 && session.rotation === "idle" && this.rotationDue(session)) {
      if (await this.rotate(session, false)) return this.prepare(input);
    }
    this.cancelIdleStop(session);
    session.uses += 1;
    const mcpPath = new URL(input.mcpEndpoint).pathname;
    const mcpUrl = `http://127.0.0.1:${this.ports.mcp}${mcpPath}`;
    const macOrigin = new URL(input.mcpEndpoint).origin;
    const remoteOrigin = new URL(mcpUrl).origin;
    return {
      spawn: (options) => this.spawn(session, options, input.threadId),
      spawnCodex: (options) => this.spawnCodex(session, options, input.threadId),
      mcpUrl,
      paths: {
        toRemote: (text) => this.toRemote(session, text).split(macOrigin).join(remoteOrigin),
        toMac: (text) =>
          rewriteHomePaths(text, { localHome: session.remoteCwd, remoteHome: session.macCwd }),
      },
    };
  }

  /**
   * Whether a Codex child can start in the live sandbox of this Mac worktree:
   * the cloud login exists, no other sandbox holds it, and `codex login status`
   * accepts it there.
   */
  async checkCodex(worktreePath: string): Promise<CodexCheck> {
    const auth = await this.deps.codexAuth?.read().catch(() => null);
    if (auth === null || auth === undefined) {
      return {
        ok: false,
        reason: "no cloud Codex login is saved (cloud secret codex_auth_json)",
        transient: false,
      };
    }
    // `codex login status` trusts any auth.json, even one without tokens.
    if (!hasCodexCredentials(auth)) {
      return {
        ok: false,
        reason: "the saved cloud Codex login has no tokens or API key",
        transient: false,
      };
    }
    if (this.codexHolder !== null && this.codexHolder !== worktreePath) {
      return {
        ok: false,
        reason: "another cloud sandbox is using the cloud Codex login",
        transient: true,
      };
    }
    const pending = this.sessions.get(worktreePath);
    if (pending === undefined) {
      return { ok: false, reason: "the lead's cloud sandbox is not running", transient: true };
    }
    try {
      const session = await pending;
      await this.syncCodexConfig(session);
      const result = await session.sandbox.runCommand({
        cmd: "bash",
        args: ["-c", `${this.codexAuthScript(session)} && codex login status`],
        env: { BUSYBOY_CODEX_AUTH: auth, CODEX_HOME: this.codexHome(session) },
        timeoutMs: CODEX_CHECK_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        return {
          ok: false,
          reason: `codex did not start in the sandbox (exit ${result.exitCode}): ${
            (result.stderr || result.stdout).trim().slice(0, 300) || "no output"
          }`,
          transient: false,
        };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: `codex did not start in the sandbox: ${errorText(error)}`,
        transient: true,
      };
    }
  }

  /**
   * Copies the sandbox working tree onto the Mac worktree; a no-op without a
   * live sandbox. Callers (turn end, team gates, release) may overlap, so
   * syncs of one thread run one at a time.
   */
  syncToMac(threadId: string): Promise<{ readonly head: string } | null> {
    const key = this.worktrees.get(threadId);
    return key === undefined ? Promise.resolve(null) : this.syncKey(key);
  }

  private syncKey(key: string): Promise<{ readonly head: string } | null> {
    const pending = this.sessions.get(key);
    // During a release, wait for its final mirror so callers read a finished worktree.
    if (pending === undefined) {
      return (this.releasing.get(key) ?? Promise.resolve()).then(() => null);
    }
    return this.syncLocked(key, pending);
  }

  private syncLocked(
    threadId: string,
    pending: Promise<CloudSession>,
  ): Promise<{ readonly head: string } | null> {
    const previous = this.syncs.get(threadId) ?? Promise.resolve(null);
    const next = previous.catch(() => null).then(() => this.syncOnce(threadId, pending));
    this.syncs.set(threadId, next);
    const forget = () => {
      if (this.syncs.get(threadId) === next) this.syncs.delete(threadId);
    };
    next.then(forget, forget);
    return next;
  }

  private async syncOnce(
    threadId: string,
    pending: Promise<CloudSession>,
  ): Promise<{ readonly head: string } | null> {
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
    session.idleSyncFailures = 0;
    await this.backupTranscripts(session).catch((error: unknown) =>
      this.log("cloud-lead.transcript-backup-failed", { threadId, error: String(error) }),
    );
    if (!session.released) this.scheduleIdleStop(session);
    return { head: state.head };
  }

  /**
   * Mirrors the sandbox one last time, then deletes it. The Mac mirror and the
   * transcripts stay, so a later turn starts a new sandbox from them.
   */
  release(threadId: string, options: { readonly synced?: boolean } = {}): Promise<void> {
    const key = this.worktrees.get(threadId);
    return key === undefined ? Promise.resolve() : this.releaseKey(key, options);
  }

  private releaseKey(threadId: string, options: { readonly synced?: boolean } = {}): Promise<void> {
    const pending = this.sessions.get(threadId);
    if (pending === undefined) return this.releasing.get(threadId) ?? Promise.resolve();
    // Unmapped right away: a turn starting now waits for this and gets a new sandbox.
    this.sessions.delete(threadId);
    const done = (async () => {
      const session = await pending.catch(() => null);
      if (session === null) return;
      session.released = true;
      this.cancelIdleStop(session);
      if (options.synced !== true) {
        await this.syncLocked(threadId, pending).catch((error: unknown) =>
          this.log("cloud-lead.final-sync-failed", { threadId, error: String(error) }),
        );
      }
      // Codex may have refreshed the cloud login; keep it before the sandbox goes.
      await this.saveCodexAuth(session);
      clearInterval(session.keepAlive);
      if (session.rotationCheck !== null) clearInterval(session.rotationCheck);
      session.relay.close();
      // Its codex processes end with the relay; the login is free for other sandboxes.
      if (this.codexHolder === session.key) this.codexHolder = null;
      await session.sandbox.delete().catch(() => undefined);
      this.log("cloud-lead.sandbox-released", {
        worktree: threadId,
        sandbox: session.sandbox.name,
      });
    })();
    this.releasing.set(threadId, done);
    const forget = () => {
      if (this.releasing.get(threadId) !== done) return;
      this.releasing.delete(threadId);
      if (this.sessions.has(threadId)) return;
      for (const [thread, worktree] of this.worktrees) {
        if (worktree === threadId) this.worktrees.delete(thread);
      }
    };
    done.then(forget, forget);
    return done;
  }

  async releaseAll(): Promise<void> {
    await Promise.all([
      ...[...this.sessions.keys()].map((key) => this.releaseKey(key)),
      ...this.releasing.values(),
    ]);
  }

  hasSession(threadId: string): boolean {
    const key = this.worktrees.get(threadId);
    return key !== undefined && this.sessions.has(key);
  }

  private session(input: PrepareInput): Promise<CloudSession> {
    const key = input.worktreePath;
    const existing = this.sessions.get(key);
    if (existing !== undefined) return existing;
    const releasing = this.releasing.get(key);
    if (releasing !== undefined) return releasing.then(() => this.session(input));
    const created = this.create(input);
    this.sessions.set(key, created);
    // A failed start must not stick: the next turn tries again.
    created.catch(() => {
      if (this.sessions.get(key) === created) this.sessions.delete(key);
    });
    return created;
  }

  private async create(input: PrepareInput): Promise<CloudSession> {
    const key = input.worktreePath;
    const started = Date.now();
    const createdAt = this.now();
    const [client, credentials] = await Promise.all([this.deps.client(), this.deps.credentials()]);
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
      await this.restoreTranscripts([key, input.threadId], sandbox, remoteHome, remoteCwd);
      const relay = await this.startRelay(sandbox, remoteHome, input.mcpEndpoint, () => {
        // The relay is gone (sandbox stopped or unreachable): mirror what the
        // sandbox API can still reach and start over on the next turn.
        this.log("cloud-lead.relay-unreachable", { threadId: input.threadId });
        void this.releaseKey(key);
      });
      this.log("cloud-lead.sandbox-ready", {
        threadId: input.threadId,
        sandbox: sandbox.name,
        ms: Date.now() - started,
        envSynced: bundle.files.length,
      });
      const keepAlive = setInterval(() => {
        sandbox.extendTimeout(KEEPALIVE_EVERY_MS).catch((error: unknown) =>
          this.log("cloud-lead.keepalive-failed", {
            threadId: input.threadId,
            error: String(error),
          }),
        );
      }, KEEPALIVE_EVERY_MS);
      keepAlive.unref?.();
      const session: CloudSession = {
        key,
        threadId: input.threadId,
        runningThreads: new Map(),
        sandbox,
        relay,
        keepAlive,
        macCwd: input.worktreePath,
        remoteHome,
        remoteCwd,
        credentials,
        idleTimer: null,
        running: 0,
        codexRunning: 0,
        codexConfigSynced: false,
        codexAuthInstalled: false,
        idleSyncFailures: 0,
        uses: 0,
        released: false,
        createdAt,
        rotationCheck: null,
        rotation: "idle",
      };
      session.rotationCheck = setInterval(() => {
        if (session.rotation === "idle" && this.rotationDue(session)) {
          void this.rotate(session, session.running > 0);
        }
      }, this.deps.rotationCheckMs ?? DEFAULT_ROTATION_CHECK_MS);
      session.rotationCheck.unref?.();
      return session;
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
    onGiveUp: () => void,
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
      mcpEndpoint,
      onGiveUp,
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

  /** Mac worktree and home paths as the sandbox sees them. */
  private toRemote(session: CloudSession, text: string): string {
    return rewriteHomePaths(
      rewriteHomePaths(text, { localHome: session.macCwd, remoteHome: session.remoteCwd }),
      { localHome: this.deps.host.env.HOME ?? "/nonexistent", remoteHome: session.remoteHome },
    );
  }

  private spawn(
    session: CloudSession,
    options: CloudSpawnOptions,
    threadId: string,
  ): RemoteProcess {
    if (session.released) {
      throw new Error("The cloud sandbox for this thread was stopped; start the turn again.");
    }
    const rewrite = (text: string) => this.toRemote(session, text);
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
    this.track(session, child, threadId);
    return child;
  }

  /** Counts a running process, so the sandbox does not idle out under it. */
  private track(
    session: CloudSession,
    child: RemoteProcess,
    threadId: string,
    onExit?: () => void,
  ) {
    this.cancelIdleStop(session);
    session.running += 1;
    session.runningThreads.set(threadId, (session.runningThreads.get(threadId) ?? 0) + 1);
    child.once("exit", () => {
      session.running -= 1;
      const left = (session.runningThreads.get(threadId) ?? 1) - 1;
      if (left > 0) session.runningThreads.set(threadId, left);
      else session.runningThreads.delete(threadId);
      onExit?.();
      if (session.running === 0) this.scheduleIdleStop(session);
    });
  }

  private codexHome(session: CloudSession) {
    return `${session.remoteHome}/.codex`;
  }

  /**
   * Puts the cloud Codex login from $BUSYBOY_CODEX_AUTH into the sandbox's
   * CODEX_HOME, where codex reads and refreshes it. It comes in only as env,
   * and only when the sandbox has none: a copy there may be newer (refreshed).
   */
  private codexAuthScript(session: CloudSession) {
    const home = shellQuote(this.codexHome(session));
    return [
      `mkdir -p ${home}`,
      `{ [ -s ${home}/auth.json ] || (umask 077 && printf '%s' "$BUSYBOY_CODEX_AUTH" > ${home}/auth.json); }`,
      "unset BUSYBOY_CODEX_AUTH",
    ].join(" && ");
  }

  private async spawnCodex(session: CloudSession, options: CodexSpawnOptions, threadId: string) {
    if (session.released) {
      throw new Error("The cloud sandbox for this thread was stopped; start the turn again.");
    }
    const auth = await this.deps.codexAuth?.read();
    if (auth === null || auth === undefined) {
      throw new Error("No cloud Codex login is saved (cloud secret codex_auth_json).");
    }
    if (this.codexHolder !== null && this.codexHolder !== session.key) {
      throw new Error("Another cloud sandbox is using the cloud Codex login.");
    }
    await this.syncCodexConfig(session);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env)) {
      if (value === undefined || CODEX_DROP_ENV.has(key) || !CODEX_PASS_ENV.test(key)) continue;
      env[key] = this.toRemote(session, value);
    }
    env.HOME = session.remoteHome;
    env.CODEX_HOME = this.codexHome(session);
    env.BUSYBOY_CODEX_AUTH = auth;
    if (session.credentials.githubToken !== null) env.GH_TOKEN = session.credentials.githubToken;
    const args = [...CODEX_CLOUD_ARGS, ...options.args.map((arg) => this.toRemote(session, arg))];
    // Re-checked after the awaits above; nothing awaits from here to the spawn.
    if (session.released) {
      throw new Error("The cloud sandbox for this thread was stopped; start the turn again.");
    }
    if (this.codexHolder !== null && this.codexHolder !== session.key) {
      throw new Error("Another cloud sandbox is using the cloud Codex login.");
    }
    const child = session.relay.spawnRemote({
      command: "bash",
      args: ["-c", `${this.codexAuthScript(session)} && exec codex "$@"`, "codex", ...args],
      cwd: session.remoteCwd,
      env,
    });
    this.codexHolder = session.key;
    session.codexRunning += 1;
    session.codexAuthInstalled = true;
    this.track(session, child, threadId, () => {
      session.codexRunning -= 1;
      // A release saves the login itself before deleting the sandbox.
      if (!session.released) void this.saveCodexAuth(session);
    });
    return child;
  }

  /**
   * Puts the Mac's claude transcripts for `macCwd` into the worktree's backup
   * (shared by the lead and its children), over any older copies, so the next
   * sandbox restores them and resumes.
   */
  async importTranscripts(_threadId: string, macCwd: string): Promise<void> {
    const backup = this.transcriptBackupPath(macCwd);
    await this.mac().run(
      [
        TRANSCRIPT_SHELL,
        `src=${shellQuote(await this.macTranscriptDir(macCwd))}`,
        `backup=${shellQuote(backup)}`,
        "tmp=$(mktemp -d); trap 'rm -rf \"$tmp\"' EXIT",
        'if [ -f "$backup" ]; then tar -xzf "$backup" -C "$tmp"; fi',
        'if [ -d "$src" ]; then copy_sessions "$src" "$tmp"; fi',
        'if [ -z "$(ls -A "$tmp")" ]; then exit 0; fi',
        'mkdir -p "$(dirname "$backup")"; chmod 700 "$(dirname "$backup")"',
        'tar -czf "$backup.part" -C "$tmp" .',
        'chmod 600 "$backup.part"; mv -f "$backup.part" "$backup"',
      ].join("\n"),
    );
  }

  /** Unpacks the worktree's transcript backup into the Mac's claude folder for `macCwd`. */
  async exportTranscripts(_threadId: string, macCwd: string): Promise<void> {
    await this.mac().run(
      [
        TRANSCRIPT_SHELL,
        `dst=${shellQuote(await this.macTranscriptDir(macCwd))}`,
        `backup=${shellQuote(this.transcriptBackupPath(macCwd))}`,
        'if [ ! -f "$backup" ]; then exit 0; fi',
        "tmp=$(mktemp -d); trap 'rm -rf \"$tmp\"' EXIT",
        'tar -xzf "$backup" -C "$tmp"',
        'mkdir -p "$dst"; chmod 700 "$dst"',
        'copy_sessions "$tmp" "$dst"',
      ].join("\n"),
    );
  }

  /** Whether claude session `sessionId` can resume at `location` for this thread. */
  async hasTranscript(input: {
    readonly threadId: string;
    readonly macCwd: string;
    readonly sessionId: string;
    readonly location: "local" | "cloud";
  }): Promise<boolean> {
    const name = `${input.sessionId}.jsonl`;
    const script =
      input.location === "local"
        ? `if [ -f ${shellQuote(`${await this.macTranscriptDir(input.macCwd)}/${name}`)} ]; then echo yes; fi`
        : `if tar -tzf ${shellQuote(this.transcriptBackupPath(input.macCwd))} 2>/dev/null | grep -qxF -e ${shellQuote(`./${name}`)} -e ${shellQuote(name)}; then echo yes; fi`;
    return (await this.mac().run(script)).trim() === "yes";
  }

  private mac() {
    return this.deps.macShell ?? localMirrorShell();
  }

  /** Where Mac claude keeps transcripts for a cwd; it names the folder after the real path. */
  private async macTranscriptDir(macCwd: string) {
    const real = await NodeFs.realpath(macCwd).catch(() => macCwd);
    return `${this.deps.host.env.HOME ?? ""}/.claude/projects/${encodeProjectDir(real)}`;
  }

  /**
   * Copies the Mac's ~/.codex/config.toml (model, MCP servers, features) into
   * the sandbox once, with home paths rewritten. A config that holds a secret
   * is refused by writeFiles and left behind; codex then runs on its defaults.
   */
  private async syncCodexConfig(session: CloudSession) {
    if (session.codexConfigSynced) return;
    session.codexConfigSynced = true;
    const localHome = this.deps.host.env.HOME ?? "";
    const codexHome = this.deps.host.env.CODEX_HOME ?? `${localHome}/.codex`;
    const config = await this.deps.host.readFile(`${codexHome}/config.toml`).catch(() => null);
    if (config === null) return;
    try {
      await session.sandbox.writeFiles([
        {
          path: `${this.codexHome(session)}/config.toml`,
          content: Buffer.from(this.toRemote(session, config.toString("utf8"))),
        },
      ]);
    } catch (error) {
      this.log("cloud-lead.codex-config-skipped", {
        worktree: session.key,
        error: errorText(error),
      });
    }
  }

  /**
   * Keeps the login codex refreshed in the sandbox, and frees it for other
   * sandboxes once no codex runs here.
   */
  private async saveCodexAuth(session: CloudSession) {
    try {
      if (!session.codexAuthInstalled) return;
      const current = await session.sandbox.readFile(`${this.codexHome(session)}/auth.json`);
      const text = current === null ? "" : current.toString("utf8");
      const saved = await this.deps.codexAuth?.read();
      if (hasCodexCredentials(text) && text !== saved) await this.deps.codexAuth?.save(text);
    } catch (error) {
      this.log("cloud-lead.codex-auth-save-failed", {
        worktree: session.key,
        error: errorText(error),
      });
    } finally {
      if (session.codexRunning === 0 && this.codexHolder === session.key) {
        this.codexHolder = null;
      }
    }
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
    const path = this.transcriptBackupPath(session.key);
    await NodeFs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true, mode: 0o700 });
    await NodeFs.writeFile(path, content, { mode: 0o600 });
  }

  /** The first backup found: by worktree, else one kept by thread before sandboxes were shared. */
  private async restoreTranscripts(
    backupKeys: ReadonlyArray<string>,
    sandbox: SandboxHandle,
    remoteHome: string,
    remoteCwd: string,
  ) {
    let content: Buffer | null = null;
    for (const backupKey of backupKeys) {
      content ??= await NodeFs.readFile(this.transcriptBackupPath(backupKey)).catch(() => null);
    }
    if (content === null) return;
    const threadId = backupKeys.at(-1);
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

  private rotationDue(session: CloudSession) {
    const lifetime = this.deps.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
    const margin = this.deps.rotationMarginMs ?? DEFAULT_ROTATION_MARGIN_MS;
    return this.now() - session.createdAt >= lifetime - margin;
  }

  /**
   * Replaces a sandbox near its lifetime limit: stops a running turn through
   * the handler, mirrors the work and transcripts to the Mac, and deletes the
   * sandbox, so the next turn starts a new one and resumes the same session.
   * True when the sandbox was replaced.
   */
  private async rotate(session: CloudSession, midTurn: boolean): Promise<boolean> {
    if (session.released || session.rotation !== "idle") return false;
    const handler = this.rotationHandler;
    const threadId = session.threadId;
    if (handler?.busy?.(threadId) === true) return false;
    session.rotation = "rotating";
    const uses = session.uses;
    // Every thread with a turn running here: the lead and the children sharing its sandbox.
    const stopped = midTurn ? [...session.runningThreads.keys()] : [];
    if (midTurn && stopped.length === 0) stopped.push(threadId);
    const resumeAll = () =>
      Promise.all(stopped.map((thread) => handler?.resume(thread).catch(() => undefined)));
    try {
      if (midTurn) {
        if (handler === null) throw new Error("Nothing can stop the running turn.");
        for (const thread of stopped) await handler.interrupt(thread);
      }
      if (session.released) return true;
      // A failed mirror throws here and keeps the sandbox, so no work is lost.
      await this.syncKey(session.key);
      // Between turns, a turn that began during the mirror keeps this sandbox for now.
      if (!midTurn && (session.running > 0 || session.uses !== uses)) {
        session.rotation = "idle";
        return false;
      }
      await this.releaseKey(session.key, { synced: true });
      this.log("cloud-lead.sandbox-rotated", { threadId, sandbox: session.sandbox.name, midTurn });
      if (midTurn) await resumeAll();
      return true;
    } catch (error) {
      session.rotation = "failed";
      this.log("cloud-lead.sandbox-rotation-failed", { threadId, error: String(error) });
      if (midTurn) await resumeAll();
      await handler
        ?.failed(threadId, error instanceof Error ? error.message : String(error))
        .catch(() => undefined);
      return false;
    }
  }

  private scheduleIdleStop(session: CloudSession) {
    this.cancelIdleStop(session);
    if (session.running > 0) return;
    session.idleTimer = setTimeout(() => {
      void this.stopIdle(session);
    }, this.deps.idleStopMs ?? DEFAULT_IDLE_STOP_MS);
    session.idleTimer.unref?.();
  }

  /**
   * An idle sandbox goes away only once its work is safely on the Mac. A failed
   * mirror keeps it for another idle window, a few times, before giving up.
   */
  private async stopIdle(session: CloudSession) {
    session.idleTimer = null;
    if (session.running > 0 || session.released) return;
    const uses = session.uses;
    try {
      await this.syncKey(session.key);
    } catch (error) {
      session.idleSyncFailures += 1;
      this.log("cloud-lead.idle-sync-failed", {
        worktree: session.key,
        attempt: session.idleSyncFailures,
        error: String(error),
      });
      if (session.idleSyncFailures < MAX_IDLE_SYNC_FAILURES) {
        this.scheduleIdleStop(session);
        return;
      }
    }
    // A turn may have started, or been prepared, while the mirror ran. Nothing
    // awaits between this check and release() unmapping the session.
    if (session.running > 0 || session.uses !== uses || session.released) return;
    await this.releaseKey(session.key, { synced: true });
  }

  private cancelIdleStop(session: CloudSession) {
    if (session.idleTimer !== null) clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  private log(event: string, data: Record<string, unknown>) {
    this.deps.log?.(event, data);
  }
}

/** Whether an auth.json holds a ChatGPT refresh token or an API key. */
export const hasCodexCredentials = (authJson: string): boolean => {
  try {
    const auth = JSON.parse(authJson) as {
      tokens?: { refresh_token?: unknown } | null;
      OPENAI_API_KEY?: unknown;
    };
    const refresh = auth.tokens?.refresh_token;
    return (
      (typeof refresh === "string" && refresh.length > 0) ||
      (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.length > 0)
    );
  } catch {
    return false;
  }
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
