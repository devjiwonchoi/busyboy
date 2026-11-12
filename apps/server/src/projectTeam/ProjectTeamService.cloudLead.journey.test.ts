// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - drives the promise-based cloud lead runtime against local git repos.
/**
 * A cloud task from start to pull request: the PM starts it in the cloud, the
 * lead's claude runs in a (local, fake) sandbox through the real relay, commits
 * there, and the team's gates read that commit from the Mac mirror mid-turn,
 * so the review, In Review with the pull request, and Ready all pass. The
 * lead's implement, review and fix children run in the same sandbox.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Option from "effect/Option";
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";

import { expect, vi } from "vite-plus/test";
import { makeOfflineJournalReplay, offlineChildThreadId } from "./OfflineJournalReplay.ts";
import { encodeProjectDir } from "../cloudLead/pathRewrite.ts";
import { RelayClient } from "../cloudLead/RelayClient.ts";
import { CloudLeadRuntime, type OfflineJournalEntry } from "../cloudLead/CloudLeadRuntime.ts";
import * as CloudLeadService from "../cloudLead/CloudLeadService.ts";
import type { RemoteProcess } from "../cloudLead/RelayClient.ts";
import { fakeLocalHost, localSandboxClient } from "../cloudLead/testkit.ts";
import { localMirrorShell } from "../cloudLead/WorkspaceMirror.ts";
import { ProjectTeamError, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import {
  approvePlan,
  createAcceptedTask,
  PROJECT_ID,
  setUpManager,
  startLead,
  withTeam,
} from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;

describe("offline replay failure boundaries", () => {
  const entry: OfflineJournalEntry = {
    seq: 1,
    at: 1_000,
    kind: "call",
    threadId: "lead",
    taskId: "task",
    tool: "task_todo_set",
    args: { todoId: "todo", done: true },
  };
  const fixture = (missing: boolean, mutation: Effect.Effect<void, ProjectTeamError>) => {
    const sendToThread = vi.fn(() => Effect.void);
    const setTodo = vi.fn(() => mutation);
    const replay = makeOfflineJournalReplay({
      repository: {
        getTask: () =>
          Effect.succeed(
            missing ? Option.none() : Option.some({ projectId: "project", leadThreadId: "lead" }),
          ),
      },
      threads: { getThreadShell: () => Effect.succeed({}), sendToThread },
      team: { setTodo },
      models: () => Effect.succeed({}),
      providers: Effect.succeed([]),
    } as unknown as Parameters<typeof makeOfflineJournalReplay>[0]);
    return { replay, sendToThread, setTodo };
  };

  it("skips missing tasks without messaging or mutating", async () => {
    const f = fixture(true, Effect.void);
    await f.replay.apply({ worktreeKey: "tree", entry });
    assert.strictEqual(f.sendToThread.mock.calls.length, 0);
    assert.strictEqual(f.setTodo.mock.calls.length, 0);
  });

  it("messages expected refusals using the service message", async () => {
    const f = fixture(
      false,
      Effect.fail(new ProjectTeamError({ message: "Todo is no longer editable" })),
    );
    await f.replay.apply({ worktreeKey: "tree", entry });
    assert.strictEqual(f.sendToThread.mock.calls.length, 1);
    assert.include(
      (f.sendToThread.mock.calls[0] as unknown as [{ text: string }])[0].text,
      "was refused: Todo is no longer editable.",
    );
  });

  it("propagates defects without turning them into refusals", async () => {
    const f = fixture(false, Effect.die(new Error("replay defect")));
    await expect(f.replay.apply({ worktreeKey: "tree", entry })).rejects.toThrow("replay defect");
    assert.strictEqual(f.sendToThread.mock.calls.length, 0);
  });
});
const shell = localMirrorShell();
const PR_URL = "https://github.com/devjiwonchoi/busyboy/pull/9001";
const GIT_ENV =
  "export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t";

/** The sandbox's claude: each stdin line "commit <file>" writes and commits that file. */
const FAKE_CLAUDE = `#!/usr/bin/env node
const { execSync } = require("node:child_process");
const fs = require("node:fs");
process.stdout.write("ready\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) !== -1) {
    const file = buffer.slice(0, index).split(" ")[1];
    buffer = buffer.slice(index + 1);
    fs.writeFileSync(file, "hello\\n");
    execSync("git add -A && git commit -qm 'Add " + file + "'");
    process.stdout.write("committed " + execSync("git rev-parse HEAD").toString());
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      server.close(() => resolve(port));
    });
  });

const outputOf = (child: RemoteProcess) => {
  let text = "";
  child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
  return () => text;
};

const waitFor = async (check: () => boolean) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 15_000) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** The sandbox's codex: `login status` passes when the cloud login is in CODEX_HOME. */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const auth = process.env.CODEX_HOME + "/auth.json";
process.exit(fs.existsSync(auth) && fs.readFileSync(auth, "utf8").includes("valid") ? 0 : 1);
`;

const setUpMachines = async (options: { readonly codexAuth?: string } = {}) => {
  const root = await NodeFs.mkdtemp(`${NodeOs.tmpdir()}/cloud-journey-`);
  const macHome = `${root}/mac-home`;
  const mac = `${macHome}/worktrees/lead`;
  const binDir = `${root}/bin`;
  await NodeFs.mkdir(binDir, { recursive: true });
  await NodeFs.writeFile(`${binDir}/claude`, FAKE_CLAUDE, { mode: 0o755 });
  await NodeFs.writeFile(`${binDir}/codex`, FAKE_CODEX, { mode: 0o755 });
  await shell.run(
    `mkdir -p '${mac}' && cd '${mac}' && ${GIT_ENV} && git init -q -b main && echo base > README.md && git add . && git commit -qm base && git checkout -qb t3/lead`,
  );
  const client = localSandboxClient({
    binDir,
    makeHome: async (home) => {
      await shell.run(`git clone -q '${mac}' '${home}/busyboy'`);
    },
  });
  const runtime = new CloudLeadRuntime({
    client: async () => client,
    credentials: async () => ({ claudeOauthToken: "sk-ant-oat01-journey", githubToken: null }),
    baseSnapshotId: async () => null,
    host: { ...fakeLocalHost({ files: {} }), env: { HOME: macHome } },
    stateDir: `${root}/state`,
    ports: { relay: await freePort(), mcp: await freePort() },
    ...(options.codexAuth === undefined
      ? {}
      : { codexAuth: { read: async () => options.codexAuth!, save: async () => undefined } }),
  });
  const cleanup = async () => {
    await runtime.releaseAll();
    await NodeFs.rm(root, { recursive: true, force: true });
  };
  return { mac, client, runtime, cleanup };
};

const gitHead = (path: string) =>
  shell.run(`git -C '${path}' rev-parse HEAD`).then((out) => out.trim());

describe("cloud task journey", () => {
  it.effect("starts in the cloud and reaches a linked pull request from the sandbox's commit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => setUpMachines()),
      ({ mac, client, runtime }) =>
        withTeam(
          (harness) =>
            Effect.gen(function* () {
              const team = yield* service;
              const pm = yield* setUpManager;
              const { task: created } = yield* createAcceptedTask(pm, {
                title: "Add hello.txt",
                request: "Add hello.txt.",
                intake: "New work.",
              });

              // The PM starts the task in the cloud.
              const { task, leadThreadId: lead } = yield* team.startTask(
                pm,
                { taskId: created.id, location: "cloud" },
                harness.delegate,
              );
              assert.strictEqual((yield* Ref.get(harness.delegated)).at(-1)?.location, "cloud");
              assert.strictEqual(task.location, "cloud");
              // What delegate_task creates: a cloud thread on its own Mac worktree.
              const thread = harness.addThread(lead);
              thread.worktreePath = mac;
              thread.branch = "t3/lead";
              thread.shell = { location: "cloud" };
              // The gates read the Mac worktree's real HEAD, like WorktreeHeadReader.
              harness.worktreeHead = (path) =>
                NodeChildProcess.execFileSync("git", ["-C", path, "rev-parse", "HEAD"])
                  .toString()
                  .trim();
              yield* approvePlan(lead);

              // The adapter's part of a turn: claude runs in the sandbox and commits there.
              const launch = yield* CloudLeadService.hooksFromRuntime(runtime).prepare({
                threadId: lead,
                worktreePath: mac,
                mcpEndpoint: "http://127.0.0.1:1/mcp",
              });
              const child = launch.spawn({ command: "claude", args: [], env: {} });
              const output = outputOf(child);
              yield* Effect.promise(() => waitFor(() => output().includes("ready")));
              child.stdin.write("commit hello.txt\n");
              yield* Effect.promise(() => waitFor(() => output().includes("committed")));
              const sandboxHead = output().split("committed ")[1]!.trim();
              assert.notStrictEqual(yield* Effect.promise(() => gitHead(mac)), sandboxHead);

              // Mid-turn, the lead records its review and ships: the gates mirror the
              // sandbox first, so the Mac worktree they read is at the sandbox's commit.
              yield* team.setEvidence(lead, { criterionId: "c1", evidence: "hello.txt exists" });
              // The review shares the lead's checkout, so it runs in the same sandbox.
              const review = yield* team.delegateStep(
                lead,
                { role: "review", task: "Review main...HEAD." },
                harness.delegate,
              );
              assert.strictEqual((yield* Ref.get(harness.delegated)).at(-1)?.isolation, undefined);

              yield* team.setReview(review.childThreadId, {
                clean: true,
                findings: "",
                head: sandboxHead,
              });
              assert.strictEqual(yield* Effect.promise(() => gitHead(mac)), sandboxHead);
              assert.isTrue(
                (yield* Effect.promise(() => NodeFs.readFile(`${mac}/hello.txt`, "utf8"))) ===
                  "hello\n",
              );
              yield* team.updateTask(lead, { stage: "in_review", prUrl: PR_URL });
              harness.shipStates.set(PR_URL, {
                state: "open",
                isDraft: true,
                headSha: sandboxHead,
                mergeability: "mergeable",
                checks: [{ name: "test", status: "success" }],
                unresolvedThreads: 0,
              });
              yield* team.markTaskReady(lead, { head: sandboxHead, localChecks: "" });

              const { task: shipped } = yield* team.readTask(pm, { taskId: task.id });
              assert.strictEqual(shipped.stage, "in_review");
              assert.strictEqual(shipped.prUrl, PR_URL);
              assert.strictEqual(shipped.location, "cloud");
              assert.strictEqual(shipped.ready?.head, sandboxHead);
              assert.deepEqual(harness.markedReady, [PR_URL]);
              assert.strictEqual(client.created.length, 1);

              child.stdin.end();
            }),
          {
            cloudLead: CloudLeadService.hooksFromRuntime(runtime),
            settings: { taskExecution: { location: "local_first" } },
          },
        ),
      ({ cleanup }) => Effect.promise(cleanup),
    ),
  );

  it.effect(
    "replays offline work, imports its reviewer, and keeps refused calls and retries safe",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => setUpMachines()),
        ({ mac, runtime }) =>
          withTeam(
            (harness) =>
              Effect.gen(function* () {
                const { team, pm, task, lead } = yield* cloudLeadMidTurn(harness, runtime, mac);
                yield* team.updateSettings({
                  projectId: PROJECT_ID,
                  roleModels: { plan: PLAN, review: PLAN },
                });
                harness.worktreeHead = (path) =>
                  NodeChildProcess.execFileSync("git", ["-C", path, "rev-parse", "HEAD"])
                    .toString()
                    .trim();
                const launch = yield* CloudLeadService.hooksFromRuntime(runtime).prepare({
                  threadId: lead,
                  worktreePath: mac,
                  mcpEndpoint: "http://127.0.0.1:1/mcp",
                  mcpAuthorization: "Bearer offline-lead",
                });
                const process = launch.spawn({ command: "claude", args: [], env: {} });
                const output = outputOf(process);
                yield* Effect.promise(() => waitFor(() => output().includes("ready")));
                process.stdin.write("commit offline.txt\n");
                yield* Effect.promise(() => waitFor(() => output().includes("committed")));
                const head = output().split("committed ")[1]!.trim();
                const entries: OfflineJournalEntry[] = [];
                const call = (tool: string, args: unknown, threadId: string = lead) =>
                  entries.push({
                    seq: entries.length + 1,
                    at: Date.parse("2026-11-12T00:00:00Z"),
                    kind: "call",
                    threadId,
                    taskId: task.id,
                    tool,
                    args,
                  });
                call("task_todo_set", { todoId: "t1", done: true });
                call("task_evidence_set", { criterionId: "c1", evidence: "offline.txt exists" });
                call("task_update", { note: "Offline implementation complete" });
                entries.push({
                  seq: entries.length + 1,
                  at: Date.parse("2026-11-12T00:00:00Z"),
                  kind: "child-started",
                  threadId: lead,
                  taskId: task.id,
                  child: {
                    id: "review-1",
                    role: "review",
                    task: "Review the offline commit",
                    model: PLAN.model,
                    providerInstanceId: PLAN.providerInstanceId,
                    claudeSessionId: "offline-review-session",
                    leadThreadId: lead,
                  },
                });
                call(
                  "task_review_set",
                  { clean: true, findings: "", head },
                  "offline-child:review-1",
                );
                entries.push({
                  seq: entries.length + 1,
                  at: Date.parse("2026-11-12T00:00:00Z"),
                  kind: "child-finished",
                  threadId: "offline-child:review-1",
                  taskId: task.id,
                  child: {
                    id: "review-1",
                    role: "review",
                    claudeSessionId: "offline-review-session",
                    result: "Clean review",
                    exitCode: 0,
                    transcript: "children/review-1.jsonl",
                  },
                });
                call("task_update", { stage: "in_review", prUrl: PR_URL });
                call("link_pull_request", { url: PR_URL });
                call("task_ready", { head, localChecks: "" });
                // A malformed child entry is refused, not retried forever.
                entries.push({
                  seq: entries.length + 1,
                  at: Date.parse("2026-11-12T00:00:00Z"),
                  kind: "child-started",
                  threadId: lead,
                  taskId: task.id,
                  child: {
                    id: "bogus-1",
                    role: "bogus" as unknown as "review",
                    task: "Do something",
                    claudeSessionId: "bogus-session",
                    leadThreadId: lead,
                  },
                });
                call("ask_user", {
                  kind: "decision",
                  question: "Choose the next step\n\nThe offline work is ready for your decision.",
                  options: ["Continue (Recommended)", "Pause"],
                  context: {
                    action: "Choose the next step",
                    reason: "Offline work is finished",
                    impacts: [],
                    cost: null,
                    reversibility: "reversible",
                    recommendation: "Continue",
                  },
                });
                const reads = vi
                  .spyOn(RelayClient.prototype, "requestControl")
                  .mockImplementation(async (message) => ({
                    ch: "ctl",
                    op: "journal",
                    rid: message.rid,
                    entries,
                  }));
                const controls = vi.spyOn(RelayClient.prototype, "sendControl");
                try {
                  const session = yield* Effect.promise(() => runtime["sessions"].get(mac)!);
                  const transcript = '{"sessionId":"offline-review-session"}\n';
                  const remoteTranscripts = `${session.remoteHome}/.claude/projects/${encodeProjectDir(session.remoteCwd)}`;
                  yield* Effect.promise(async () => {
                    await NodeFs.mkdir(remoteTranscripts, { recursive: true });
                    await NodeFs.writeFile(
                      `${remoteTranscripts}/offline-review-session.jsonl`,
                      transcript,
                    );
                  });
                  // This is the same runtime path used by journal-pending and reconnect.
                  yield* Effect.promise(() => runtime["replayJournal"](session));
                  const realMac = yield* Effect.promise(() => NodeFs.realpath(mac));
                  assert.strictEqual(
                    yield* Effect.promise(() =>
                      NodeFs.readFile(
                        `${mac}/../../.claude/projects/${encodeProjectDir(realMac)}/offline-review-session.jsonl`,
                        "utf8",
                      ),
                    ),
                    transcript,
                  );
                  const before = yield* Ref.get(harness.dispatched);
                  const spec = yield* team.readSpec(lead, {});
                  assert.isTrue(spec.current.spec.todos.find((todo) => todo.id === "t1")!.done);
                  assert.strictEqual(
                    spec.current.spec.criteria.find((criterion) => criterion.id === "c1")!.evidence,
                    "offline.txt exists",
                  );
                  const { task: after } = yield* team.readTask(pm, { taskId: task.id });
                  assert.strictEqual(after.review?.by, "reviewer");
                  assert.strictEqual(after.stage, "in_review");
                  assert.strictEqual(after.prUrl, PR_URL);
                  const child = offlineChildThreadId(mac, "review-1");
                  assert.isTrue(
                    before.some(
                      (command) =>
                        command.type === "thread.create" &&
                        command.threadId === child &&
                        command.launchedByThreadId === lead &&
                        command.importedNativeThread?.ref.nativeId === "offline-review-session",
                    ),
                  );
                  assert.isTrue(
                    before.some(
                      (command) =>
                        command.type === "thread.pull-request.link" &&
                        command.threadId === lead &&
                        command.url === PR_URL,
                    ),
                  );
                  assert.isTrue(
                    (yield* Ref.get(harness.sent)).some(
                      (message) =>
                        message.threadId === lead &&
                        message.text.includes("[Offline replay] task_ready"),
                    ),
                  );
                  assert.isTrue(
                    (yield* Ref.get(harness.sent)).some(
                      (message) =>
                        message.threadId === lead &&
                        message.text.includes("[Offline replay] child-started") &&
                        message.text.includes("Unknown offline child role bogus"),
                    ),
                  );
                  const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
                  assert.isTrue(
                    (yield* repository.listOpenAttentionItems({
                      projectId: PROJECT_ID,
                      taskId: task.id,
                    })).some((item) => item.kind === "decision"),
                  );
                  const sentBefore = (yield* Ref.get(harness.sent)).length;
                  yield* Effect.promise(() =>
                    Promise.all([
                      runtime["replayJournal"](session),
                      runtime["replayJournal"](session),
                    ]),
                  );
                  assert.strictEqual((yield* Ref.get(harness.dispatched)).length, before.length);
                  assert.strictEqual((yield* Ref.get(harness.sent)).length, sentBefore);
                  assert.strictEqual(
                    (yield* team.readSpec(lead, {})).current.version,
                    spec.current.version,
                  );
                  assert.strictEqual(
                    controls.mock.calls.filter(([message]) => message.op === "journal-applied")
                      .length,
                    entries.length,
                  );
                  assert.strictEqual(
                    controls.mock.calls
                      .filter(([message]) => message.op === "journal-applied")
                      .at(-1)?.[0].seq,
                    entries.length,
                  );
                  // Even with the applied marker lost (a crash before it was saved), the
                  // child's finish note is written once.
                  runtime["appliedSeq"].delete(mac);
                  yield* Effect.promise(() => runtime["replayJournal"](session));
                  const finishNotes = (yield* repository.listTaskEvents({
                    taskId: task.id,
                    limit: 200,
                  })).filter((event) => event.body.startsWith("Offline child review-1 finished"));
                  assert.strictEqual(finishNotes.length, 1);
                } finally {
                  reads.mockRestore();
                  controls.mockRestore();
                  process.stdin.end();
                }
              }),
            {
              cloudLead: CloudLeadService.hooksFromRuntime(runtime),
              settings: { taskExecution: { location: "local_first" } },
            },
          ),
        ({ cleanup }) => Effect.promise(cleanup),
      ),
  );

  const claude = ProviderInstanceId.make("claude-work");
  const codex = ProviderInstanceId.make("codex");
  const PLAN = { providerInstanceId: claude, model: "claude-opus-5-5" };
  const CODEX_MODEL = { providerInstanceId: codex, model: "gpt-6.1-sol" };

  /** A cloud task whose lead is mid-turn in its sandbox, with implement and fix on Codex. */
  const cloudLeadMidTurn = (
    harness: Parameters<Parameters<typeof withTeam>[0]>[0],
    runtime: CloudLeadRuntime,
    mac: string,
  ) =>
    Effect.gen(function* () {
      const team = yield* service;
      const pm = yield* setUpManager;
      harness.providers.push(
        { instanceId: claude, driver: "claudeAgent" } as unknown as ServerProvider,
        { instanceId: codex, driver: "codex" } as unknown as ServerProvider,
      );
      yield* team.updateSettings({
        projectId: PROJECT_ID,
        roleModels: { plan: PLAN, implement: CODEX_MODEL, fix: CODEX_MODEL },
      });
      const { task: created } = yield* createAcceptedTask(pm, {
        title: "Add hello.txt",
        request: "Add hello.txt.",
        intake: "New work.",
      });
      const { task, leadThreadId: lead } = yield* team.startTask(
        pm,
        { taskId: created.id, location: "cloud" },
        harness.delegate,
      );
      const thread = harness.addThread(lead);
      thread.worktreePath = mac;
      thread.branch = "t3/lead";
      thread.shell = { location: "cloud" };
      yield* approvePlan(lead);
      // The lead's turn has its sandbox up.
      yield* CloudLeadService.hooksFromRuntime(runtime).prepare({
        threadId: lead,
        worktreePath: mac,
        mcpEndpoint: "http://127.0.0.1:1/mcp",
      });
      return { team, pm, task, lead };
    });

  it.effect(
    "runs a cloud lead's implement child in its sandbox, on Claude when the cloud has no Codex login",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => setUpMachines()),
        ({ mac, client, runtime }) =>
          withTeam(
            (harness) =>
              Effect.gen(function* () {
                const { team, pm, task, lead } = yield* cloudLeadMidTurn(harness, runtime, mac);

                const step = yield* team.delegateStep(
                  lead,
                  { role: "implement", task: "Add hello.txt." },
                  harness.delegate,
                );
                // The child shares the lead's checkout (no isolation), on the plan model.
                const call = (yield* Ref.get(harness.delegated)).at(-1);
                assert.deepStrictEqual(call?.target, PLAN);
                assert.strictEqual(call?.isolation, undefined);

                // What delegate_task makes of it: a cloud child on the lead's worktree,
                // whose turn starts in the lead's sandbox.
                const childThread = harness.addThread(step.childThreadId);
                childThread.worktreePath = mac;
                childThread.shell = { location: "cloud", launchedByThreadId: lead };
                const launch = yield* CloudLeadService.hooksFromRuntime(runtime).prepare({
                  threadId: step.childThreadId,
                  worktreePath: mac,
                  mcpEndpoint: "http://127.0.0.1:1/mcp",
                });
                assert.strictEqual(client.created.length, 1);
                const child = launch.spawn({ command: "claude", args: [], env: {} });
                const output = outputOf(child);
                yield* Effect.promise(() => waitFor(() => output().includes("ready")));
                child.stdin.write("commit hello.txt\n");
                yield* Effect.promise(() => waitFor(() => output().includes("committed")));
                const sandboxHead = output().split("committed ")[1]!.trim();
                // The child's turn end mirrors the sandbox onto the Mac worktree.
                yield* CloudLeadService.hooksFromRuntime(runtime).syncToMac(step.childThreadId);
                assert.strictEqual(yield* Effect.promise(() => gitHead(mac)), sandboxHead);
                child.stdin.end();

                // Only this task moved implement and fix to Claude, and says why.
                const { task: after } = yield* team.readTask(pm, { taskId: task.id });
                assert.deepStrictEqual(after.roleModels.implement, PLAN);
                assert.deepStrictEqual(after.roleModels.fix, PLAN);
                assert.strictEqual(after.modelSteps.implement?.providerInstanceId, claude);
                const notes = yield* Effect.flatMap(
                  ProjectTeamRepository.ProjectTeamRepository,
                  (repository) => repository.listTaskEvents({ taskId: task.id, limit: 50 }),
                );
                assert.isTrue(
                  notes.some(
                    (event) =>
                      event.kind === "note" &&
                      event.body.includes("Codex") &&
                      event.body.includes("codex_auth_json"),
                  ),
                );
                // The project's models are untouched: a local task keeps Codex.
                const local = yield* startLead(pm, "Add local.txt", harness.delegate);
                yield* approvePlan(local.leadThreadId);
                yield* team.delegateStep(
                  local.leadThreadId,
                  { role: "implement", task: "Add local.txt." },
                  harness.delegate,
                );
                assert.deepStrictEqual(
                  (yield* Ref.get(harness.delegated)).at(-1)?.target,
                  CODEX_MODEL,
                );
              }),
            {
              cloudLead: CloudLeadService.hooksFromRuntime(runtime),
              settings: { taskExecution: { location: "local_first" } },
            },
          ),
        ({ cleanup }) => Effect.promise(cleanup),
      ),
  );

  it.effect(
    "keeps a cloud task's implement step on Codex when the cloud login works in the sandbox",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => setUpMachines({ codexAuth: '{"tokens":{"refresh_token":"valid"}}' })),
        ({ mac, runtime }) =>
          withTeam(
            (harness) =>
              Effect.gen(function* () {
                const { team, pm, task, lead } = yield* cloudLeadMidTurn(harness, runtime, mac);
                yield* team.delegateStep(
                  lead,
                  { role: "implement", task: "Add hello.txt." },
                  harness.delegate,
                );
                assert.deepStrictEqual(
                  (yield* Ref.get(harness.delegated)).at(-1)?.target,
                  CODEX_MODEL,
                );
                const { task: after } = yield* team.readTask(pm, { taskId: task.id });
                assert.strictEqual(after.modelSteps.implement?.providerInstanceId, codex);
                assert.strictEqual(after.roleModels.implement, undefined);
              }),
            {
              cloudLead: CloudLeadService.hooksFromRuntime(runtime),
              settings: { taskExecution: { location: "local_first" } },
            },
          ),
        ({ cleanup }) => Effect.promise(cleanup),
      ),
  );
});
