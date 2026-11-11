// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - drives the promise-based cloud lead runtime against local git repos.
/**
 * A lead in the middle of its work moves from the Mac to a cloud sandbox and
 * back with one call. Its uncommitted edits, its untracked files, its claude
 * session and its plan come along both ways; the turn running at the old place
 * is stopped, and messages wait until the lead is at the new place.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  isSandboxRotationDecision,
  isTurnFailedBlocker,
  type OrchestrationV2ServerCommand,
  SANDBOX_ROTATION_MOVE_LOCAL,
  ProviderDriverKind,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as NodeFs from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";

import { CloudLeadRuntime } from "../cloudLead/CloudLeadRuntime.ts";
import * as CloudLeadService from "../cloudLead/CloudLeadService.ts";
import * as LeadMoveGate from "../cloudLead/LeadMoveGate.ts";
import { encodeProjectDir } from "../cloudLead/pathRewrite.ts";
import type { RemoteProcess } from "../cloudLead/RelayClient.ts";
import { inspectMovableLead } from "../cloudLead/TaskMover.ts";
import { fakeLocalHost, localSandboxClient } from "../cloudLead/testkit.ts";
import { localMirrorShell } from "../cloudLead/WorkspaceMirror.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import {
  approvePlan,
  attentionContext,
  createAcceptedTask,
  PROJECT_ID,
  setUpManager,
  type TeamHarness,
  withTeam,
} from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;
const shell = localMirrorShell();
const SESSION = "0f9c2a4e-move-session";
const GIT_ENV =
  "export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t";

/**
 * The sandbox's claude: reports what it finds (its resumed transcript and the
 * uncommitted files), then works a little without committing: one more line in
 * the transcript, the tracked file and the untracked file.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const dir = process.env.HOME + "/.claude/projects/" + (process.env.HOME + "/busyboy").replace(/[^a-zA-Z0-9]/g, "-");
const transcript = dir + "/${SESSION}.jsonl";
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const seen = { transcript: read(transcript), readme: read("README.md"), notes: read("notes.txt") };
fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(transcript, '{"turn":"cloud"}\\n');
fs.appendFileSync("README.md", "cloud\\n");
fs.appendFileSync("notes.txt", "cloud\\n");
process.stdout.write(JSON.stringify(seen) + "\\n");
process.stdin.resume();
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

const firstLine = (child: RemoteProcess) =>
  new Promise<Record<string, string | null>>((resolve) => {
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const end = text.indexOf("\n");
      if (end !== -1) resolve(JSON.parse(text.slice(0, end)) as Record<string, string | null>);
    });
  });

const setUpMachines = async () => {
  const root = await NodeFs.mkdtemp(`${NodeOs.tmpdir()}/move-journey-`);
  const macHome = `${root}/mac-home`;
  const mac = `${macHome}/worktrees/lead`;
  const binDir = `${root}/bin`;
  await NodeFs.mkdir(binDir, { recursive: true });
  await NodeFs.writeFile(`${binDir}/claude`, FAKE_CLAUDE, { mode: 0o755 });
  await shell.run(
    `mkdir -p '${mac}' && cd '${mac}' && ${GIT_ENV} && git init -q -b main && echo base > README.md && git add . && git commit -qm base && git checkout -qb t3/lead`,
  );
  // The lead's work so far on the Mac: an edit and a new file, neither committed.
  await NodeFs.appendFile(`${mac}/README.md`, "mac\n");
  await NodeFs.writeFile(`${mac}/notes.txt`, "draft\n");
  // And its claude session, where Mac claude keeps it.
  const macTranscripts = `${macHome}/.claude/projects/${encodeProjectDir(await NodeFs.realpath(mac))}`;
  await NodeFs.mkdir(macTranscripts, { recursive: true });
  await NodeFs.writeFile(`${macTranscripts}/${SESSION}.jsonl`, '{"turn":"mac"}\n');
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
  });
  const cleanup = async () => {
    await runtime.releaseAll();
    await NodeFs.rm(root, { recursive: true, force: true });
  };
  return { mac, macTranscripts, client, runtime, cleanup };
};

/** Starts a local task, gives its lead a Claude session and approves its plan. */
const startImplementingTask = (harness: TeamHarness, worktreePath: string) =>
  Effect.gen(function* () {
    const team = yield* service;
    const pm = yield* setUpManager;
    const { task: created } = yield* createAcceptedTask(pm, {
      title: "Add notes",
      request: "Add notes.",
      intake: "New work.",
    });
    const { task, leadThreadId: lead } = yield* team.startTask(
      pm,
      { taskId: created.id },
      harness.delegate,
    );
    const thread = harness.addThread(lead);
    thread.worktreePath = worktreePath;
    thread.branch = "t3/lead";
    const driver = ProviderDriverKind.make("claudeAgent");
    thread.providerThreads = [
      {
        id: ProviderThreadId.make("provider-thread:lead"),
        driver,
        nativeThreadRef: { driver, nativeId: SESSION, strength: "strong" },
      },
    ];
    thread.shell = { activeProviderThreadId: ProviderThreadId.make("provider-thread:lead") };
    yield* approvePlan(lead);
    return { pm, task, lead, thread };
  });

const commandsTo = (harness: TeamHarness, lead: ThreadId) =>
  Ref.get(harness.dispatched).pipe(
    Effect.map((commands) =>
      commands.filter(
        (command): command is OrchestrationV2ServerCommand & { readonly threadId: ThreadId } =>
          "threadId" in command && command.threadId === lead,
      ),
    ),
  );

/** The lead's commands a move sends, in order, named for reading. */
const moveSteps = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  commands.flatMap((command): string[] => {
    switch (command.type) {
      case "run.interrupt":
        return [`interrupt${command.holdQueue === true ? " holding the queue" : ""}`];
      case "thread.metadata.update":
        return command.location === undefined ? [] : [`location ${command.location}`];
      case "message.dispatch":
        return [`message ${command.text}`];
      case "queue.resume":
        return ["resume queue"];
      default:
        return [];
    }
  });

const fakeHooks = (
  overrides: Partial<CloudLeadService.CloudLeadHooksShape>,
): CloudLeadService.CloudLeadHooksShape => ({
  ...CloudLeadService.unavailableHooks,
  importTranscripts: () => Effect.void,
  hasTranscript: () => Effect.succeed(true),
  ...overrides,
});

describe("moving a task lead", () => {
  it.effect(
    "moves an implementing lead to the cloud and back with its edits, session and plan",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(setUpMachines),
        ({ mac, macTranscripts, client, runtime }) => {
          const hooks = CloudLeadService.hooksFromRuntime(runtime);
          const duringMove: Array<{ readonly held: boolean; readonly steps: string[] }> = [];
          let leadId: ThreadId | null = null;
          let harnessRef: TeamHarness | null = null;
          // How many of the lead's commands came before the current move.
          let mark = 0;
          // Looks at the lead halfway through each move, while the transcripts move.
          const peek = Effect.gen(function* () {
            const gate = yield* LeadMoveGate.LeadMoveGate;
            duringMove.push({
              held: gate.isHeld(leadId!),
              steps: moveSteps((yield* commandsTo(harnessRef!, leadId!)).slice(mark)),
            });
          });
          return withTeam(
            (harness) =>
              Effect.gen(function* () {
                const team = yield* service;
                const gate = yield* LeadMoveGate.LeadMoveGate;
                const { pm, task, lead, thread } = yield* startImplementingTask(harness, mac);
                leadId = lead;
                harnessRef = harness;
                const planBefore = (yield* team.readSpec(lead, {})).current.spec;
                const head = (yield* Effect.promise(() =>
                  shell.run(`git -C '${mac}' rev-parse HEAD`),
                )).trim();

                // The lead is mid-turn on the Mac when the user moves it to the cloud.
                thread.activeRunId = "run:mac";
                mark = (yield* commandsTo(harness, lead)).length;
                const toCloud = yield* team.moveTask({
                  projectId: PROJECT_ID,
                  taskId: task.id,
                  to: "cloud",
                });
                assert.strictEqual(toCloud.task.location, "cloud");
                assert.strictEqual(toCloud.task.moveTarget ?? null, null);
                assert.strictEqual(thread.shell?.location, "cloud");
                // The Mac turn was stopped with its queue held; a message sent then
                // waited, and the queue went on only once the lead was in the cloud.
                assert.deepEqual(duringMove[0], {
                  held: true,
                  steps: ["interrupt holding the queue"],
                });
                assert.deepEqual(moveSteps((yield* commandsTo(harness, lead)).slice(mark)), [
                  "interrupt holding the queue",
                  "location cloud",
                  "message [옮김] 로컬→클라우드",
                  "resume queue",
                ]);
                assert.isFalse(gate.isHeld(lead));
                assert.isFalse(gate.takeFreshSession(lead));
                const summary = (yield* team.attentionSnapshot).projects
                  .find((project) => project.projectId === PROJECT_ID)
                  ?.tasks.find((entry) => entry.id === task.id);
                assert.strictEqual(summary?.location, "cloud");
                assert.strictEqual(summary?.moveTarget, null);

                // The next turn runs in a new sandbox: same claude session, same edits.
                const launch = yield* hooks.prepare({
                  threadId: lead,
                  worktreePath: mac,
                  mcpEndpoint: "http://127.0.0.1:1/mcp",
                });
                const child = launch.spawn({ command: "claude", args: [], env: {} });
                const seen = yield* Effect.promise(() => firstLine(child));
                assert.deepEqual(seen, {
                  transcript: '{"turn":"mac"}\n',
                  readme: "base\nmac\n",
                  notes: "draft\n",
                });
                thread.activeRunId = "run:cloud";
                harness.onInterrupt = (threadId) =>
                  Effect.promise(
                    () =>
                      new Promise<void>((resolve) => {
                        child.once("exit", () => resolve());
                        child.kill("SIGTERM");
                      }),
                  ).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        harness.threads.get(threadId)!.activeRunId = null;
                      }),
                    ),
                  );

                // Mid-turn in the cloud, the user brings it back to the Mac.
                mark = (yield* commandsTo(harness, lead)).length;
                const toLocal = yield* team.moveTask({
                  projectId: PROJECT_ID,
                  taskId: task.id,
                  to: "local",
                });
                assert.strictEqual(toLocal.task.location, "local");
                assert.strictEqual(thread.shell?.location, "local");
                assert.isTrue(duringMove[1]!.held);
                assert.deepEqual(moveSteps((yield* commandsTo(harness, lead)).slice(mark)), [
                  "interrupt holding the queue",
                  "location local",
                  "message [옮김] 클라우드→로컬",
                  "resume queue",
                ]);
                assert.isTrue(client.created[0]!.deleted());
                assert.isFalse(gate.takeFreshSession(lead));

                // The cloud's work is on the Mac, still uncommitted, on the same commit.
                // (The mirror applies edits with --index, so the tracked one comes back staged.)
                const uncommitted = yield* Effect.promise(() =>
                  shell.run(
                    `git -C '${mac}' diff HEAD --name-only && git -C '${mac}' ls-files --others --exclude-standard`,
                  ),
                );
                assert.deepEqual(uncommitted.trim().split("\n"), ["README.md", "notes.txt"]);
                assert.strictEqual(
                  (yield* Effect.promise(() => shell.run(`git -C '${mac}' rev-parse HEAD`))).trim(),
                  head,
                );
                assert.strictEqual(
                  yield* Effect.promise(() => NodeFs.readFile(`${mac}/README.md`, "utf8")),
                  "base\nmac\ncloud\n",
                );
                assert.strictEqual(
                  yield* Effect.promise(() => NodeFs.readFile(`${mac}/notes.txt`, "utf8")),
                  "draft\ncloud\n",
                );
                // Mac claude resumes the same session, now with the cloud turn in it.
                assert.strictEqual(
                  yield* Effect.promise(() =>
                    NodeFs.readFile(`${macTranscripts}/${SESSION}.jsonl`, "utf8"),
                  ),
                  '{"turn":"mac"}\n{"turn":"cloud"}\n',
                );
                assert.strictEqual(thread.providerThreads?.[0]?.nativeThreadRef?.nativeId, SESSION);
                const after = yield* team.readTask(pm, { taskId: task.id });
                assert.deepEqual(after.task.stage, "running");
                assert.deepEqual(
                  (yield* team.readSpec(lead, {})).current.spec.todos,
                  planBefore.todos,
                );
                assert.includeMembers(
                  after.events.map((event) => event.body),
                  ["리드를 로컬에서 클라우드로 옮겼어요.", "리드를 클라우드에서 로컬로 옮겼어요."],
                );
              }),
            {
              cloudLead: {
                ...hooks,
                importTranscripts: (input) =>
                  peek.pipe(Effect.andThen(hooks.importTranscripts(input))),
                exportTranscripts: (input) =>
                  peek.pipe(Effect.andThen(hooks.exportTranscripts(input))),
              },
            },
          );
        },
        ({ cleanup }) => Effect.promise(cleanup),
      ),
  );

  it.effect("puts the lead back where it was when the move fails", () =>
    withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const gate = yield* LeadMoveGate.LeadMoveGate;
          const { pm, task, lead, thread } = yield* startImplementingTask(harness, "/tmp/lead");
          thread.activeRunId = "run:mac";
          const mark = (yield* commandsTo(harness, lead)).length;

          const failure = yield* team
            .moveTask({ projectId: PROJECT_ID, taskId: task.id, to: "cloud" })
            .pipe(Effect.flip);
          assert.include(failure.message, "디스크가 가득 찼어요");

          const after = yield* team.readTask(pm, { taskId: task.id });
          assert.strictEqual(after.task.location, "local");
          assert.strictEqual(after.task.moveTarget ?? null, null);
          assert.strictEqual(thread.shell?.location ?? "local", "local");
          assert.isFalse(gate.isHeld(lead));
          assert.isFalse(gate.takeFreshSession(lead));
          assert.deepEqual(moveSteps((yield* commandsTo(harness, lead)).slice(mark)), [
            "interrupt holding the queue",
            "location local",
            "message [옮김 실패] 로컬에서 그대로 이어가요.",
            "resume queue",
          ]);
          assert.isTrue(
            after.events.some(
              (event) =>
                event.body.startsWith("리드를 클라우드로 옮기지 못해 로컬에 그대로 뒀어요") &&
                event.body.includes("디스크가 가득 찼어요"),
            ),
          );

          // Nothing is left half-moved: the next move can run.
          const refused = yield* team
            .moveTask({ projectId: PROJECT_ID, taskId: task.id, to: "local" })
            .pipe(Effect.flip);
          assert.include(refused.message, "이미 로컬에서 실행 중이에요.");
        }),
      {
        cloudLead: fakeHooks({
          importTranscripts: () =>
            Effect.fail(new CloudLeadService.CloudLeadError({ detail: "디스크가 가득 찼어요" })),
        }),
      },
    ),
  );

  it.effect("starts a fresh session from a summary when the transcript did not arrive", () =>
    withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const gate = yield* LeadMoveGate.LeadMoveGate;
          const { pm, task, lead } = yield* startImplementingTask(harness, "/tmp/lead");

          const moved = yield* team.moveTask({
            projectId: PROJECT_ID,
            taskId: task.id,
            to: "cloud",
          });
          assert.strictEqual(moved.task.location, "cloud");
          // The lead's next turn starts a new provider session with a handoff summary.
          assert.isTrue(gate.takeFreshSession(lead));
          const { events } = yield* team.readTask(pm, { taskId: task.id });
          assert.isTrue(
            events.some((event) =>
              event.body.includes("다음 턴은 지금까지의 요약으로 새 세션에서 시작해요"),
            ),
          );
        }),
      { cloudLead: fakeHooks({ hasTranscript: () => Effect.succeed(false) }) },
    ),
  );

  it.effect(
    "waits for children on the lead's checkout, then holds and moves them with the lead",
    () => {
      const heldDuringMove: boolean[] = [];
      let gate: LeadMoveGate.LeadMoveGateShape | null = null;
      return withTeam(
        (harness) =>
          Effect.gen(function* () {
            const team = yield* service;
            gate = yield* LeadMoveGate.LeadMoveGate;
            const { task, lead } = yield* startImplementingTask(harness, "/tmp/lead");
            // An implement child on the lead's checkout, and a review child on its own.
            const implement = harness.addThread(ThreadId.make("thread:implement"));
            implement.title = "Add notes implement";
            implement.worktreePath = "/tmp/lead";
            implement.shell = { launchedByThreadId: lead };
            implement.activeRunId = "run:implement";
            const isolated = harness.addThread(ThreadId.make("thread:isolated"));
            isolated.worktreePath = "/tmp/isolated";
            isolated.shell = { launchedByThreadId: lead };

            const refused = yield* team
              .moveTask({ projectId: PROJECT_ID, taskId: task.id, to: "cloud" })
              .pipe(Effect.flip);
            assert.include(refused.message, "Add notes implement");
            assert.include(refused.message, "아직 진행 중이라 옮길 수 없어요");

            // Once the child is done, it is held through the move and moves with the lead;
            // the isolated one stays where it is.
            implement.activeRunId = null;
            const moved = yield* team.moveTask({
              projectId: PROJECT_ID,
              taskId: task.id,
              to: "cloud",
            });
            assert.strictEqual(moved.task.location, "cloud");
            assert.deepEqual(heldDuringMove, [true]);
            assert.isFalse(gate.isHeld(implement.id));
            assert.deepEqual(moveSteps(yield* commandsTo(harness, implement.id)), [
              "location cloud",
              "resume queue",
            ]);
            assert.deepEqual(moveSteps(yield* commandsTo(harness, isolated.id)), []);
          }),
        {
          cloudLead: fakeHooks({
            importTranscripts: () =>
              Effect.sync(() => {
                heldDuringMove.push(gate!.isHeldFor(ThreadId.make("thread:implement"), "move"));
              }),
          }),
        },
      );
    },
  );

  it.effect("starts a stopped local lead again in the cloud, moving it with its session", () =>
    withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const { pm, task, lead } = yield* startImplementingTask(harness, "/tmp/lead");
          // The lead's turn failed, so the task is blocked with a failed-turn card.
          yield* team.recordOutcome({
            task: (yield* team.readTask(pm, { taskId: task.id })).task,
            outcome: "failed",
            detail: "Claude stopped",
          });
          assert.strictEqual((yield* team.readTask(pm, { taskId: task.id })).task.stage, "blocked");

          const started = yield* team.startTask(
            pm,
            { taskId: task.id, location: "cloud" },
            harness.delegate,
          );
          assert.strictEqual(started.leadThreadId, lead);
          const after = yield* team.readTask(pm, { taskId: task.id });
          assert.strictEqual(after.task.location, "cloud");
          assert.strictEqual(after.task.stage, "running");
          assert.isFalse(after.openAttention.some(isTurnFailedBlocker));
          assert.include(yield* harness.messagesTo(lead), "[옮김] 로컬→클라우드");
        }),
      { cloudLead: fakeHooks({}) },
    ),
  );

  it.effect("refuses to start a task again while its lead is still working", () =>
    withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const { pm, task, thread } = yield* startImplementingTask(harness, "/tmp/lead");
          thread.activeRunId = "run:mac";
          const refused = yield* team
            .startTask(pm, { taskId: task.id, location: "cloud" }, harness.delegate)
            .pipe(Effect.flip);
          assert.include(refused.message, "lead is still working");
          const after = yield* team.readTask(pm, { taskId: task.id });
          assert.strictEqual(after.task.location, "local");
          assert.strictEqual(after.task.leadThreadId, thread.id);
        }),
      { cloudLead: fakeHooks({}) },
    ),
  );

  it.effect("starts a fresh lead when a stopped lead is started again in the same place", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const { pm, task, lead } = yield* startImplementingTask(harness, "/tmp/lead");
        yield* team.recordOutcome({
          task: (yield* team.readTask(pm, { taskId: task.id })).task,
          outcome: "failed",
          detail: "Claude stopped",
        });
        const started = yield* team.startTask(pm, { taskId: task.id }, harness.delegate);
        assert.notStrictEqual(started.leadThreadId, lead);
        assert.strictEqual(started.task.stage, "planning");
        assert.strictEqual(started.task.leadThreadId, started.leadThreadId);
        const after = yield* team.readTask(pm, { taskId: task.id });
        assert.isTrue(after.events.some((event) => event.body === "blocked → planning"));
        // The replaced lead's failed-turn card goes with it, and it stays quiet.
        assert.deepEqual(after.openAttention, []);
        const gate = yield* LeadMoveGate.LeadMoveGate;
        assert.isTrue(gate.isHeldFor(lead, "replaced"));
        // The gate outlives this test; other tests reuse the lead's id.
        gate.release(lead, "replaced");
      }),
    ),
  );

  it.effect("keeps a stopped task and its card as they were when a restart is refused", () =>
    withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const { pm, task } = yield* startImplementingTask(harness, "/tmp/lead");
          yield* team.recordOutcome({
            task: (yield* team.readTask(pm, { taskId: task.id })).task,
            outcome: "failed",
            detail: "Claude stopped",
          });
          // Another lead takes the only slot.
          const { task: other } = yield* createAcceptedTask(pm, {
            title: "Other",
            request: "Other.",
            intake: "New work.",
          });
          yield* team.startTask(pm, { taskId: other.id }, harness.delegate);

          const refused = yield* team
            .startTask(pm, { taskId: task.id }, harness.delegate)
            .pipe(Effect.flip);
          assert.include(refused.message, "cannot start again yet");
          const after = yield* team.readTask(pm, { taskId: task.id });
          assert.strictEqual(after.task.stage, "blocked");
          assert.isTrue(after.openAttention.some(isTurnFailedBlocker));
        }),
      { settings: { taskExecution: { maxConcurrentSessions: 1 } } },
    ),
  );

  it.effect("leaves the task as it was when the restart's move fails", () =>
    withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const { pm, task, lead } = yield* startImplementingTask(harness, "/tmp/lead");
          yield* team.recordOutcome({
            task: (yield* team.readTask(pm, { taskId: task.id })).task,
            outcome: "failed",
            detail: "Claude stopped",
          });
          const failure = yield* team
            .startTask(pm, { taskId: task.id, location: "cloud" }, harness.delegate)
            .pipe(Effect.flip);
          assert.include(failure.message, "디스크가 가득 찼어요");
          const after = yield* team.readTask(pm, { taskId: task.id });
          // No fresh lead replaces the session over a passing failure.
          assert.strictEqual(after.task.leadThreadId, lead);
          assert.strictEqual(after.task.location, "local");
          assert.strictEqual(after.task.stage, "blocked");
          assert.isTrue(after.openAttention.some(isTurnFailedBlocker));
        }),
      {
        cloudLead: fakeHooks({
          importTranscripts: () =>
            Effect.fail(new CloudLeadService.CloudLeadError({ detail: "디스크가 가득 찼어요" })),
        }),
      },
    ),
  );

  it.effect("keeps the card of a lead that fails again while it moves", () => {
    let failAgain: Effect.Effect<void> = Effect.void;
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const { pm, task } = yield* startImplementingTask(harness, "/tmp/lead");
          yield* team.recordOutcome({
            task: (yield* team.readTask(pm, { taskId: task.id })).task,
            outcome: "failed",
            detail: "Claude stopped",
          });
          failAgain = Effect.gen(function* () {
            yield* team.recordOutcome({
              task: (yield* team.readTask(pm, { taskId: task.id })).task,
              outcome: "failed",
              detail: "Cloud leads need a Claude setup-token.",
            });
          }).pipe(Effect.orDie);
          yield* team.startTask(pm, { taskId: task.id, location: "cloud" }, harness.delegate);
          const after = yield* team.readTask(pm, { taskId: task.id });
          assert.strictEqual(after.task.location, "cloud");
          assert.strictEqual(after.task.stage, "blocked");
          assert.isTrue(after.openAttention.some(isTurnFailedBlocker));
        }),
      { cloudLead: fakeHooks({ importTranscripts: () => Effect.suspend(() => failAgain) }) },
    );
  });

  it.effect("does not move a blocked cloud lead back to a Mac with no free slot", () =>
    withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const { pm, task, lead } = yield* startImplementingTask(harness, "/tmp/lead");
          yield* team.moveTask({ projectId: PROJECT_ID, taskId: task.id, to: "cloud" });
          yield* team.recordOutcome({
            task: (yield* team.readTask(pm, { taskId: task.id })).task,
            outcome: "failed",
            detail: "Claude stopped",
          });
          // Another lead takes the only local slot.
          const { task: other } = yield* createAcceptedTask(pm, {
            title: "Other",
            request: "Other.",
            intake: "New work.",
          });
          yield* team.startTask(pm, { taskId: other.id }, harness.delegate);
          const refused = yield* team
            .startTask(pm, { taskId: task.id, location: "local" }, harness.delegate)
            .pipe(Effect.flip);
          assert.include(refused.message, "cannot start again yet");
          const after = yield* team.readTask(pm, { taskId: task.id });
          assert.strictEqual(after.task.location, "cloud");
          assert.strictEqual(after.task.leadThreadId, lead);
          assert.isTrue(after.openAttention.some(isTurnFailedBlocker));
        }),
      {
        cloudLead: fakeHooks({}),
        settings: { taskExecution: { maxConcurrentSessions: 1 } },
      },
    ),
  );

  it.effect("starts a fresh lead in the cloud when the lead cannot move", () =>
    withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const { pm, task, lead, thread } = yield* startImplementingTask(harness, "/tmp/lead");
          const codex = ProviderDriverKind.make("codex");
          thread.providerThreads = [{ ...thread.providerThreads![0]!, driver: codex }];
          const started = yield* team.startTask(
            pm,
            { taskId: task.id, location: "cloud" },
            harness.delegate,
          );
          assert.notStrictEqual(started.leadThreadId, lead);
          assert.strictEqual(started.task.location, "cloud");
          const { events } = yield* team.readTask(pm, { taskId: task.id });
          assert.isTrue(
            events.some((event) =>
              event.body.startsWith("리드를 옮길 수 없어 새 리드로 다시 시작했어요"),
            ),
          );
          (yield* LeadMoveGate.LeadMoveGate).release(lead, "replaced");
        }),
      { cloudLead: fakeHooks({}), settings: { taskExecution: { location: "local_first" } } },
    ),
  );

  it.effect("fails rather than calls a lead unmovable when its thread cannot be read", () =>
    Effect.gen(function* () {
      const failure = yield* inspectMovableLead(
        {
          threads: {
            getThreadShell: () =>
              Effect.fail(new CloudLeadService.CloudLeadError({ detail: "database is locked" })),
          } as never,
          providers: Effect.succeed([]),
        },
        ThreadId.make("thread:lead"),
      ).pipe(Effect.flip);
      assert.include(failure.message, "database is locked");
    }),
  );

  it.effect("refuses a restart while the lead waits on the user's answer", () =>
    withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const { pm, task, lead } = yield* startImplementingTask(harness, "/tmp/lead");
          yield* team.askUser(lead, {
            context: attentionContext({ action: "Keep the old API?" }),
            kind: "decision",
            question: "Keep the old API?",
          });
          const refused = yield* team
            .startTask(pm, { taskId: task.id, location: "cloud" }, harness.delegate)
            .pipe(Effect.flip);
          assert.include(refused.message, "waits on the user's answer");
          const after = yield* team.readTask(pm, { taskId: task.id });
          assert.strictEqual(after.task.location, "local");
          assert.strictEqual(after.openAttention.length, 1);
        }),
      { cloudLead: fakeHooks({}) },
    ),
  );

  it.effect("refuses a lead that is not a Claude thread", () =>
    withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const { task, thread } = yield* startImplementingTask(harness, "/tmp/lead");
          const codex = ProviderDriverKind.make("codex");
          thread.providerThreads = [{ ...thread.providerThreads![0]!, driver: codex }];
          const refused = yield* team
            .moveTask({ projectId: PROJECT_ID, taskId: task.id, to: "cloud" })
            .pipe(Effect.flip);
          assert.include(refused.message, "Claude 리드만");
        }),
      { cloudLead: fakeHooks({}) },
    ),
  );

  it.effect(
    "replaces a cloud lead's sandbox mid-turn, and offers to bring it home when that fails",
    () => {
      let rotation: CloudLeadService.RotationHandler | null = null;
      const released: string[] = [];
      return withTeam(
        (harness) =>
          Effect.gen(function* () {
            const team = yield* service;
            const gate = yield* LeadMoveGate.LeadMoveGate;
            const { pm, task, lead, thread } = yield* startImplementingTask(harness, "/tmp/lead");
            yield* team.moveTask({ projectId: PROJECT_ID, taskId: task.id, to: "cloud" });

            // The sandbox nears its limit mid-turn: the turn stops with its queue held,
            // and once the new sandbox is ready the lead goes on there.
            thread.activeRunId = "run:cloud";
            const mark = (yield* commandsTo(harness, lead)).length;
            yield* rotation!.interrupt(lead);
            assert.isTrue(gate.isHeld(lead));
            yield* rotation!.resume(lead);
            assert.isFalse(gate.isHeld(lead));
            assert.deepEqual(moveSteps((yield* commandsTo(harness, lead)).slice(mark)), [
              "interrupt holding the queue",
              "message [교체] 새 클라우드 샌드박스에서 이어가요.",
              "resume queue",
            ]);

            // A replacement that fails asks the user once.
            yield* rotation!.failed(lead, "Vercel API가 응답하지 않아요");
            yield* rotation!.failed(lead, "Vercel API가 응답하지 않아요");
            const cards = (yield* team.readTask(pm, { taskId: task.id })).openAttention.filter(
              isSandboxRotationDecision,
            );
            assert.strictEqual(cards.length, 1);
            assert.include(cards[0]!.question, "Vercel API가 응답하지 않아요");

            // "로컬로 가져오기" brings the lead to the Mac.
            yield* team.answerDecision({
              projectId: PROJECT_ID,
              attentionItemId: cards[0]!.id,
              answer: SANDBOX_ROTATION_MOVE_LOCAL,
            });
            const after = yield* team.readTask(pm, { taskId: task.id });
            assert.strictEqual(after.task.location, "local");
            assert.strictEqual(thread.shell?.location, "local");
            // The sandbox is the lead's checkout, released by its worktree.
            assert.deepEqual(released, ["/tmp/lead"]);
            assert.isFalse(after.openAttention.some(isSandboxRotationDecision));
            assert.include(yield* harness.messagesTo(lead), "[옮김] 클라우드→로컬");
          }),
        {
          cloudLead: fakeHooks({
            setRotationHandler: (handler) => Effect.sync(() => void (rotation = handler)),
            release: (threadId) => Effect.sync(() => void released.push(threadId)),
          }),
        },
      );
    },
  );
});
