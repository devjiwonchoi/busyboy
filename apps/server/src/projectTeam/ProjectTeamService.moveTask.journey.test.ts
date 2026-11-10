// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - drives the promise-based cloud lead runtime against local git repos.
/**
 * A lead in the middle of its work moves from the Mac to a cloud sandbox and
 * back with one call. Its uncommitted edits, its untracked files, its claude
 * session and its plan come along both ways; the turn running at the old place
 * is stopped, and messages wait until the lead is at the new place.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2ServerCommand,
  ProviderDriverKind,
  ProviderThreadId,
  type ThreadId,
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
import { fakeLocalHost, localSandboxClient } from "../cloudLead/testkit.ts";
import { localMirrorShell } from "../cloudLead/WorkspaceMirror.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import {
  approvePlan,
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
});
