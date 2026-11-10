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
  readonly keepAlive: ReturnType<typeof setInterval>;
  /** Remote claude processes still running; the sandbox only idles out at zero. */
  running: number;
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

export class CloudLeadRuntime {
  private readonly deps: CloudLeadRuntimeDeps;
  private readonly sessions = new Map<string, Promise<CloudSession>>();
  private readonly syncs = new Map<string, Promise<{ readonly head: string } | null>>();
  /** Sandboxes being mirrored a last time and deleted; a new turn waits for these. */
  private readonly releasing = new Map<string, Promise<void>>();
  private rotationHandler: CloudLeadRotationHandler | null = null;

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

  /** Gets the thread's sandbox ready and returns how to run claude in it. */
  async prepare(input: {
    readonly threadId: string;
    readonly worktreePath: string;
    readonly mcpEndpoint: string;
  }): Promise<CloudLaunch> {
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
    return {
      spawn: (options) => this.spawn(session, options),
      mcpUrl: `http://127.0.0.1:${this.ports.mcp}${mcpPath}`,
    };
  }

  /**
   * Copies the sandbox working tree onto the Mac worktree; a no-op without a
   * live sandbox. Callers (turn end, team gates, release) may overlap, so
   * syncs of one thread run one at a time.
   */
  syncToMac(threadId: string): Promise<{ readonly head: string } | null> {
    const pending = this.sessions.get(threadId);
    // During a release, wait for its final mirror so callers read a finished worktree.
    if (pending === undefined) {
      return (this.releasing.get(threadId) ?? Promise.resolve()).then(() => null);
    }
    return this.syncLocked(threadId, pending);
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
      clearInterval(session.keepAlive);
      if (session.rotationCheck !== null) clearInterval(session.rotationCheck);
      session.relay.close();
      await session.sandbox.delete().catch(() => undefined);
      this.log("cloud-lead.sandbox-released", { threadId, sandbox: session.sandbox.name });
    })();
    this.releasing.set(threadId, done);
    const forget = () => {
      if (this.releasing.get(threadId) === done) this.releasing.delete(threadId);
    };
    done.then(forget, forget);
    return done;
  }

  async releaseAll(): Promise<void> {
    await Promise.all([
      ...[...this.sessions.keys()].map((threadId) => this.release(threadId)),
      ...this.releasing.values(),
    ]);
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
    const releasing = this.releasing.get(input.threadId);
    if (releasing !== undefined) return releasing.then(() => this.session(input));
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
      await this.restoreTranscripts(input.threadId, sandbox, remoteHome, remoteCwd);
      const relay = await this.startRelay(sandbox, remoteHome, input.mcpEndpoint, () => {
        // The relay is gone (sandbox stopped or unreachable): mirror what the
        // sandbox API can still reach and start over on the next turn.
        this.log("cloud-lead.relay-unreachable", { threadId: input.threadId });
        void this.release(input.threadId);
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
        threadId: input.threadId,
        sandbox,
        relay,
        keepAlive,
        macCwd: input.worktreePath,
        remoteHome,
        remoteCwd,
        credentials,
        idleTimer: null,
        running: 0,
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

  private spawn(session: CloudSession, options: CloudSpawnOptions): RemoteProcess {
    if (session.released) {
      throw new Error("The cloud sandbox for this thread was stopped; start the turn again.");
    }
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
    session.running += 1;
    child.once("exit", () => {
      session.running -= 1;
      if (session.running === 0) this.scheduleIdleStop(session);
    });
    return child;
  }

  /**
   * Puts the Mac's claude transcripts for `macCwd` into the thread's backup,
   * over any older copies, so the next sandbox restores them and resumes.
   */
  async importTranscripts(threadId: string, macCwd: string): Promise<void> {
    const backup = this.transcriptBackupPath(threadId);
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

  /** Unpacks the thread's transcript backup into the Mac's claude folder for `macCwd`. */
  async exportTranscripts(threadId: string, macCwd: string): Promise<void> {
    await this.mac().run(
      [
        TRANSCRIPT_SHELL,
        `dst=${shellQuote(await this.macTranscriptDir(macCwd))}`,
        `backup=${shellQuote(this.transcriptBackupPath(threadId))}`,
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
        : `if tar -tzf ${shellQuote(this.transcriptBackupPath(input.threadId))} 2>/dev/null | grep -qxF -e ${shellQuote(`./${name}`)} -e ${shellQuote(name)}; then echo yes; fi`;
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
    await NodeFs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true, mode: 0o700 });
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
    try {
      if (midTurn) {
        if (handler === null) throw new Error("Nothing can stop the running turn.");
        await handler.interrupt(threadId);
      }
      if (session.released) return true;
      // A failed mirror throws here and keeps the sandbox, so no work is lost.
      await this.syncToMac(threadId);
      // Between turns, a turn that began during the mirror keeps this sandbox for now.
      if (!midTurn && (session.running > 0 || session.uses !== uses)) {
        session.rotation = "idle";
        return false;
      }
      await this.release(threadId, { synced: true });
      this.log("cloud-lead.sandbox-rotated", { threadId, sandbox: session.sandbox.name, midTurn });
      if (midTurn) await handler?.resume(threadId);
      return true;
    } catch (error) {
      session.rotation = "failed";
      this.log("cloud-lead.sandbox-rotation-failed", { threadId, error: String(error) });
      if (midTurn) await handler?.resume(threadId).catch(() => undefined);
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
      await this.syncToMac(session.threadId);
    } catch (error) {
      session.idleSyncFailures += 1;
      this.log("cloud-lead.idle-sync-failed", {
        threadId: session.threadId,
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
    await this.release(session.threadId, { synced: true });
  }

  private cancelIdleStop(session: CloudSession) {
    if (session.idleTimer !== null) clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  private log(event: string, data: Record<string, unknown>) {
    this.deps.log?.(event, data);
  }
}
