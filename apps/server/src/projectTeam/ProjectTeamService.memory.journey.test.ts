/**
 * Task leads start by the Mac's free memory instead of a fixed count, and the
 * memory governor pauses and resumes them when memory runs short. Under the
 * user's local-only setting nothing goes to the cloud: work waits instead.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  type ExecutionLocation,
  OrchestratorMcpFailure,
  type OrchestrationV2ServerCommand,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as CloudLeadService from "../cloudLead/CloudLeadService.ts";
import * as LeadMoveGate from "../cloudLead/LeadMoveGate.ts";
import type * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import type { MemorySnapshot } from "../resourceTelemetry/MemoryHeadroom.ts";
import * as MemoryGovernor from "./MemoryGovernor.ts";
import { CLOUD_FALLBACK_NOTE, MEMORY_WAIT_REASON, STARTED_IN_CLOUD_NOTE } from "./memoryPolicy.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import type { DelegateTaskLead } from "./ProjectTeamService.ts";
import { createAcceptedTask, setUpManager, START, type TeamHarness, withTeam } from "./testkit.ts";

const GIB = 1024 ** 3;
const PLENTY: MemorySnapshot = { availableMemoryBytes: 6 * GIB, memoryPressure: "normal" };
const TIGHT: MemorySnapshot = { availableMemoryBytes: 1 * GIB, memoryPressure: "normal" };
const CRITICAL: MemorySnapshot = { availableMemoryBytes: 0.5 * GIB, memoryPressure: "normal" };

/** The Mac's memory, which a test sets; releasing a session frees `freedPerRelease`. */
const fakeMac = (initial: MemorySnapshot, freedPerRelease = 0) => {
  const mac = {
    memory: initial,
    live: new Set<string>(),
    released: [] as Array<{ readonly id: string; readonly reason: string }>,
    cloudCalls: [] as Array<string>,
  };
  const sessions: Partial<ProviderSessionManager.ProviderSessionManagerV2Shape> = {
    isLive: (id) => Effect.sync(() => mac.live.has(id)),
    release: ({ providerSessionId, reason }) =>
      Effect.sync(() => {
        mac.released.push({ id: providerSessionId, reason });
        mac.live.delete(providerSessionId);
        mac.memory = {
          ...mac.memory,
          availableMemoryBytes: mac.memory.availableMemoryBytes + freedPerRelease,
        };
      }),
  };
  const record =
    (name: string) =>
    (...args: ReadonlyArray<unknown>) =>
      Effect.sync(() => void mac.cloudCalls.push(`${name} ${JSON.stringify(args)}`));
  const cloudLead: CloudLeadService.CloudLeadHooksShape = {
    ...CloudLeadService.unavailableHooks,
    syncToMac: record("syncToMac"),
    release: record("release"),
    importTranscripts: record("importTranscripts"),
    exportTranscripts: record("exportTranscripts"),
    hasTranscript: (input) => record("hasTranscript")(input).pipe(Effect.as(true)),
  };
  return { mac, sessions, cloudLead, read: () => mac.memory };
};

const iso = (offsetMs: number) => DateTime.makeUnsafe(Date.parse(START) + offsetMs);

interface SessionState {
  readonly running?: { readonly startedMsAgo: number };
  readonly visitedMsAgo?: number;
}

/** Gives a thread a live Claude session, idle or mid-turn. */
const giveSession = (
  harness: TeamHarness,
  mac: ReturnType<typeof fakeMac>["mac"],
  threadId: ThreadId,
  state: SessionState & { readonly launchedBy?: ThreadId } = {},
) => {
  const thread = harness.threads.get(threadId) ?? harness.addThread(threadId);
  thread.worktreePath = `/worktrees/${threadId}`;
  const driver = ProviderDriverKind.make("claudeAgent");
  const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
  const providerSessionId = ProviderSessionId.make(`session:${threadId}`);
  thread.providerThreads = [
    {
      id: providerThreadId,
      driver,
      nativeThreadRef: { driver, nativeId: `claude-${threadId}`, strength: "strong" },
      providerSessionId,
    },
  ];
  mac.live.add(providerSessionId);
  thread.activeRunId = state.running === undefined ? null : `run:${threadId}`;
  thread.shell = {
    activeProviderThreadId: providerThreadId,
    ...(state.launchedBy === undefined ? {} : { launchedByThreadId: state.launchedBy }),
    ...(state.running === undefined
      ? {}
      : { latestRunStartedAt: iso(-state.running.startedMsAgo) }),
    ...(state.visitedMsAgo === undefined ? {} : { lastVisitedAt: iso(-state.visitedMsAgo) }),
  };
  return thread;
};

/** Starts a task's lead and gives it a Claude session, idle or mid-turn. */
const startWithSession = (
  harness: TeamHarness,
  mac: ReturnType<typeof fakeMac>["mac"],
  pm: ThreadId,
  title: string,
  state: {
    readonly running?: { readonly startedMsAgo: number };
    readonly visitedMsAgo?: number;
    readonly location?: ExecutionLocation;
  } = {},
) =>
  Effect.gen(function* () {
    const team = yield* ProjectTeamService.ProjectTeamService;
    const { task: created } = yield* createAcceptedTask(pm, {
      title,
      request: `${title}.`,
      intake: "New work.",
    });
    const { task, leadThreadId: lead } = yield* team.startTask(
      pm,
      { taskId: created.id, ...(state.location === undefined ? {} : { location: state.location }) },
      harness.delegate,
    );
    const thread = giveSession(harness, mac, lead, state);
    return { task, lead, thread };
  });

/** Ticks until a resume is due: two ok samples in a row. */
const resumeTicks = (governor: MemoryGovernor.MemoryGovernor["Service"]) =>
  Effect.gen(function* () {
    yield* governor.tick;
  });

const commandsTo = (harness: TeamHarness, threadId: ThreadId) =>
  Ref.get(harness.dispatched).pipe(
    Effect.map((commands) =>
      commands.filter(
        (command): command is OrchestrationV2ServerCommand & { readonly threadId: ThreadId } =>
          "threadId" in command && command.threadId === threadId,
      ),
    ),
  );

const readTask = (
  id: Parameters<ProjectTeamRepository.ProjectTeamRepository["Service"]["getTask"]>[0],
) =>
  Effect.flatMap(ProjectTeamRepository.ProjectTeamRepository, (repository) =>
    repository.getTask(id).pipe(Effect.map(Option.getOrThrow)),
  );

const notesOf = (taskId: Parameters<typeof readTask>[0]) =>
  Effect.flatMap(ProjectTeamRepository.ProjectTeamRepository, (repository) =>
    repository
      .listTaskEvents({ taskId, limit: 100 })
      .pipe(
        Effect.map((events) =>
          events.filter((event) => event.kind === "note").map((event) => event.body),
        ),
      ),
  );

describe("memory-based task admission", () => {
  it.effect(
    "local only: pauses, resumes and starts waiting work without ever using the cloud",
    () => {
      // Each released session frees 0.3 GiB of memory.
      const fake = fakeMac(PLENTY, 0.3 * GIB);
      return withTeam(
        (harness) =>
          Effect.gen(function* () {
            const team = yield* ProjectTeamService.ProjectTeamService;
            const governor = yield* MemoryGovernor.MemoryGovernor;
            const gate = yield* LeadMoveGate.LeadMoveGate;
            const pm = yield* setUpManager;
            const idle = yield* startWithSession(harness, fake.mac, pm, "Idle lead");
            const busy = yield* startWithSession(harness, fake.mac, pm, "Busy lead", {
              running: { startedMsAgo: 20 * 60_000 },
            });
            const watched = yield* startWithSession(harness, fake.mac, pm, "Watched lead", {
              visitedMsAgo: 60_000,
            });

            // Memory runs out: a new task waits in Todo instead of starting.
            fake.mac.memory = CRITICAL;
            const created = yield* team.createTask(
              pm,
              {
                title: "Waiting work",
                request: "Waiting work.",
                intake: "New work.",
                goal: "Waiting work.",
                verification: "Check it.",
              },
              harness.delegate,
            );
            assert.include(created.waiting ?? "", MEMORY_WAIT_REASON);
            const waiting = yield* readTask(created.task.id);
            assert.strictEqual(waiting.stage, "inbox");
            assert.strictEqual(waiting.memoryHold, "waiting");
            // The PM asking for the cloud does not change that under local only.
            const retry = yield* team
              .startTask(pm, { taskId: waiting.id, location: "cloud" }, harness.delegate)
              .pipe(Effect.flip);
            assert.include(retry.message, MEMORY_WAIT_REASON);

            // The idle lead is paused first; that frees enough to leave the busy one alone.
            yield* governor.tick;
            assert.deepStrictEqual(yield* governor.paused, [idle.lead]);
            assert.isTrue(gate.isHeldFor(idle.lead, "memory"));
            assert.deepStrictEqual(fake.mac.released, [
              { id: `session:${idle.lead}`, reason: "memory_pressure" },
            ]);
            assert.strictEqual((yield* readTask(idle.task.id)).memoryHold, "paused");
            assert.strictEqual(busy.thread.activeRunId, `run:${busy.lead}`);

            // Critical again: the running lead is stopped too; the watched one and the PM never are.
            fake.mac.memory = CRITICAL;
            yield* governor.tick;
            assert.deepStrictEqual(yield* governor.paused, [idle.lead, busy.lead]);
            assert.isNull(busy.thread.activeRunId);
            const interrupt = (yield* commandsTo(harness, busy.lead)).find(
              (command) => command.type === "run.interrupt",
            );
            assert.isTrue(interrupt?.type === "run.interrupt" && interrupt.holdQueue === true);
            assert.isFalse(gate.isHeld(watched.lead));
            assert.isFalse(gate.isHeld(pm));
            assert.isTrue(fake.mac.live.has(`session:${watched.lead}`));
            assert.isFalse(
              (yield* commandsTo(harness, pm)).some((command) => command.type === "run.interrupt"),
            );

            // Memory comes back: the last paused lead resumes first, on its own session.
            fake.mac.memory = PLENTY;
            yield* governor.tick;
            assert.deepStrictEqual(yield* governor.paused, [idle.lead]);
            assert.isFalse(gate.isHeld(busy.lead));
            assert.isFalse(gate.takeFreshSession(busy.lead));
            const busyCommands = (yield* commandsTo(harness, busy.lead)).map((command) =>
              command.type === "message.dispatch" ? `message ${command.text}` : command.type,
            );
            assert.deepStrictEqual(busyCommands.slice(-3), [
              "run.interrupt",
              `message ${MemoryGovernor.RESUME_NOTICE}`,
              "queue.resume",
            ]);
            assert.strictEqual(
              busy.thread.providerThreads?.[0]?.nativeThreadRef?.nativeId,
              `claude-${busy.lead}`,
            );
            yield* governor.tick;
            assert.deepStrictEqual(yield* governor.paused, []);
            assert.isNull((yield* readTask(idle.task.id)).memoryHold ?? null);
            assert.include(yield* notesOf(idle.task.id), MemoryGovernor.RESUMED_NOTE);

            // Then the PM is told to start the waiting task, and it starts locally.
            yield* governor.tick;
            const toPm = yield* harness.messagesTo(pm);
            assert.isTrue(toPm.some((text) => text.includes(`#${waiting.number}`)));
            const started = yield* team.startTask(pm, { taskId: waiting.id }, harness.delegate);
            assert.strictEqual(started.task.stage, "planning");
            assert.strictEqual(started.task.location, "local");
            assert.isNull((yield* readTask(waiting.id)).memoryHold ?? null);

            // Nothing went to the cloud or was moved.
            assert.deepStrictEqual(fake.mac.cloudCalls, []);
            const delegated = yield* Ref.get(harness.delegated);
            assert.isTrue(delegated.every((input) => input.location === undefined));
            assert.isFalse(
              (yield* Ref.get(harness.dispatched)).some(
                (command) =>
                  command.type === "thread.metadata.update" && command.location === "cloud",
              ),
            );
          }),
        { memory: fake.read, sessions: fake.sessions, cloudLead: fake.cloudLead },
      );
    },
  );

  it.effect("pauses one session per pass while the reading has not changed", () => {
    // Releasing frees nothing the sampler sees yet, as with a cached reading.
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const governor = yield* MemoryGovernor.MemoryGovernor;
          const pm = yield* setUpManager;
          const first = yield* startWithSession(harness, fake.mac, pm, "First");
          yield* startWithSession(harness, fake.mac, pm, "Second");
          yield* startWithSession(harness, fake.mac, pm, "Third");
          fake.mac.memory = CRITICAL;
          yield* governor.tick;
          assert.deepStrictEqual(yield* governor.paused, [first.lead]);
          assert.strictEqual(fake.mac.released.length, 1);
          yield* governor.tick;
          assert.strictEqual((yield* governor.paused).length, 2);
        }),
      { memory: fake.read, sessions: fake.sessions },
    );
  });

  it.effect("pauses and resumes a lead together with its delegated children", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const governor = yield* MemoryGovernor.MemoryGovernor;
          const gate = yield* LeadMoveGate.LeadMoveGate;
          const pm = yield* setUpManager;
          const { lead } = yield* startWithSession(harness, fake.mac, pm, "Lead with a child");
          const child = ThreadId.make("child-of-lead");
          giveSession(harness, fake.mac, child, {
            launchedBy: lead,
            running: { startedMsAgo: 60_000 },
          });

          fake.mac.memory = CRITICAL;
          yield* governor.tick;
          assert.deepStrictEqual(yield* governor.paused, [lead]);
          assert.isTrue(gate.isHeldFor(lead, "memory"));
          assert.isTrue(gate.isHeldFor(child, "memory"));
          assert.isNull(harness.threads.get(child)?.activeRunId ?? null);
          assert.sameMembers(
            fake.mac.released.map((entry) => entry.id),
            [`session:${lead}`, `session:${child}`],
          );

          fake.mac.memory = PLENTY;
          yield* resumeTicks(governor);
          assert.deepStrictEqual(yield* governor.paused, []);
          assert.isFalse(gate.isHeld(lead));
          assert.isFalse(gate.isHeld(child));
          const types = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
            commands.map((command) =>
              command.type === "message.dispatch" ? `message ${command.text}` : command.type,
            );
          assert.deepStrictEqual(types(yield* commandsTo(harness, child)), [
            "run.interrupt",
            `message ${MemoryGovernor.RESUME_NOTICE}`,
            "queue.resume",
          ]);
          assert.strictEqual(types(yield* commandsTo(harness, lead)).at(-1), "queue.resume");
        }),
      { memory: fake.read, sessions: fake.sessions },
    );
  });

  it.effect("resumes a paused lead after a restart once there is room", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const governor = yield* MemoryGovernor.MemoryGovernor;
          const pm = yield* setUpManager;
          const { task, lead } = yield* startWithSession(harness, fake.mac, pm, "Paused lead", {
            running: { startedMsAgo: 60_000 },
          });
          fake.mac.memory = CRITICAL;
          yield* governor.tick;
          assert.deepStrictEqual(yield* governor.paused, [lead]);
          harness.threads.get(lead)!.shell = {
            ...harness.threads.get(lead)!.shell,
            status: "interrupted",
          };

          // The server restarts: a new governor and gate over the same storage.
          yield* Effect.gen(function* () {
            const restarted = yield* MemoryGovernor.MemoryGovernor;
            const gate = yield* LeadMoveGate.LeadMoveGate;
            const before = (yield* commandsTo(harness, lead)).length;
            yield* restarted.tick;
            assert.deepStrictEqual(yield* restarted.paused, [lead]);
            assert.isTrue(gate.isHeldFor(lead, "memory"));
            assert.strictEqual((yield* readTask(task.id)).memoryHold, "paused");

            fake.mac.memory = PLENTY;
            yield* resumeTicks(restarted);
            assert.deepStrictEqual(yield* restarted.paused, []);
            assert.isFalse(gate.isHeld(lead));
            const after = (yield* commandsTo(harness, lead)).slice(before);
            assert.deepStrictEqual(
              after.map((command) =>
                command.type === "message.dispatch" ? `message ${command.text}` : command.type,
              ),
              [`message ${MemoryGovernor.RESUME_NOTICE}`, "queue.resume"],
            );
            assert.isNull((yield* readTask(task.id)).memoryHold ?? null);
          }).pipe(
            Effect.provide(
              Layer.fresh(MemoryGovernor.layer).pipe(
                Layer.provideMerge(
                  Layer.sync(LeadMoveGate.LeadMoveGate, LeadMoveGate.makeLeadMoveGate),
                ),
              ),
            ),
          );
        }),
      { memory: fake.read, sessions: fake.sessions },
    );
  });

  it.effect("local first: starts new work in the cloud and moves a running lead there", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* ProjectTeamService.ProjectTeamService;
          const governor = yield* MemoryGovernor.MemoryGovernor;
          const pm = yield* setUpManager;
          const running = yield* startWithSession(harness, fake.mac, pm, "Running lead", {
            running: { startedMsAgo: 5 * 60_000 },
          });
          assert.strictEqual(running.task.location, "local");

          fake.mac.memory = TIGHT;
          const { task: created } = yield* createAcceptedTask(pm, {
            title: "New work",
            request: "New work.",
            intake: "New work.",
          });
          const started = yield* team.startTask(pm, { taskId: created.id }, harness.delegate);
          assert.strictEqual(started.task.location, "cloud");
          assert.strictEqual((yield* Ref.get(harness.delegated)).at(-1)?.location, "cloud");
          assert.include(yield* notesOf(created.id), STARTED_IN_CLOUD_NOTE);

          fake.mac.memory = CRITICAL;
          yield* governor.tick;
          const moved = yield* readTask(running.task.id);
          assert.strictEqual(moved.location, "cloud");
          assert.isTrue(fake.mac.cloudCalls.some((call) => call.startsWith("importTranscripts")));
          // Moved, not paused.
          assert.deepStrictEqual(yield* governor.paused, []);
          assert.include(yield* notesOf(running.task.id), MemoryGovernor.MOVING_NOTE);
        }),
      {
        memory: fake.read,
        sessions: fake.sessions,
        cloudLead: fake.cloudLead,
        settings: { taskExecution: { location: "local_first" } },
      },
    );
  });

  it.effect(
    "starts leads past the old cap of 6 with plenty of memory, up to the safety cap",
    () => {
      const fake = fakeMac(PLENTY);
      return withTeam(
        (harness) =>
          Effect.gen(function* () {
            const pm = yield* setUpManager;
            const team = yield* ProjectTeamService.ProjectTeamService;
            const start = (title: string) =>
              Effect.gen(function* () {
                const { task } = yield* createAcceptedTask(pm, {
                  title,
                  request: `${title}.`,
                  intake: "New work.",
                });
                return yield* team.startTask(pm, { taskId: task.id }, harness.delegate);
              });
            for (let index = 1; index <= 7; index += 1) {
              const started = yield* start(`Task ${index}`);
              assert.strictEqual(started.task.stage, "planning");
            }
            const eighth = yield* start("Task 8").pipe(Effect.flip);
            assert.include(eighth.message, "7 of 7 task leads are already running");
          }),
        { memory: fake.read, settings: { taskExecution: { maxConcurrentSessions: 7 } } },
      );
    },
  );

  it.effect("waits below the cap when memory is low", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const pm = yield* setUpManager;
          const team = yield* ProjectTeamService.ProjectTeamService;
          yield* startWithSession(harness, fake.mac, pm, "First");
          fake.mac.memory = TIGHT;
          const { task } = yield* createAcceptedTask(pm, {
            title: "Second",
            request: "Second.",
            intake: "New work.",
          });
          const refused = yield* team
            .startTask(pm, { taskId: task.id }, harness.delegate)
            .pipe(Effect.flip);
          assert.include(refused.message, MEMORY_WAIT_REASON);
          assert.strictEqual((yield* readTask(task.id)).memoryHold, "waiting");
          assert.strictEqual((yield* Ref.get(harness.delegated)).length, 1);
        }),
      { memory: fake.read },
    );
  });
  it.effect("when the cloud cannot start it, starts here with room, else waits for memory", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const pm = yield* setUpManager;
          const team = yield* ProjectTeamService.ProjectTeamService;
          const noCloud: DelegateTaskLead = (input) =>
            input.location === "cloud"
              ? Effect.fail(
                  new OrchestratorMcpFailure({ code: "invalid_request", message: "no sandbox" }),
                )
              : harness.delegate(input);
          const create = (title: string) =>
            createAcceptedTask(pm, { title, request: `${title}.`, intake: "New work." });

          // cloud_first with room: falls back to this Mac.
          const { task: first } = yield* create("First");
          const started = yield* team.startTask(pm, { taskId: first.id }, noCloud);
          assert.strictEqual(started.task.location, "local");
          assert.include(yield* notesOf(first.id), CLOUD_FALLBACK_NOTE);

          // Short on memory: waits instead of failing.
          fake.mac.memory = TIGHT;
          const { task: second } = yield* create("Second");
          const refused = yield* team
            .startTask(pm, { taskId: second.id }, noCloud)
            .pipe(Effect.flip);
          assert.include(refused.message, MEMORY_WAIT_REASON);
          const waiting = yield* readTask(second.id);
          assert.strictEqual(waiting.stage, "inbox");
          assert.strictEqual(waiting.memoryHold, "waiting");
        }),
      { memory: fake.read, settings: { taskExecution: { location: "cloud_first" } } },
    );
  });
});
