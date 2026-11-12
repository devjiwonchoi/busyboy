/**
 * Task leads start by the Mac's free memory instead of a fixed count, and the
 * memory governor pauses and resumes them when memory runs short. Under the
 * user's local-only setting nothing goes to the cloud: work waits instead.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  type ExecutionLocation,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProviderInstanceId,
  RunId,
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
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import * as CloudLeadService from "../cloudLead/CloudLeadService.ts";
import * as LeadMoveGate from "../cloudLead/LeadMoveGate.ts";
import type * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import { type MemorySnapshot, START_SPACING_MS } from "../resourceTelemetry/MemoryHeadroom.ts";
import * as MemoryGovernor from "./MemoryGovernor.ts";
import * as StalledTaskSweep from "./StalledTaskSweep.ts";
import { STALL_NOTIFY_AFTER_MS } from "./stallLedger.ts";
import * as TaskOutcomeReactor from "./taskOutcomeReactor.ts";
import { CLOUD_FALLBACK_NOTE, MEMORY_WAIT_REASON, STARTED_IN_CLOUD_NOTE } from "./memoryPolicy.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import type { DelegateTaskLead } from "./ProjectTeamService.ts";
import {
  createAcceptedTask,
  setUpManager,
  setUpWorkspace,
  START,
  startLead,
  type TeamHarness,
  withTeam,
} from "./testkit.ts";

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
    // The next local start waits this long for this one's memory to show.
    yield* TestClock.adjust(START_SPACING_MS);
    return { task, lead, thread };
  });

/** Two ok samples in a row: the first resume after a shortage is due. */
const resumeTicks = (governor: MemoryGovernor.MemoryGovernor["Service"]) =>
  Effect.gen(function* () {
    yield* governor.tick;
    yield* governor.tick;
  });

/** A pass once the cooldown after the last resume or start has passed. */
const tickAfterCooldown = (governor: MemoryGovernor.MemoryGovernor["Service"]) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(MemoryGovernor.RESUME_COOLDOWN_MS);
    yield* governor.tick;
  });

/** The domain event for a lead turn the governor stopped. */
const interruptedRun = (lead: ThreadId): OrchestrationV2DomainEvent => {
  const at = DateTime.makeUnsafe(START);
  return {
    id: EventId.make(`event-${lead}-interrupted`),
    threadId: lead,
    occurredAt: at,
    type: "run.updated",
    payload: {
      id: RunId.make(`run:${lead}`),
      threadId: lead,
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("claude"),
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" },
      providerThreadId: null,
      userMessageId: MessageId.make(`message-${lead}`),
      rootNodeId: null,
      activeAttemptId: null,
      status: "interrupted",
      requestedAt: at,
      startedAt: at,
      completedAt: at,
      checkpointId: null,
      contextHandoffId: null,
    },
  } as OrchestrationV2DomainEvent;
};

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

            // Memory comes back: after two ok samples the last paused lead resumes
            // first, on its own session.
            fake.mac.memory = PLENTY;
            yield* governor.tick;
            assert.deepStrictEqual(yield* governor.paused, [idle.lead, busy.lead]);
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
            yield* tickAfterCooldown(governor);
            assert.deepStrictEqual(yield* governor.paused, []);
            assert.isNull((yield* readTask(idle.task.id)).memoryHold ?? null);
            assert.include(yield* notesOf(idle.task.id), MemoryGovernor.RESUMED_NOTE);

            // Then the PM is told to start the waiting task, and it starts locally.
            yield* tickAfterCooldown(governor);
            const toPm = yield* harness.messagesTo(pm);
            assert.isTrue(toPm.some((text) => text.includes(`#${waiting.number}`)));
            const started = yield* team.startTask(pm, { taskId: waiting.id }, harness.delegate);
            assert.strictEqual(started.task.stage, "planning");
            assert.strictEqual(started.task.location, "local");
            assert.isNull((yield* readTask(waiting.id)).memoryHold ?? null);

            // Nothing went to the cloud or was moved.
            assert.deepStrictEqual(fake.mac.cloudCalls, []);
            const delegated = yield* Ref.get(harness.delegated);
            assert.isTrue(delegated.every((input) => input.location === "local"));
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

  it.effect("resumes only after two ok samples, and one lead per cooldown", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const governor = yield* MemoryGovernor.MemoryGovernor;
          const pm = yield* setUpManager;
          const first = yield* startWithSession(harness, fake.mac, pm, "First");
          const second = yield* startWithSession(harness, fake.mac, pm, "Second");
          fake.mac.memory = CRITICAL;
          yield* governor.tick;
          yield* governor.tick;
          assert.deepStrictEqual(yield* governor.paused, [first.lead, second.lead]);

          fake.mac.memory = PLENTY;
          yield* governor.tick;
          assert.strictEqual((yield* governor.paused).length, 2);
          // A dip resets the count.
          fake.mac.memory = TIGHT;
          yield* governor.tick;
          fake.mac.memory = PLENTY;
          yield* governor.tick;
          assert.strictEqual((yield* governor.paused).length, 2);
          yield* governor.tick;
          assert.deepStrictEqual(yield* governor.paused, [first.lead]);
          // Within the cooldown nothing more resumes.
          yield* TestClock.adjust(MemoryGovernor.RESUME_COOLDOWN_MS - 1_000);
          yield* governor.tick;
          assert.deepStrictEqual(yield* governor.paused, [first.lead]);
          yield* tickAfterCooldown(governor);
          assert.deepStrictEqual(yield* governor.paused, []);
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

  it.effect("a lead paused for memory is not stalled and does not wake the PM", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const governor = yield* MemoryGovernor.MemoryGovernor;
          const reactor = yield* TaskOutcomeReactor.TaskOutcomeReactor;
          const sweep = yield* StalledTaskSweep.StalledTaskSweep;
          const pm = yield* setUpManager;
          const { task, lead } = yield* startWithSession(harness, fake.mac, pm, "Busy lead", {
            running: { startedMsAgo: 60_000 },
          });
          fake.mac.memory = CRITICAL;
          yield* governor.tick;
          assert.deepStrictEqual(yield* governor.paused, [lead]);
          const toPmBefore = (yield* harness.messagesTo(pm)).length;

          yield* reactor.handle(interruptedRun(lead));
          yield* TestClock.adjust(STALL_NOTIFY_AFTER_MS * 2);
          yield* sweep.sweep;

          const paused = yield* readTask(task.id);
          assert.notStrictEqual(paused.lastOutcome, "stalled");
          assert.strictEqual(paused.memoryHold, "paused");
          assert.strictEqual((yield* harness.messagesTo(pm)).length, toPmBefore);
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
              yield* TestClock.adjust(START_SPACING_MS);
            }
            const eighth = yield* start("Task 8").pipe(Effect.flip);
            assert.include(eighth.message, "7 of 7 task leads are already running");
          }),
        { memory: fake.read, settings: { taskExecution: { maxConcurrentSessions: 7 } } },
      );
    },
  );

  it.effect("counts the safety cap across every project", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const { firstPm, secondPm } = yield* setUpWorkspace(harness);
          const started = yield* startLead(firstPm, "First project", harness.delegate);
          assert.strictEqual(started.task.stage, "planning");
          yield* TestClock.adjust(START_SPACING_MS);
          yield* startLead(secondPm, "Second project", harness.delegate);
          yield* TestClock.adjust(START_SPACING_MS);
          const refused = yield* startLead(firstPm, "One too many", harness.delegate).pipe(
            Effect.flip,
          );
          assert.include(refused.message, "2 of 2 task leads are already running");
        }),
      { memory: fake.read, settings: { taskExecution: { maxConcurrentSessions: 2 } } },
    );
  });

  it.effect("two projects starting at once never pass the app-wide cap together", () =>
    withTeam(
      (harness) =>
        Effect.gen(function* () {
          const { firstPm, secondPm } = yield* setUpWorkspace(harness);
          // A slow start: without one lock across projects, both would pass the cap check.
          const slow: DelegateTaskLead = (input) =>
            Effect.sleep("1 second").pipe(Effect.andThen(harness.delegate(input)));
          const first = yield* startLead(firstPm, "First project", slow).pipe(
            Effect.result,
            Effect.forkChild,
          );
          const second = yield* startLead(secondPm, "Second project", slow).pipe(
            Effect.result,
            Effect.forkChild,
          );
          yield* TestClock.adjust("1 second");
          yield* TestClock.adjust("1 second");
          const results = [yield* Fiber.join(first), yield* Fiber.join(second)];
          assert.strictEqual(results.filter(Result.isSuccess).length, 1);
          const refused = results.find(Result.isFailure);
          assert.include(
            refused === undefined ? "" : refused.failure.message,
            "1 of 1 task leads are already running",
          );
          assert.strictEqual((yield* Ref.get(harness.delegated)).length, 1);
        }),
      { settings: { taskExecution: { maxConcurrentSessions: 1 } } },
    ),
  );

  it.effect("spaces out local starts so each one's memory shows before the next", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const pm = yield* setUpManager;
          const team = yield* ProjectTeamService.ProjectTeamService;
          const governor = yield* MemoryGovernor.MemoryGovernor;
          const create = (title: string) =>
            createAcceptedTask(pm, { title, request: `${title}.`, intake: "New work." });
          const { task: first } = yield* create("First");
          const { task: second } = yield* create("Second");

          // Plenty of memory, but the first start's memory has not shown yet.
          yield* team.startTask(pm, { taskId: first.id }, harness.delegate);
          const refused = yield* team
            .startTask(pm, { taskId: second.id }, harness.delegate)
            .pipe(Effect.flip);
          assert.include(refused.message, "another session started on this Mac moments ago");
          const waiting = yield* readTask(second.id);
          assert.strictEqual(waiting.stage, "inbox");
          assert.strictEqual(waiting.memoryHold, "waiting");
          assert.strictEqual((yield* Ref.get(harness.delegated)).length, 1);

          // Once the spacing has passed, the governor has the PM start it, and it starts.
          yield* TestClock.adjust(START_SPACING_MS);
          yield* resumeTicks(governor);
          assert.isTrue(
            (yield* harness.messagesTo(pm)).some((text) => text.includes(`#${second.number}`)),
          );
          const started = yield* team.startTask(pm, { taskId: second.id }, harness.delegate);
          assert.strictEqual(started.task.stage, "planning");
          assert.strictEqual(started.task.location, "local");
          assert.isNull((yield* readTask(second.id)).memoryHold ?? null);
        }),
      { memory: fake.read },
    );
  });

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
          yield* TestClock.adjust(START_SPACING_MS);

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

describe("memory stall time", () => {
  const MINUTE = 60_000;
  const LOCAL_ONLY = { taskExecution: { location: "local_only" as const } };
  const stallOf = (id: Parameters<typeof readTask>[0]) =>
    readTask(id).pipe(Effect.map((task) => task.metrics.memoryStallMs));

  it.effect("local only: counts the time a lead was stopped mid-turn for memory", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const governor = yield* MemoryGovernor.MemoryGovernor;
          const pm = yield* setUpManager;
          const { task, lead } = yield* startWithSession(harness, fake.mac, pm, "Paused lead", {
            running: { startedMsAgo: MINUTE },
          });
          fake.mac.memory = CRITICAL;
          yield* governor.tick;
          assert.deepStrictEqual(yield* governor.paused, [lead]);
          yield* TestClock.adjust(12 * MINUTE);
          // Still paused: nothing counted until it resumes.
          assert.strictEqual(yield* stallOf(task.id), 0);

          fake.mac.memory = PLENTY;
          yield* resumeTicks(governor);
          assert.deepStrictEqual(yield* governor.paused, []);
          assert.strictEqual(yield* stallOf(task.id), 12 * MINUTE);
        }),
      { memory: fake.read, sessions: fake.sessions, settings: LOCAL_ONLY },
    );
  });

  it.effect("local only: counts the time a task waited for memory to start", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* ProjectTeamService.ProjectTeamService;
          const pm = yield* setUpManager;
          yield* startWithSession(harness, fake.mac, pm, "First");
          fake.mac.memory = TIGHT;
          const { task } = yield* createAcceptedTask(pm, {
            title: "Second",
            request: "Second.",
            intake: "New work.",
          });
          yield* team.startTask(pm, { taskId: task.id }, harness.delegate).pipe(Effect.flip);
          assert.strictEqual((yield* readTask(task.id)).memoryHold, "waiting");
          yield* TestClock.adjust(5 * MINUTE);

          fake.mac.memory = PLENTY;
          const started = yield* team.startTask(pm, { taskId: task.id }, harness.delegate);
          assert.strictEqual(started.task.stage, "planning");
          assert.strictEqual(yield* stallOf(task.id), 5 * MINUTE);
        }),
      { memory: fake.read, settings: LOCAL_ONLY },
    );
  });

  it.effect("local first: a lead moved to the cloud is not counted as stalled", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const governor = yield* MemoryGovernor.MemoryGovernor;
          const pm = yield* setUpManager;
          const running = yield* startWithSession(harness, fake.mac, pm, "Running lead", {
            running: { startedMsAgo: 5 * MINUTE },
          });
          fake.mac.memory = CRITICAL;
          yield* governor.tick;
          assert.strictEqual((yield* readTask(running.task.id)).location, "cloud");
          yield* TestClock.adjust(10 * MINUTE);
          fake.mac.memory = PLENTY;
          yield* resumeTicks(governor);
          assert.strictEqual(yield* stallOf(running.task.id), 0);
        }),
      {
        memory: fake.read,
        sessions: fake.sessions,
        cloudLead: fake.cloudLead,
        settings: { taskExecution: { location: "local_first" } },
      },
    );
  });

  it.effect("keeps counting a pause across a restart from when it began", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const governor = yield* MemoryGovernor.MemoryGovernor;
          const pm = yield* setUpManager;
          const { task, lead } = yield* startWithSession(harness, fake.mac, pm, "Paused lead", {
            running: { startedMsAgo: MINUTE },
          });
          fake.mac.memory = CRITICAL;
          yield* governor.tick;
          assert.deepStrictEqual(yield* governor.paused, [lead]);
          yield* TestClock.adjust(3 * MINUTE);

          // The server restarts: a new governor and gate over the same storage.
          yield* Effect.gen(function* () {
            const restarted = yield* MemoryGovernor.MemoryGovernor;
            yield* restarted.tick;
            assert.deepStrictEqual(yield* restarted.paused, [lead]);
            yield* TestClock.adjust(4 * MINUTE);
            fake.mac.memory = PLENTY;
            yield* resumeTicks(restarted);
            assert.deepStrictEqual(yield* restarted.paused, []);
          }).pipe(
            Effect.provide(
              Layer.fresh(MemoryGovernor.layer).pipe(
                Layer.provideMerge(
                  Layer.sync(LeadMoveGate.LeadMoveGate, LeadMoveGate.makeLeadMoveGate),
                ),
              ),
            ),
          );
          assert.strictEqual(yield* stallOf(task.id), 7 * MINUTE);
        }),
      { memory: fake.read, sessions: fake.sessions, settings: LOCAL_ONLY },
    );
  });

  it.effect("an idle lead waiting on the user is not stalled while paused", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const governor = yield* MemoryGovernor.MemoryGovernor;
          const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
          const pm = yield* setUpManager;
          const { task, lead } = yield* startWithSession(harness, fake.mac, pm, "In review");
          yield* repository.updateTask({ id: task.id, stage: "in_review", now: START });
          fake.mac.memory = CRITICAL;
          yield* governor.tick;
          assert.deepStrictEqual(yield* governor.paused, [lead]);
          yield* TestClock.adjust(30 * MINUTE);

          fake.mac.memory = PLENTY;
          yield* resumeTicks(governor);
          assert.deepStrictEqual(yield* governor.paused, []);
          assert.strictEqual(yield* stallOf(task.id), 0);
        }),
      { memory: fake.read, sessions: fake.sessions, settings: LOCAL_ONLY },
    );
  });

  it.effect("an idle paused lead stalls from when a message waits in its held queue", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const governor = yield* MemoryGovernor.MemoryGovernor;
          const pm = yield* setUpManager;
          const { task, lead, thread } = yield* startWithSession(harness, fake.mac, pm, "Idle");
          fake.mac.memory = CRITICAL;
          yield* governor.tick;
          assert.deepStrictEqual(yield* governor.paused, [lead]);
          yield* TestClock.adjust(10 * MINUTE);
          // A message arrives and waits, held, behind the pause.
          thread.runs = [{ status: "queued", queueHeld: true, requestedAt: yield* DateTime.now }];
          yield* TestClock.adjust(20 * MINUTE);

          fake.mac.memory = PLENTY;
          yield* resumeTicks(governor);
          assert.deepStrictEqual(yield* governor.paused, []);
          assert.strictEqual(yield* stallOf(task.id), 20 * MINUTE);
        }),
      { memory: fake.read, sessions: fake.sessions, settings: LOCAL_ONLY },
    );
  });

  it.effect("a start spaced out with plenty of memory is not stalled", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* ProjectTeamService.ProjectTeamService;
          const governor = yield* MemoryGovernor.MemoryGovernor;
          const pm = yield* setUpManager;
          const create = (title: string) =>
            createAcceptedTask(pm, { title, request: `${title}.`, intake: "New work." });
          const { task: first } = yield* create("First");
          const { task: second } = yield* create("Second");
          yield* team.startTask(pm, { taskId: first.id }, harness.delegate);
          yield* team.startTask(pm, { taskId: second.id }, harness.delegate).pipe(Effect.flip);
          assert.strictEqual((yield* readTask(second.id)).memoryHold, "waiting");

          yield* TestClock.adjust(START_SPACING_MS);
          yield* resumeTicks(governor);
          yield* TestClock.adjust(2 * MINUTE);
          yield* team.startTask(pm, { taskId: second.id }, harness.delegate);
          assert.strictEqual(yield* stallOf(second.id), 0);
        }),
      { memory: fake.read, settings: LOCAL_ONLY },
    );
  });

  it.effect("stops a waiting task's clock once memory recovers", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* ProjectTeamService.ProjectTeamService;
          const governor = yield* MemoryGovernor.MemoryGovernor;
          const pm = yield* setUpManager;
          yield* startWithSession(harness, fake.mac, pm, "First");
          fake.mac.memory = TIGHT;
          const { task } = yield* createAcceptedTask(pm, {
            title: "Second",
            request: "Second.",
            intake: "New work.",
          });
          yield* team.startTask(pm, { taskId: task.id }, harness.delegate).pipe(Effect.flip);
          yield* TestClock.adjust(5 * MINUTE);

          // Memory is back, but the task still waits (here, for the PM to start it).
          fake.mac.memory = PLENTY;
          yield* governor.tick;
          assert.strictEqual((yield* readTask(task.id)).memoryHold, "waiting");
          yield* TestClock.adjust(10 * MINUTE);
          // Short again: the clock runs again.
          fake.mac.memory = TIGHT;
          yield* governor.tick;
          yield* TestClock.adjust(MINUTE);
          fake.mac.memory = PLENTY;
          yield* governor.tick;
          yield* TestClock.adjust(10 * MINUTE);

          yield* team.startTask(pm, { taskId: task.id }, harness.delegate);
          assert.strictEqual(yield* stallOf(task.id), 6 * MINUTE);
        }),
      { memory: fake.read, sessions: fake.sessions, settings: LOCAL_ONLY },
    );
  });

  it.effect("a paused lead whose task is cancelled is let go, and reopening runs its held messages", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* ProjectTeamService.ProjectTeamService;
          const governor = yield* MemoryGovernor.MemoryGovernor;
          const pm = yield* setUpManager;
          const { task, lead, thread } = yield* startWithSession(
            harness,
            fake.mac,
            pm,
            "Paused lead",
            { running: { startedMsAgo: MINUTE } },
          );
          const resumes = () =>
            commandsTo(harness, lead).pipe(
              Effect.map(
                (commands) => commands.filter((command) => command.type === "queue.resume").length,
              ),
            );
          fake.mac.memory = CRITICAL;
          yield* governor.tick;
          assert.deepStrictEqual(yield* governor.paused, [lead]);
          // A message arrives while the lead is paused and waits in its held queue.
          thread.runs = [{ status: "queued", queueHeld: true, requestedAt: yield* DateTime.now }];

          // Cancelled: the governor lets it go without running the held message.
          yield* team.updateTask(pm, { taskId: task.id, stage: "cancelled" });
          yield* governor.tick;
          assert.deepStrictEqual(yield* governor.paused, []);
          assert.strictEqual(yield* resumes(), 0);
          const stall = yield* stallOf(task.id);

          // Memory recovers before anyone reopens it: still nothing runs or counts.
          fake.mac.memory = PLENTY;
          yield* resumeTicks(governor);
          assert.strictEqual(yield* resumes(), 0);
          assert.strictEqual(yield* stallOf(task.id), stall);

          // Reopened: the lead comes back and its held message runs, once.
          yield* team.updateTask(pm, { taskId: task.id, stage: "running" });
          assert.strictEqual(yield* resumes(), 1);
          assert.isNull((yield* readTask(task.id)).memoryHold ?? null);
        }),
      { memory: fake.read, sessions: fake.sessions, settings: LOCAL_ONLY },
    );
  });

  it.effect("reopening a task keeps a queue the user stopped held", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* ProjectTeamService.ProjectTeamService;
          const pm = yield* setUpManager;
          const { task, lead, thread } = yield* startWithSession(harness, fake.mac, pm, "Lead");
          // Held by the user, not for memory.
          thread.runs = [{ status: "queued", queueHeld: true, requestedAt: yield* DateTime.now }];
          yield* team.updateTask(pm, { taskId: task.id, stage: "cancelled" });
          yield* team.updateTask(pm, { taskId: task.id, stage: "running" });
          assert.notInclude(
            (yield* commandsTo(harness, lead)).map((command) => command.type),
            "queue.resume",
          );
        }),
      { memory: fake.read, sessions: fake.sessions, settings: LOCAL_ONLY },
    );
  });

  it.effect("a task cancelled while it waits for memory stops stalling", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* ProjectTeamService.ProjectTeamService;
          const governor = yield* MemoryGovernor.MemoryGovernor;
          const pm = yield* setUpManager;
          yield* startWithSession(harness, fake.mac, pm, "First");
          fake.mac.memory = TIGHT;
          const { task } = yield* createAcceptedTask(pm, {
            title: "Second",
            request: "Second.",
            intake: "New work.",
          });
          yield* team.startTask(pm, { taskId: task.id }, harness.delegate).pipe(Effect.flip);
          yield* TestClock.adjust(5 * MINUTE);

          yield* team.updateTask(pm, { taskId: task.id, stage: "cancelled" });
          const cancelled = yield* readTask(task.id);
          assert.isNull(cancelled.memoryHold ?? null);
          assert.strictEqual(cancelled.metrics.memoryStallMs, 5 * MINUTE);

          // Memory stays short, then recovers: the cancelled task adds nothing.
          yield* governor.tick;
          yield* TestClock.adjust(30 * MINUTE);
          fake.mac.memory = PLENTY;
          yield* resumeTicks(governor);
          assert.strictEqual(yield* stallOf(task.id), 5 * MINUTE);
        }),
      { memory: fake.read, sessions: fake.sessions, settings: LOCAL_ONLY },
    );
  });

  it.effect("moving a paused lead ends its hold and its stall", () => {
    const fake = fakeMac(PLENTY);
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* ProjectTeamService.ProjectTeamService;
          const governor = yield* MemoryGovernor.MemoryGovernor;
          const gate = yield* LeadMoveGate.LeadMoveGate;
          const pm = yield* setUpManager;
          const { task, lead } = yield* startWithSession(harness, fake.mac, pm, "Paused lead", {
            running: { startedMsAgo: MINUTE },
          });
          fake.mac.memory = CRITICAL;
          yield* governor.tick;
          assert.deepStrictEqual(yield* governor.paused, [lead]);
          yield* TestClock.adjust(6 * MINUTE);

          yield* team.moveTask({ projectId: task.projectId, taskId: task.id, to: "cloud" });
          const moved = yield* readTask(task.id);
          assert.strictEqual(moved.location, "cloud");
          assert.isNull(moved.memoryHold ?? null);
          yield* TestClock.adjust(20 * MINUTE);
          // The next pass lets its held messages run in the cloud.
          yield* governor.tick;
          assert.deepStrictEqual(yield* governor.paused, []);
          assert.isFalse(gate.isHeld(lead));
          assert.strictEqual(yield* stallOf(task.id), 6 * MINUTE);
        }),
      {
        memory: fake.read,
        sessions: fake.sessions,
        cloudLead: fake.cloudLead,
        settings: LOCAL_ONLY,
      },
    );
  });
});
