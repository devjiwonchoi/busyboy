import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as BrowserRequests from "../browserRequests/BrowserRequests.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { requestBrowserAction } from "./BrowserRequestCards.ts";
import { McpInvocationContext, type McpThreadInvocationScope } from "./McpInvocationContext.ts";
import * as PreviewHandlers from "./toolkits/preview/handlers.ts";
import * as ServerSettings from "../serverSettings.ts";

const threadId = ThreadId.make("thread-1");
const providerInstanceId = ProviderInstanceId.make("codex");

const scope: McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("env-1"),
  capabilities: new Set(["preview", "orchestration"]),
  issuedAt: 0,
  requestNamespace: "ns",
  thread: { threadId, providerSessionId: "session-1", providerInstanceId },
  client: undefined,
};

/** An in-memory thread that keeps browser_request cards as the orchestrator would. */
function harness(options: { runStatus?: string } = {}) {
  const cards = new Map<string, Record<string, unknown>>();
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  let runStatus = options.runStatus ?? "running";
  const threadManagement = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadRecords: () =>
      Effect.sync(
        () =>
          ({
            thread: { id: threadId },
            runs: [
              {
                id: "run-1",
                status: runStatus,
                ordinal: 1,
                rootNodeId: "node-root",
                providerInstanceId,
              },
            ],
            turnItems: [...cards.values()],
          }) as never,
      ),
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        if (command.type !== "browser_request.record") return {} as never;
        const existing = cards.get(command.turnItemId);
        // Answered cards keep their outcome, as the orchestrator does.
        if (existing !== undefined && existing.browserStatus !== "pending") return {} as never;
        const { type: _type, commandId: _commandId, ...fields } = command;
        cards.set(command.turnItemId, {
          ...fields,
          id: command.turnItemId,
          type: "browser_request",
        });
        return {} as never;
      }),
  });
  const layer = Layer.mergeAll(
    threadManagement,
    BrowserRequests.layer.pipe(Layer.provide(threadManagement)),
    Layer.succeed(McpInvocationContext, scope),
  );
  return {
    layer,
    cards,
    dispatched,
    stopRun: () => {
      runStatus = "completed";
    },
    pendingCard: () => [...cards.values()].find((card) => card.browserStatus === "pending"),
  };
}

const waitForCard = (h: ReturnType<typeof harness>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 50 && h.pendingCard() === undefined; i += 1) yield* Effect.yieldNow;
    const card = h.pendingCard();
    assert.isDefined(card);
    return card!;
  });

describe("browser request cards", () => {
  it.effect("a sign-in card returns only the outcome the desktop app reports", () => {
    const h = harness();
    return Effect.gen(function* () {
      const fiber = yield* requestBrowserAction(scope, {
        kind: "sign_in",
        origin: "http://127.0.0.1:4000",
        tabId: "tab-1",
        reason: "Check the dashboard",
      }).pipe(Effect.forkChild);
      const card = yield* waitForCard(h);
      assert.strictEqual(card.requestKind, "sign_in");
      assert.strictEqual(card.origin, "http://127.0.0.1:4000");
      const requests = yield* BrowserRequests.BrowserRequests;
      yield* requests.answer({
        threadId,
        turnItemId: card.id as never,
        answer: { type: "sign_in", outcome: "submitted" },
      });
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(fiber);
      assert.deepStrictEqual(result, { status: "submitted" });
      // The card and the commands carry no login; only the outcome.
      assert.notInclude(JSON.stringify(h.dispatched), "password");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("shared history reaches the waiting call once, and a denial shares nothing", () => {
    const h = harness();
    return Effect.gen(function* () {
      const requests = yield* BrowserRequests.BrowserRequests;
      const allowed = yield* requestBrowserAction(scope, {
        kind: "history",
        reason: "",
        query: "welcome",
        limit: 20,
        autoApprove: false,
      }).pipe(Effect.forkChild);
      const card = yield* waitForCard(h);
      assert.strictEqual(card.query, "welcome");
      assert.strictEqual(card.historyLimit, 20);
      const visits = [
        {
          url: "http://127.0.0.1:4000/welcome",
          title: "Welcome",
          visitedAt: 1,
          source: "agent" as const,
        },
      ];
      yield* requests.answer({
        threadId,
        turnItemId: card.id as never,
        answer: { type: "history", decision: "allow", visits },
      });
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(yield* Fiber.join(allowed), { status: "allowed", visits });
      assert.isTrue((yield* requests.takeHistory(card.id as string))._tag === "None");

      const denied = yield* requestBrowserAction(scope, {
        kind: "history",
        reason: "",
        limit: 20,
        autoApprove: false,
        clientRequestId: "second",
      }).pipe(Effect.forkChild);
      const second = yield* waitForCard(h);
      yield* requests.answer({
        threadId,
        turnItemId: second.id as never,
        answer: { type: "history", decision: "deny" },
      });
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(yield* Fiber.join(denied), { status: "declined" });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("rejects an answer of the wrong kind or a second answer", () => {
    const h = harness();
    return Effect.gen(function* () {
      const requests = yield* BrowserRequests.BrowserRequests;
      const fiber = yield* requestBrowserAction(scope, {
        kind: "sign_in",
        origin: "https://example.com",
        tabId: "tab-1",
        reason: "",
      }).pipe(Effect.forkChild);
      const card = yield* waitForCard(h);
      const wrong = yield* Effect.flip(
        requests.answer({
          threadId,
          turnItemId: card.id as never,
          answer: { type: "history", decision: "deny" },
        }),
      );
      assert.strictEqual(wrong.reason, "wrong_kind");
      yield* requests.answer({
        threadId,
        turnItemId: card.id as never,
        answer: { type: "sign_in", outcome: "declined" },
      });
      const again = yield* Effect.flip(
        requests.answer({
          threadId,
          turnItemId: card.id as never,
          answer: { type: "sign_in", outcome: "submitted" },
        }),
      );
      assert.strictEqual(again.reason, "already_answered");
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(yield* Fiber.join(fiber), { status: "declined" });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("withdraws the card when the run stops, and times out when nobody answers", () => {
    const h = harness();
    return Effect.gen(function* () {
      const stopped = yield* requestBrowserAction(scope, {
        kind: "sign_in",
        origin: "https://example.com",
        tabId: "tab-1",
        reason: "",
      }).pipe(Effect.forkChild);
      yield* waitForCard(h);
      h.stopRun();
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(yield* Fiber.join(stopped), { status: "cancelled" });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("closes an unanswered card at its timeout", () => {
    const h = harness();
    return Effect.gen(function* () {
      const fiber = yield* requestBrowserAction(scope, {
        kind: "history",
        reason: "",
        limit: 5,
        autoApprove: true,
        timeoutMs: 30_000,
      }).pipe(Effect.forkChild);
      const card = yield* waitForCard(h);
      assert.isTrue(card.autoApprove === true);
      yield* TestClock.adjust("31 seconds");
      assert.deepStrictEqual(yield* Fiber.join(fiber), { status: "timed_out" });
      assert.strictEqual(h.cards.get(card.id as string)?.browserStatus, "cancelled");
    }).pipe(Effect.provide(h.layer));
  });
});

describe("preview_sign_in and preview_history", () => {
  it("normalizes the site an agent names", () => {
    assert.strictEqual(
      PreviewHandlers.normalizeSignInOrigin("https://app.example.com/login?x=1"),
      "https://app.example.com",
    );
    assert.strictEqual(PreviewHandlers.normalizeSignInOrigin("example.com"), "https://example.com");
    assert.isNull(PreviewHandlers.normalizeSignInOrigin("javascript:alert(1)"));
  });

  const withMode = (mode: "ask" | "allow" | "off", h: ReturnType<typeof harness>) =>
    Layer.mergeAll(
      h.layer,
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({ browserAgentHistoryAccess: mode } as never),
      }),
    );

  it.effect("history is refused without a card when the setting is off", () => {
    const h = harness();
    return Effect.gen(function* () {
      const result = yield* PreviewHandlers.history({ query: "x" });
      assert.deepStrictEqual(result, { status: "history_access_disabled" });
      assert.strictEqual(h.cards.size, 0);
    }).pipe(Effect.provide(withMode("off", h)));
  });

  it.effect("history asks by default, and shares without asking when allowed", () => {
    const ask = harness();
    const allow = harness();
    return Effect.gen(function* () {
      const asked = yield* PreviewHandlers.history({ query: "welcome", limit: 5 }).pipe(
        Effect.provide(withMode("ask", ask)),
        Effect.forkChild,
      );
      const card = yield* waitForCard(ask);
      assert.notStrictEqual(card.autoApprove, true);
      yield* BrowserRequests.BrowserRequests.pipe(
        Effect.flatMap((requests) =>
          requests.answer({
            threadId,
            turnItemId: card.id as never,
            answer: { type: "history", decision: "deny" },
          }),
        ),
        Effect.provide(ask.layer),
      );
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(yield* Fiber.join(asked), { status: "declined" });

      const auto = yield* PreviewHandlers.history({}).pipe(
        Effect.provide(withMode("allow", allow)),
        Effect.forkChild,
      );
      const autoCard = yield* waitForCard(allow);
      assert.strictEqual(autoCard.autoApprove, true);
      assert.strictEqual(autoCard.historyLimit, 20);
      // No desktop app answered within the short wait.
      yield* TestClock.adjust("31 seconds");
      assert.deepStrictEqual(yield* Fiber.join(auto), { status: "unavailable" });
    });
  });
});
