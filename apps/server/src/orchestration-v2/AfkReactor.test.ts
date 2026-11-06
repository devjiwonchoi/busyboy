import { assert, describe, it } from "@effect/vitest";
import {
  AFK_FREE_FORM_ANSWER,
  EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  PlanId,
  ProjectId,
  type ProjectTeamSettings,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { PLAN_IMPLEMENTATION_PROMPT_PREFIX } from "@t3tools/shared/proposedPlanText";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as AfkReactor from "./AfkReactor.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const START = "2026-11-04T00:00:00.000Z";
const PROJECT = ProjectId.make("project-afk");
const THREAD = ThreadId.make("thread-afk");
const REQUEST = RuntimeRequestId.make("request-1");
const PLAN = PlanId.make("plan-1");
const RUN = RunId.make("run-1");

interface World {
  afk: boolean;
  interactionMode: "default" | "plan";
  runtimeRequests: Array<OrchestrationV2RuntimeRequest>;
  turnItems: Array<OrchestrationV2TurnItem>;
  runs: Array<OrchestrationV2Run>;
  plans: Array<OrchestrationV2PlanArtifact>;
  commands: Array<OrchestrationV2ServerCommand>;
  events: Array<ProjectTeamRepository.AppendProjectTaskEventInput>;
}

const at = (iso: string) => DateTime.makeUnsafe(iso);

const question = (
  options: ReadonlyArray<string>,
  extra: Partial<OrchestrationV2UserInputQuestion> = {},
): OrchestrationV2UserInputQuestion =>
  ({
    id: "Which database?",
    header: "Database",
    question: "Which database?",
    options: options.map((label) => ({ label, description: label })),
    ...extra,
  }) as OrchestrationV2UserInputQuestion;

const pendingRequest = (): OrchestrationV2RuntimeRequest =>
  ({
    id: REQUEST,
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "live", providerSessionId: "session-1" },
    createdAt: at(START),
    resolvedAt: null,
  }) as unknown as OrchestrationV2RuntimeRequest;

const askEvent = (request: OrchestrationV2RuntimeRequest): OrchestrationV2DomainEvent =>
  ({
    id: EventId.make("event-ask"),
    threadId: THREAD,
    occurredAt: at(START),
    type: "runtime-request.updated",
    payload: request,
  }) as OrchestrationV2DomainEvent;

const runCompleted = (run: OrchestrationV2Run): OrchestrationV2DomainEvent =>
  ({
    id: EventId.make("event-run"),
    threadId: THREAD,
    occurredAt: at(START),
    type: "run.updated",
    payload: run,
  }) as OrchestrationV2DomainEvent;

function makeWorld(): World {
  return {
    afk: true,
    interactionMode: "default",
    runtimeRequests: [],
    turnItems: [],
    runs: [],
    plans: [],
    commands: [],
    events: [],
  };
}

const withReactor = <A, E>(
  world: World,
  body: (reactor: AfkReactor.AfkReactor["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(START));
    const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed({
          id: THREAD,
          projectId: PROJECT,
          archivedAt: null,
          deletedAt: null,
          lineage: { parentThreadId: null },
          hasActionableProposedPlan: world.plans.length > 0,
        } as never),
      listProjectThreads: () =>
        Effect.succeed([
          {
            id: THREAD,
            projectId: PROJECT,
            archivedAt: null,
            deletedAt: null,
            hasActionableProposedPlan: world.plans.length > 0,
          },
        ] as never),
      getThreadRecords: (() =>
        Effect.sync(() => ({
          thread: { id: THREAD, interactionMode: world.interactionMode, archivedAt: null },
          runtimeRequests: world.runtimeRequests,
          turnItems: world.turnItems,
          runs: world.runs,
          plans: world.plans,
        }))) as never,
      dispatch: (command) =>
        Effect.sync(() => {
          world.commands.push(command);
          if (command.type === "runtime-request.respond") {
            world.runtimeRequests = world.runtimeRequests.map((request) =>
              request.id === command.requestId ? { ...request, status: "resolved" } : request,
            );
          }
          return { sequence: 1, storedEvents: [] } as never;
        }),
    });
    const settings = (): ProjectTeamSettings =>
      (world.afk ? { afk: { since: START, until: null } } : {}) as ProjectTeamSettings;
    const repository = Layer.mock(ProjectTeamRepository.ProjectTeamRepository)({
      getManager: () => Effect.sync(() => Option.some({ settings: settings() } as never)),
      findTaskByLeadThreadId: () => Effect.succeedNone,
      appendTaskEvent: (input) =>
        Effect.sync(() => {
          world.events.push(input);
          return input as never;
        }),
    });
    const layer = AfkReactor.layer.pipe(Layer.provide(Layer.mergeAll(threads, repository)));
    return yield* Effect.gen(function* () {
      return yield* body(yield* AfkReactor.AfkReactor);
    }).pipe(Effect.provide(layer));
  });

const askWith = (world: World, questions: ReadonlyArray<OrchestrationV2UserInputQuestion>) => {
  const request = pendingRequest();
  world.runtimeRequests = [request];
  world.turnItems = [
    {
      type: "user_input_request",
      requestId: REQUEST,
      questions,
    } as unknown as OrchestrationV2TurnItem,
  ];
  return request;
};

const responses = (world: World) =>
  world.commands.filter((command) => command.type === "runtime-request.respond");

describe("AfkReactor", () => {
  it.effect("answers a pending question with the recommended option after the grace period", () => {
    const world = makeWorld();
    return withReactor(world, (reactor) =>
      Effect.gen(function* () {
        const request = askWith(world, [question(["SQLite", "Postgres (Recommended)"])]);
        yield* reactor.handle(askEvent(request));
        yield* TestClock.adjust("59 seconds");
        assert.lengthOf(responses(world), 0);
        yield* TestClock.adjust("1 second");
        assert.deepStrictEqual(responses(world), [
          {
            type: "runtime-request.respond",
            commandId: `server:afk-answer:${THREAD}:${REQUEST}`,
            threadId: THREAD,
            requestId: REQUEST,
            answers: { "Which database?": "Postgres (Recommended)" },
          } as never,
        ]);
        assert.deepStrictEqual(
          world.events.map((event) => [event.kind, event.body, event.actorThreadId, event.taskId]),
          [["afk_answer", "Which database? → Postgres (Recommended)", THREAD, null]],
        );
      }),
    );
  });

  it.effect("leaves a question the user answered within the grace period", () => {
    const world = makeWorld();
    return withReactor(world, (reactor) =>
      Effect.gen(function* () {
        const request = askWith(world, [question(["A (Recommended)", "B"])]);
        yield* reactor.handle(askEvent(request));
        yield* TestClock.adjust("30 seconds");
        world.runtimeRequests = [{ ...request, status: "resolved" }];
        yield* TestClock.adjust("1 minute");
        assert.lengthOf(responses(world), 0);
        assert.lengthOf(world.events, 0);
      }),
    );
  });

  it.effect("does nothing while AFK is off", () => {
    const world = makeWorld();
    world.afk = false;
    return withReactor(world, (reactor) =>
      Effect.gen(function* () {
        const request = askWith(world, [question(["A (Recommended)"])]);
        yield* reactor.handle(askEvent(request));
        yield* reactor.sweepProject(PROJECT);
        yield* TestClock.adjust("2 minutes");
        assert.lengthOf(responses(world), 0);
      }),
    );
  });

  it.effect("answers a question without options with the free-form AFK answer", () => {
    const world = makeWorld();
    return withReactor(world, (reactor) =>
      Effect.gen(function* () {
        const request = askWith(world, [question([])]);
        yield* reactor.handle(askEvent(request));
        yield* TestClock.adjust("1 minute");
        const [response] = responses(world);
        assert.deepStrictEqual(
          response?.type === "runtime-request.respond" ? response.answers : undefined,
          { "Which database?": AFK_FREE_FORM_ANSWER },
        );
      }),
    );
  });

  it.effect("sends the option value as a list for a multi-select question", () => {
    const world = makeWorld();
    return withReactor(world, (reactor) =>
      Effect.gen(function* () {
        const request = askWith(world, [
          {
            ...question(["Lint", "Tests (Recommended)"], { multiSelect: true }),
            options: [
              { label: "Lint", description: "Lint" },
              { label: "Tests (Recommended)", description: "Tests", value: "tests" },
            ],
          },
        ]);
        yield* reactor.handle(askEvent(request));
        yield* TestClock.adjust("1 minute");
        const [response] = responses(world);
        assert.deepStrictEqual(
          response?.type === "runtime-request.respond" ? response.answers : undefined,
          { "Which database?": ["tests"] },
        );
      }),
    );
  });

  it.effect("answers a question that was already waiting when AFK turned on", () => {
    const world = makeWorld();
    world.afk = false;
    return withReactor(world, (reactor) =>
      Effect.gen(function* () {
        const request = askWith(world, [question(["A (Recommended)"])]);
        yield* reactor.handle(askEvent(request));
        // Asked two minutes ago, so its grace period is already over.
        yield* TestClock.adjust("2 minutes");
        world.afk = true;
        yield* reactor.sweepProject(PROJECT);
        yield* TestClock.adjust("0 seconds");
        assert.lengthOf(responses(world), 1);
      }),
    );
  });

  it.effect("implements a proposed plan of a plan-mode thread after the grace period", () => {
    const world = makeWorld();
    world.interactionMode = "plan";
    const run = {
      id: RUN,
      ordinal: 1,
      status: "completed",
      completedAt: at(START),
    } as unknown as OrchestrationV2Run;
    world.runs = [run];
    world.plans = [
      {
        id: PLAN,
        threadId: THREAD,
        runId: RUN,
        kind: "proposed_plan",
        status: "active",
        markdown: "# Add caching\n\n- Step one\n",
      } as unknown as OrchestrationV2PlanArtifact,
    ];
    return withReactor(world, (reactor) =>
      Effect.gen(function* () {
        yield* reactor.handle(runCompleted(run));
        yield* TestClock.adjust("59 seconds");
        assert.lengthOf(world.commands, 0);
        yield* TestClock.adjust("1 second");
        const [mode, message] = world.commands;
        assert.deepStrictEqual(mode, {
          type: "thread.interaction-mode.set",
          commandId: `server:afk-plan-mode:${THREAD}:${PLAN}`,
          threadId: THREAD,
          interactionMode: "default",
        } as never);
        assert.strictEqual(message?.type, "message.dispatch");
        if (message?.type !== "message.dispatch") return;
        assert.strictEqual(
          message.text,
          `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}# Add caching\n\n- Step one`,
        );
        assert.deepStrictEqual(message.sourcePlanRef, { threadId: THREAD, planId: PLAN });
        assert.strictEqual(message.creationSource, "server");
        assert.deepStrictEqual(
          world.events.map((event) => event.body),
          ["Add caching → Implement"],
        );
      }),
    );
  });

  it.effect("leaves a plan alone when the user sent a newer message", () => {
    const world = makeWorld();
    world.interactionMode = "plan";
    const run = {
      id: RUN,
      ordinal: 1,
      status: "completed",
      completedAt: at(START),
    } as unknown as OrchestrationV2Run;
    world.runs = [run];
    world.plans = [
      {
        id: PLAN,
        runId: RUN,
        kind: "proposed_plan",
        status: "active",
        markdown: "# Plan",
      } as unknown as OrchestrationV2PlanArtifact,
    ];
    return withReactor(world, (reactor) =>
      Effect.gen(function* () {
        yield* reactor.handle(runCompleted(run));
        yield* TestClock.adjust("10 seconds");
        world.runs = [
          run,
          {
            id: RunId.make("run-2"),
            ordinal: 2,
            status: "running",
          } as unknown as OrchestrationV2Run,
        ];
        yield* TestClock.adjust("1 minute");
        assert.lengthOf(world.commands, 0);
      }),
    );
  });
});
