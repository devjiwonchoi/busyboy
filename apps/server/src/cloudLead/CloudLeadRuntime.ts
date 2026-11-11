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
 * The sandbox does not need the Mac to stay alive: it is persistent, and its
 * relay holds a Vercel credential scoped to the sandbox project, extends the
 * sandbox while work runs and stops it (files kept) once idle. Each sandbox is
 * recorded in a CloudSessionStore, so a Mac that slept past the relay giving
 * up, or a restarted server, attaches to the same sandbox again (resuming it
 * if it stopped), lets a claude process left from before a restart finish its
 * turn, and mirrors the worktree back before anything reads it.
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
import type { RelayMessage } from "./relay/session.ts";
import { RelayClient, type RelaySocketFactory, type RemoteProcess } from "./RelayClient.ts";
import type { SandboxClient, SandboxHandle } from "./SandboxClient.ts";
import {
  memoryCloudSessionStore,
  type CloudProcessRecord,
  type CloudSessionRecord,
  type CloudSessionStore,
} from "./CloudSessionStore.ts";
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
/** The Mac extends the sandbox only when the relay could not get its own credential. */
const KEEPALIVE_EVERY_MS = 10 * 60 * 1000;
/** The relay's project token lasts about 12 hours; it is renewed well before. */
const RELAY_CREDENTIAL_EVERY_MS = 60 * 60 * 1000;
/**
 * The relay waits this much longer than the Mac's idle stop, so an awake Mac
 * mirrors and releases an idle sandbox itself; the relay's own stop is for a
 * Mac that is asleep or off.
 */
const RELAY_IDLE_MARGIN_MS = 10 * 60 * 1000;
/** A claude left running by a restarted Mac gets this long to finish its turn. */
const ORPHAN_KILL_AFTER_MS = 10 * 60 * 1000;
const RELAY_PROCESS = ".busyboy-cloud/relay/server.ts";
const MAX_REATTACH_FAILURES = 3;
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
  /** Where sandboxes are recorded for a restarted server; in memory by default. */
  readonly store?: CloudSessionStore;
  /** How long the relay waits with nothing running before it stops its sandbox. */
  readonly relayIdleStopMs?: number;
  /** How long an unreachable relay goes before the Mac asks whether its sandbox lives. */
  readonly relayGiveUpAfterMs?: number;
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
  readonly relayTokenRef: string;
  /** Remote processes by relay id, recorded so a restarted Mac finds them. */
  readonly processes: Map<string, CloudProcessRecord>;
  /** Processes a restarted Mac left running; a new turn waits for them to end. */
  readonly orphans: Set<Promise<void>>;
  readonly mcpEndpoint: string;
  /** Store writes run in order. */
  persisted: Promise<void>;
  credentialTimer: ReturnType<typeof setInterval> | null;
  readonly macCwd: string;
  readonly remoteHome: string;
  readonly remoteCwd: string;
  readonly credentials: CloudLeadCredentials;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Only when the relay has no credential of its own. */
  keepAlive: ReturnType<typeof setInterval> | null;
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
  private readonly store: CloudSessionStore;
  /** Failed attaches per worktree; past MAX_REATTACH_FAILURES a new sandbox is made. */
  private readonly reattachFailures = new Map<string, number>();
  /** Thread -> the Mac worktree (session key) it last prepared in. */
  private readonly worktrees = new Map<string, string>();
  /** The one sandbox using the cloud Codex login: a login refreshed in two places logs out. */
  private codexHolder: string | null = null;

  constructor(deps: CloudLeadRuntimeDeps) {
    this.deps = deps;
    this.store = deps.store ?? memoryCloudSessionStore();
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

  /**
   * The sandbox key (Mac worktree) for a thread that prepared a turn, or a Mac
   * worktree itself: a move finds the sandbox even when only a child of the
   * lead has run in it since it was started.
   */
  private keyOf(threadOrWorktree: string): string | undefined {
    const key = this.worktrees.get(threadOrWorktree);
    if (key !== undefined) return key;
    return this.sessions.has(threadOrWorktree) || this.releasing.has(threadOrWorktree)
      ? threadOrWorktree
      : undefined;
  }

  /** Gets the thread's sandbox ready and returns how to run claude or codex in it. */
  async prepare(input: PrepareInput): Promise<CloudLaunch> {
    this.worktrees.set(input.threadId, input.worktreePath);
    const session = await this.session(input);
    // Released between the lookup and now: wait for that and take a new sandbox.
    if (session.released) return this.prepare(input);
    // A claude a restarted Mac left running finishes its turn before a new one resumes it.
    if (session.orphans.size > 0) {
      await Promise.all(session.orphans);
      return this.prepare(input);
    }
    session.relay.setMcpEndpoint(input.mcpEndpoint);
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
    // An unknown id may still be a worktree with a recorded sandbox (a move passes the worktree).
    return this.syncKey(this.keyOf(threadId) ?? threadId);
  }

  private syncKey(key: string): Promise<{ readonly head: string } | null> {
    const pending = this.sessions.get(key);
    // During a release, wait for its final mirror so callers read a finished worktree.
    const releasing = this.releasing.get(key);
    if (pending === undefined && releasing !== undefined) return releasing.then(() => null);
    // A recorded sandbox nothing is attached to (it stopped while the Mac slept) may
    // hold work the Mac has not seen: attach again, which mirrors it.
    // A failed attach throws: a caller about to rely on the mirror must not go on.
    if (pending === undefined) {
      return this.attachRecorded(key).then((attached) =>
        attached === "attached" ? this.syncKey(key) : null,
      );
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
    return this.releaseKey(this.keyOf(threadId) ?? threadId, options);
  }

  private releaseKey(threadId: string, options: { readonly synced?: boolean } = {}): Promise<void> {
    const pending = this.sessions.get(threadId);
    if (pending === undefined) {
      const releasing = this.releasing.get(threadId);
      if (releasing !== undefined) return releasing;
      // A recorded sandbox nothing is attached to: attach (mirroring its work), then
      // release it. One that cannot be attached keeps its record for a later try.
      return this.attachRecorded(threadId).then(
        (attached) => (attached === "attached" ? this.releaseKey(threadId, options) : undefined),
        () => undefined,
      );
    }
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
      this.stopTimers(session);
      session.relay.close();
      // Its codex processes end with the relay; the login is free for other sandboxes.
      if (this.codexHolder === session.key) this.codexHolder = null;
      await session.sandbox.delete().catch(() => undefined);
      await session.persisted;
      await this.forget(session.key, session.relayTokenRef);
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

  /**
   * Lets go of every sandbox without stopping it, for a server shutting down:
   * its processes keep running and the next server attaches again (restore).
   */
  async detachAll(): Promise<void> {
    const pending = [...this.sessions.entries()];
    this.sessions.clear();
    await Promise.all(
      pending.map(async ([, promise]) => {
        const session = await promise.catch(() => null);
        if (session === null) return;
        this.cancelIdleStop(session);
        this.stopTimers(session);
        // Saves still queued go through first; after this, exits are not recorded,
        // so the record keeps the processes the next server lets finish.
        await session.persisted;
        session.released = true;
        session.relay.close();
      }),
    );
  }

  /**
   * Attaches again to every recorded sandbox, at server start: resumes a
   * stopped one, lets claude processes left by the previous server finish
   * their turn, and mirrors each worktree to the Mac.
   */
  async restore(): Promise<void> {
    const records = await this.store.list();
    await Promise.all(
      records.map(async (record) => {
        if (this.sessions.has(record.worktreeKey)) return;
        await this.attachRecord(record).catch(() => undefined);
      }),
    );
  }

  /**
   * Attaches to the recorded sandbox of a worktree. "none" when nothing is
   * recorded or the sandbox is gone; throws when the attach fails.
   */
  private async attachRecorded(key: string): Promise<"attached" | "none"> {
    if (!this.sessions.has(key)) {
      const record = (await this.store.list()).find((candidate) => candidate.worktreeKey === key);
      if (record === undefined) return "none";
      if (!this.sessions.has(key)) return this.attachRecord(record);
    }
    await this.sessions.get(key)!;
    return "attached";
  }

  /** Maps the worktree to an attach of its recorded sandbox; rejects when that fails. */
  private attachRecord(record: CloudSessionRecord): Promise<"attached" | "none"> {
    this.worktrees.set(record.threadId, record.worktreeKey);
    const attached = this.reattach(record, record.mcpEndpoint).then((session) => {
      if (session === null) throw new Error("The recorded sandbox is gone.");
      return session;
    });
    this.sessions.set(record.worktreeKey, attached);
    return attached.then(
      () => "attached" as const,
      async (error: unknown) => {
        if (this.sessions.get(record.worktreeKey) === attached) {
          this.sessions.delete(record.worktreeKey);
        }
        // Gone or stale: forgotten by reattach, so there is nothing to attach.
        if (!(await this.store.list()).some((r) => r.worktreeKey === record.worktreeKey)) {
          return "none" as const;
        }
        this.log("cloud-lead.reattach-failed", {
          worktree: record.worktreeKey,
          sandbox: record.sandboxName,
          error: errorText(error),
        });
        throw error;
      },
    );
  }

  hasSession(threadId: string): boolean {
    const key = this.keyOf(threadId);
    return key !== undefined && this.sessions.has(key);
  }

  private session(input: PrepareInput): Promise<CloudSession> {
    const key = input.worktreePath;
    const existing = this.sessions.get(key);
    if (existing !== undefined) return existing;
    const releasing = this.releasing.get(key);
    if (releasing !== undefined) return releasing.then(() => this.session(input));
    const created = this.attachOrCreate(input);
    this.sessions.set(key, created);
    // A failed start must not stick: the next turn tries again.
    created.catch(() => {
      if (this.sessions.get(key) === created) this.sessions.delete(key);
    });
    return created;
  }

  /** The recorded sandbox of this worktree when it still exists, else a new one. */
  private async attachOrCreate(input: PrepareInput): Promise<CloudSession> {
    const record = (await this.store.list()).find(
      (candidate) => candidate.worktreeKey === input.worktreePath,
    );
    if (record !== undefined) {
      try {
        const attached = await this.reattach(record, input.mcpEndpoint);
        this.reattachFailures.delete(record.worktreeKey);
        if (attached !== null) return attached;
      } catch (error) {
        const failures = (this.reattachFailures.get(record.worktreeKey) ?? 0) + 1;
        this.reattachFailures.set(record.worktreeKey, failures);
        if (failures < MAX_REATTACH_FAILURES) throw error;
        // Stop retrying a sandbox that will not take us back. It is not deleted:
        // it may hold work, and its relay stops it once idle.
        this.reattachFailures.delete(record.worktreeKey);
        await this.forget(record.worktreeKey, record.relayTokenRef);
        this.log("cloud-lead.recorded-sandbox-abandoned", {
          worktree: record.worktreeKey,
          sandbox: record.sandboxName,
          error: errorText(error),
        });
      }
    }
    return this.create(input);
  }

  /**
   * Attaches to a recorded sandbox: resumes it if it stopped, restarts its
   * relay if that is not running, and mirrors its worktree to the Mac. Null
   * when the sandbox no longer exists (the record is dropped).
   */
  private async reattach(
    record: CloudSessionRecord,
    mcpEndpoint: string,
  ): Promise<CloudSession | null> {
    const started = Date.now();
    const [client, credentials] = await Promise.all([this.deps.client(), this.deps.credentials()]);
    // Through the team guard, like every sandbox call.
    if ((await client.status(record.sandboxName)) === "missing") {
      await this.forget(record.worktreeKey, record.relayTokenRef);
      this.log("cloud-lead.recorded-sandbox-gone", {
        worktree: record.worktreeKey,
        sandbox: record.sandboxName,
      });
      return null;
    }
    const sandbox = await client.get(record.sandboxName, { resume: true });
    // The Mac worktree moved on without this sandbox (the task came back to the Mac
    // and got new commits): mirroring would overwrite that work, so leave it.
    if (!(await this.macWithinSandbox(sandbox, record))) {
      await this.forget(record.worktreeKey, record.relayTokenRef);
      this.log("cloud-lead.recorded-sandbox-stale", {
        worktree: record.worktreeKey,
        sandbox: record.sandboxName,
      });
      return null;
    }
    let token = await this.store.readToken(record.relayTokenRef);
    const relayScript = `${record.remoteHome}/${RELAY_PROCESS}`;
    // A resumed sandbox runs a new session: nothing from before is running in it.
    const sameSession = record.sandboxSessionId === sandbox.sessionId;
    const relayRunning =
      sameSession &&
      token !== null &&
      (await sandbox
        .runCommand({ cmd: "pgrep", args: ["-f", relayScript] })
        .then((result) => result.exitCode === 0)
        .catch(() => false));
    if (!relayRunning) {
      if (token === null) {
        token = NodeCrypto.randomBytes(32).toString("base64url");
        await this.store.saveToken(record.relayTokenRef, token);
      }
      if (sameSession) {
        // The relay died but its processes may not have: a new relay cannot hand
        // them over, so end them before a new turn resumes the same claude session.
        await this.killLeftovers(sandbox, record);
        await sandbox
          .runCommand({ cmd: "pkill", args: ["-f", relayScript] })
          .catch(() => undefined);
      }
      await this.startRelayProcess(sandbox, record.remoteHome, token);
    }
    const connection = this.connectRelay(record.worktreeKey, sandbox, token!, mcpEndpoint);
    await this.waitForRelay(connection.relay);
    const session = this.newSession({
      key: record.worktreeKey,
      threadId: record.threadId,
      sandbox,
      relay: connection.relay,
      relayTokenRef: record.relayTokenRef,
      macCwd: record.worktreeKey,
      remoteHome: record.remoteHome,
      remoteCwd: record.remoteCwd,
      credentials,
      createdAt: record.createdAt,
      mcpEndpoint,
      processes: record.processes,
    });
    connection.bind(session);
    await this.afterConnect(session);
    this.log("cloud-lead.sandbox-reattached", {
      worktree: record.worktreeKey,
      sandbox: sandbox.name,
      resumed: !relayRunning,
      ms: Date.now() - started,
    });
    // The Mac mirror may be older than the sandbox: catch it up before gates read it.
    await this.syncLocked(record.worktreeKey, Promise.resolve(session)).catch((error: unknown) =>
      this.log("cloud-lead.reattach-sync-failed", {
        worktree: record.worktreeKey,
        error: errorText(error),
      }),
    );
    return session;
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
      // A stopped sandbox keeps its files; the next call resumes it.
      persistent: true,
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
      const token = NodeCrypto.randomBytes(32).toString("base64url");
      const relayTokenRef = relayTokenRefFor(key);
      await this.startRelayProcess(sandbox, remoteHome, token);
      const connection = this.connectRelay(key, sandbox, token, input.mcpEndpoint);
      await this.waitForRelay(connection.relay);
      this.log("cloud-lead.sandbox-ready", {
        threadId: input.threadId,
        sandbox: sandbox.name,
        ms: Date.now() - started,
        envSynced: bundle.files.length,
      });
      const session = this.newSession({
        key,
        threadId: input.threadId,
        sandbox,
        relay: connection.relay,
        relayTokenRef,
        macCwd: input.worktreePath,
        remoteHome,
        remoteCwd,
        credentials,
        createdAt,
        mcpEndpoint: input.mcpEndpoint,
        processes: [],
      });
      connection.bind(session);
      await this.store.saveToken(relayTokenRef, token);
      await this.afterConnect(session);
      return session;
    } catch (error) {
      await sandbox.delete().catch(() => undefined);
      throw error;
    }
  }

  private newSession(input: {
    readonly key: string;
    readonly threadId: string;
    readonly sandbox: SandboxHandle;
    readonly relay: RelayClient;
    readonly relayTokenRef: string;
    readonly macCwd: string;
    readonly remoteHome: string;
    readonly remoteCwd: string;
    readonly credentials: CloudLeadCredentials;
    readonly createdAt: number;
    readonly mcpEndpoint: string;
    readonly processes: ReadonlyArray<CloudProcessRecord>;
  }): CloudSession {
    const { processes, ...rest } = input;
    const session: CloudSession = {
      ...rest,
      runningThreads: new Map(),
      processes: new Map(processes.map((process) => [process.id, process])),
      orphans: new Set(),
      persisted: Promise.resolve(),
      credentialTimer: null,
      keepAlive: null,
      idleTimer: null,
      running: 0,
      codexRunning: 0,
      codexConfigSynced: false,
      codexAuthInstalled: false,
      idleSyncFailures: 0,
      uses: 0,
      released: false,
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
  }

  /**
   * Gives the relay its credential (falling back to extending the sandbox from
   * the Mac when there is none), renews it hourly, and records the session.
   */
  private async afterConnect(session: CloudSession) {
    if (!(await this.sendCredential(session)) && session.keepAlive === null) {
      session.keepAlive = setInterval(() => {
        session.sandbox.extendTimeout(KEEPALIVE_EVERY_MS).catch((error: unknown) =>
          this.log("cloud-lead.keepalive-failed", {
            worktree: session.key,
            error: String(error),
          }),
        );
      }, KEEPALIVE_EVERY_MS);
      session.keepAlive.unref?.();
    }
    session.credentialTimer = setInterval(
      () => void this.sendCredential(session),
      RELAY_CREDENTIAL_EVERY_MS,
    );
    session.credentialTimer.unref?.();
    this.persist(session);
  }

  /** Hands the relay a token that reaches only the sandbox project. False when there is none. */
  private async sendCredential(session: CloudSession): Promise<boolean> {
    try {
      // A fresh client: the Mac's Vercel login renews itself over a long session.
      const credential = await (await this.deps.client()).relayCredential();
      session.relay.sendControl({
        op: "credential",
        token: credential.token,
        sessionId: session.sandbox.sessionId,
        teamId: credential.teamId,
        projectId: credential.projectId,
        ...(session.sandbox.expiresAt === undefined
          ? {}
          : { expiresAt: session.sandbox.expiresAt }),
      });
      return true;
    } catch (error) {
      this.log("cloud-lead.relay-credential-failed", {
        worktree: session.key,
        error: errorText(error),
      });
      return false;
    }
  }

  private stopTimers(session: CloudSession) {
    if (session.keepAlive !== null) clearInterval(session.keepAlive);
    if (session.credentialTimer !== null) clearInterval(session.credentialTimer);
    if (session.rotationCheck !== null) clearInterval(session.rotationCheck);
    session.keepAlive = null;
    session.credentialTimer = null;
    session.rotationCheck = null;
  }

  /** Writes the session's record; writes run in order and stop once it is released. */
  private persist(session: CloudSession) {
    session.persisted = session.persisted
      .then(async () => {
        if (session.released) return;
        await this.store.save({
          worktreeKey: session.key,
          threadId: session.threadId,
          sandboxName: session.sandbox.name,
          sandboxSessionId: session.sandbox.sessionId,
          relayTokenRef: session.relayTokenRef,
          remoteHome: session.remoteHome,
          remoteCwd: session.remoteCwd,
          mcpEndpoint: session.mcpEndpoint,
          processes: [...session.processes.values()],
          createdAt: session.createdAt,
        });
      })
      .catch((error: unknown) =>
        this.log("cloud-lead.session-save-failed", {
          worktree: session.key,
          error: errorText(error),
        }),
      );
  }

  private async forget(key: string, relayTokenRef: string) {
    await this.store
      .remove(key)
      .catch((error: unknown) =>
        this.log("cloud-lead.session-forget-failed", { worktree: key, error: errorText(error) }),
      );
    await this.store.removeToken(relayTokenRef).catch(() => undefined);
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

  /** Uploads the relay and starts it with its bearer; it keeps running without the Mac. */
  private async startRelayProcess(sandbox: SandboxHandle, remoteHome: string, token: string) {
    const dir = `${remoteHome}/.busyboy-cloud/relay`;
    await sandbox.writeFiles(
      Object.entries(RELAY_FILES).map(([name, content]) => ({
        path: `${dir}/${name}`,
        content: Buffer.from(content),
      })),
    );
    await sandbox.startDetached({
      cmd: "node",
      args: ["--experimental-strip-types", "--no-warnings", `${dir}/server.ts`],
      env: {
        BUSYBOY_RELAY_TOKEN: token,
        BUSYBOY_RELAY_PORT: String(this.ports.relay),
        BUSYBOY_RELAY_MCP_PORT: String(this.ports.mcp),
        BUSYBOY_RELAY_IDLE_STOP_MS: String(
          this.deps.relayIdleStopMs ??
            (this.deps.idleStopMs ?? DEFAULT_IDLE_STOP_MS) + RELAY_IDLE_MARGIN_MS,
        ),
      },
    });
  }

  /**
   * Opens the Mac end of a sandbox's relay. It keeps retrying while the
   * sandbox lives; once it is gone or stopped, the session is let go (not
   * deleted) and the next turn attaches again. `bind` hands it the session
   * once built, with any processes a previous Mac server left running.
   */
  private connectRelay(
    key: string,
    sandbox: SandboxHandle,
    token: string,
    mcpEndpoint: string,
  ): { readonly relay: RelayClient; readonly bind: (session: CloudSession) => void } {
    let bound: CloudSession | null = null;
    let leftover: ReadonlyArray<Record<string, unknown>> | null = null;
    // A sandbox resumed in a new session (a mirror call wakes a stopped one) has no relay running.
    const relaySession = sandbox.sessionId;
    const url =
      this.deps.relayUrl?.(sandbox) ?? sandbox.domain(this.ports.relay).replace(/^http/, "ws");
    const relay: RelayClient = new RelayClient({
      url,
      token,
      mcpEndpoint,
      ...(this.deps.relayGiveUpAfterMs === undefined
        ? {}
        : { giveUpAfterMs: this.deps.relayGiveUpAfterMs }),
      isAlive: async () => {
        const fresh = await this.deps.client();
        return (
          (await fresh.status(sandbox.name)) === "running" &&
          (await fresh.get(sandbox.name)).sessionId === relaySession
        );
      },
      onGiveUp: () => {
        this.log("cloud-lead.relay-unreachable", { worktree: key, sandbox: sandbox.name });
        if (bound !== null) this.letGo(bound);
      },
      onReconnect: () => {
        if (bound === null || bound.released) return;
        this.log("cloud-lead.relay-reconnected", { worktree: key, sandbox: sandbox.name });
        void this.sendCredential(bound);
        void this.syncKey(key).catch((error: unknown) =>
          this.log("cloud-lead.reconnect-sync-failed", { worktree: key, error: errorText(error) }),
        );
      },
      onControl: (message: RelayMessage) => {
        if (message.op !== "procs" || !Array.isArray(message.list)) return;
        const list = message.list as ReadonlyArray<Record<string, unknown>>;
        if (bound === null) leftover = list;
        else this.finishOrphans(bound, list);
      },
      ...(this.deps.socketFactory === undefined ? {} : { socketFactory: this.deps.socketFactory }),
    });
    return {
      relay,
      bind: (session) => {
        bound = session;
        if (leftover !== null) this.finishOrphans(session, leftover);
        leftover = null;
      },
    };
  }

  /** Whether the Mac worktree's HEAD is in the sandbox's history, so a mirror loses nothing. */
  private async macWithinSandbox(sandbox: SandboxHandle, record: CloudSessionRecord) {
    const macHead = (
      await this.mac()
        .run(`git -C ${shellQuote(record.worktreeKey)} rev-parse HEAD`)
        .catch(() => "")
    ).trim();
    if (!/^[0-9a-f]{40}$/.test(macHead)) return true;
    const result = await sandbox.runCommand({
      cmd: "git",
      args: ["-C", record.remoteCwd, "merge-base", "--is-ancestor", macHead, "HEAD"],
    });
    return result.exitCode === 0;
  }

  /** Ends the processes a dead relay left running; it kept their process groups in a file. */
  private async killLeftovers(sandbox: SandboxHandle, record: CloudSessionRecord) {
    const pids = `${record.remoteHome}/.busyboy-cloud/relay/children.json`;
    await sandbox
      .runCommand({
        cmd: "node",
        args: [
          "-e",
          "for (const pid of JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))) { try { process.kill(-pid, 'SIGTERM') } catch {} }",
          pids,
        ],
      })
      .catch(() => undefined);
    this.log("cloud-lead.leftovers-ended", {
      worktree: record.worktreeKey,
      processes: record.processes.map((process) => ({
        id: process.id,
        claudeSession: process.claudeSessionId,
      })),
    });
  }

  private async waitForRelay(relay: RelayClient) {
    try {
      await relay.waitUntilConnected(RELAY_CONNECT_TIMEOUT_MS);
    } catch (error) {
      relay.close();
      throw error;
    }
  }

  /**
   * The sandbox stopped or went away while this session used it: drop the
   * session but keep its record, so the next turn resumes the same sandbox.
   */
  private letGo(session: CloudSession) {
    if (session.released) return;
    session.released = true;
    this.cancelIdleStop(session);
    this.stopTimers(session);
    if (this.sessions.has(session.key)) {
      void this.sessions.get(session.key)!.then((current) => {
        if (current === session) this.sessions.delete(session.key);
      });
    }
    if (this.codexHolder === session.key) this.codexHolder = null;
  }

  /**
   * Processes a previous Mac server started: each gets end of input, so a
   * claude finishes the turn it is in and exits (its transcript stays in the
   * sandbox); one that hangs is killed after ORPHAN_KILL_AFTER_MS.
   */
  private finishOrphans(session: CloudSession, list: ReadonlyArray<Record<string, unknown>>) {
    // Recorded processes that ended while no Mac was attached.
    const running = new Set(list.map((entry) => String(entry.id)));
    for (const id of session.processes.keys()) {
      if (!running.has(id) && !id.startsWith(`${session.relay.sid}:`)) session.processes.delete(id);
    }
    this.persist(session);
    for (const entry of list) {
      const id = String(entry.id);
      if (id.startsWith(`${session.relay.sid}:`)) continue;
      const child = session.relay.adopt(id);
      const recorded = session.processes.get(id);
      // It may have ended between the relay's list and now.
      if (child.exitCode !== null) {
        session.processes.delete(id);
        this.persist(session);
        continue;
      }
      const threadId = recorded?.threadId ?? session.threadId;
      const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      session.orphans.add(done);
      this.track(session, child, threadId, () => {
        session.orphans.delete(done);
        session.processes.delete(id);
        this.persist(session);
        // Its last turn's work reaches the Mac before the next turn or a gate reads it.
        if (session.orphans.size === 0 && !session.released) {
          void this.syncKey(session.key).catch(() => undefined);
        }
      });
      const kill = setTimeout(() => child.kill("SIGKILL"), ORPHAN_KILL_AFTER_MS);
      kill.unref?.();
      child.once("exit", () => clearTimeout(kill));
      child.stdin.end();
      this.log("cloud-lead.orphan-finishing", {
        worktree: session.key,
        process: id,
        threadId,
        claudeSession: recorded?.claudeSessionId ?? null,
      });
    }
  }

  /** Records a remote process so a restarted Mac knows which thread and claude session it ran. */
  private recordProcess(session: CloudSession, threadId: string, args: ReadonlyArray<string>) {
    const id = session.relay.lastProcessId;
    session.processes.set(id, { id, threadId, claudeSessionId: claudeSessionIdOf(args) });
    this.persist(session);
    return () => {
      session.processes.delete(id);
      this.persist(session);
    };
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
    this.track(session, child, threadId, this.recordProcess(session, threadId, args));
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
    const unrecord = this.recordProcess(session, threadId, []);
    this.track(session, child, threadId, () => {
      unrecord();
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
    // Any thread in this sandbox being moved (the lead, or a child that started it) waits it out.
    const inSandbox = [...this.worktrees].filter(([, key]) => key === session.key);
    if (
      handler?.busy !== undefined &&
      [threadId, ...inSandbox.map(([thread]) => thread)].some((thread) => handler.busy!(thread))
    ) {
      return false;
    }
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

/** The secret store name of a worktree's relay bearer. */
const relayTokenRefFor = (key: string) =>
  `cloud-lead-relay-${NodeCrypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`;

/** The claude session a spawn resumes or starts, from its --resume / --session-id flag. */
const claudeSessionIdOf = (args: ReadonlyArray<string>): string | null => {
  for (const flag of ["--resume", "--session-id"]) {
    const index = args.indexOf(flag);
    if (index !== -1 && args[index + 1] !== undefined) return args[index + 1]!;
  }
  return null;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
