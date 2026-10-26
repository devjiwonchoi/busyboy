import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2ServerCommand,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerUseApprovals from "./ComputerUseApprovals.ts";

const threadId = ThreadId.make("thread-1");
const providerInstanceId = ProviderInstanceId.make("claude");
const request = {
  threadId,
  providerInstanceId,
  appName: "TextEdit",
  bundleId: "com.apple.TextEdit",
};

interface FakeThread {
  runs: Array<{
    id: string;
    status: string;
    rootNodeId: string | null;
    providerInstanceId: string;
    ordinal: number;
  }>;
  turnItems: Array<Record<string, unknown>>;
  readonly dispatched: Array<OrchestrationV2ServerCommand>;
}

/** Applies approval records the way the orchestrator does: the first answer wins. */
function fakeThread(): FakeThread {
  return {
    runs: [
      { id: "run-1", status: "running", rootNodeId: "node-1", providerInstanceId, ordinal: 1 },
    ],
    turnItems: [],
    dispatched: [],
  };
}

const withApprovals = <A, E>(
  thread: FakeThread,
  body: (input: {
    readonly approvals: ComputerUseApprovals.ComputerUseApprovals["Service"];
    readonly settings: ServerSettings.ServerSettingsService["Service"];
  }) => Effect.Effect<A, E>,
  options?: { readonly allowedApps?: ReadonlyArray<string>; readonly wait?: Duration.Duration },
) =>
  Effect.gen(function* () {
    const threadManagement = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.sync(
          () => ({ thread: {}, runs: thread.runs, turnItems: thread.turnItems }) as never,
        ),
      dispatch: (command) =>
        Effect.sync(() => {
          thread.dispatched.push(command);
          if (command.type !== "computer_use_approval.record") return {} as never;
          const existing = thread.turnItems.find((item) => item.id === command.turnItemId);
          if (existing === undefined) {
            thread.turnItems.push({
              id: command.turnItemId,
              threadId: command.threadId,
              runId: command.runId,
              nodeId: command.nodeId,
              type: "computer_use_approval",
              appName: command.appName,
              bundleId: command.bundleId,
              approvalStatus: command.approvalStatus,
              approvalKind: command.approvalKind,
            });
          } else if (existing.approvalStatus === "pending") {
            existing.approvalStatus = command.approvalStatus;
          }
          return {} as never;
        }),
    });
    const settingsLayer = ServerSettings.layerTest({
      computerUseAllowedApps: [...(options?.allowedApps ?? [])],
    });
    return yield* Effect.gen(function* () {
      const approvals = yield* ComputerUseApprovals.make({
        wait: options?.wait ?? Duration.seconds(10),
      });
      const settings = yield* ServerSettings.ServerSettingsService;
      return yield* body({ approvals, settings });
    }).pipe(Effect.provide(Layer.mergeAll(threadManagement, settingsLayer)));
  });

const turnItemId = ComputerUseApprovals.approvalTurnItemId(
  threadId,
  "run-1" as never,
  "com.apple.TextEdit",
);

/** Waits until the card is on the thread, then answers it as the user. */
const answerWhenShown = (
  thread: FakeThread,
  approvals: ComputerUseApprovals.ComputerUseApprovals["Service"],
  decision: "allow_once" | "allow_thread" | "allow_always" | "deny",
) =>
  Effect.gen(function* () {
    while (!thread.turnItems.some((item) => item.id === turnItemId)) {
      yield* Effect.sleep(Duration.millis(20));
    }
    yield* approvals.answer({ threadId, turnItemId, decision });
  });

const requireCode = (effect: Effect.Effect<void, { readonly code: string }>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.code),
  );

describe("ComputerUseApprovals", () => {
  it.live("lets an always-allowed app through without asking", () =>
    Effect.gen(function* () {
      const thread = fakeThread();
      yield* withApprovals(thread, ({ approvals }) => approvals.require(request), {
        allowedApps: ["COM.APPLE.TEXTEDIT"],
      });
      assert.lengthOf(thread.dispatched, 0);
    }),
  );

  it.live("asks once, then remembers a thread grant for later runs", () =>
    Effect.gen(function* () {
      const thread = fakeThread();
      yield* withApprovals(thread, ({ approvals }) =>
        Effect.gen(function* () {
          const waiting = yield* Effect.forkChild(approvals.require(request));
          yield* answerWhenShown(thread, approvals, "allow_thread");
          yield* Fiber.join(waiting);
          assert.strictEqual(thread.turnItems[0]?.approvalStatus, "allowed_thread");

          thread.runs = [
            { ...thread.runs[0]!, status: "completed" },
            {
              id: "run-2",
              status: "running",
              rootNodeId: "node-2",
              providerInstanceId,
              ordinal: 2,
            },
          ];
          yield* approvals.require(request);
          assert.lengthOf(thread.turnItems, 1);
        }),
      );
    }),
  );

  it.live("shares one card between parallel calls for the same app", () =>
    Effect.gen(function* () {
      const thread = fakeThread();
      yield* withApprovals(thread, ({ approvals }) =>
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(approvals.require(request));
          const second = yield* Effect.forkChild(approvals.require(request));
          yield* answerWhenShown(thread, approvals, "allow_once");
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          assert.lengthOf(thread.turnItems, 1);
        }),
      );
    }),
  );

  it.live("refuses a denied app for the rest of the run without asking again", () =>
    Effect.gen(function* () {
      const thread = fakeThread();
      yield* withApprovals(thread, ({ approvals }) =>
        Effect.gen(function* () {
          const waiting = yield* Effect.forkChild(requireCode(approvals.require(request)));
          yield* answerWhenShown(thread, approvals, "deny");
          assert.strictEqual(yield* Fiber.join(waiting), "app_denied");
          const records = thread.dispatched.length;
          assert.strictEqual(yield* requireCode(approvals.require(request)), "app_denied");
          assert.lengthOf(thread.dispatched, records);
        }),
      );
    }),
  );

  it.live("closes an unanswered card when the wait runs out", () =>
    Effect.gen(function* () {
      const thread = fakeThread();
      const code = yield* withApprovals(
        thread,
        ({ approvals }) => requireCode(approvals.require(request)),
        { wait: Duration.millis(200) },
      );
      assert.strictEqual(code, "approval_unavailable");
      assert.strictEqual(thread.turnItems[0]?.approvalStatus, "cancelled");
    }),
  );

  it.live("closes the card when the agent's run ends first", () =>
    Effect.gen(function* () {
      const thread = fakeThread();
      yield* withApprovals(thread, ({ approvals }) =>
        Effect.gen(function* () {
          const waiting = yield* Effect.forkChild(requireCode(approvals.require(request)));
          while (thread.turnItems.length === 0) yield* Effect.sleep(Duration.millis(20));
          thread.runs = [{ ...thread.runs[0]!, status: "interrupted" }];
          assert.strictEqual(yield* Fiber.join(waiting), "approval_unavailable");
          assert.strictEqual(thread.turnItems[0]?.approvalStatus, "cancelled");
        }),
      );
    }),
  );

  it.live("needs an active run of the calling agent to ask", () =>
    Effect.gen(function* () {
      const thread = fakeThread();
      thread.runs = [{ ...thread.runs[0]!, providerInstanceId: "codex" }];
      const code = yield* withApprovals(thread, ({ approvals }) =>
        requireCode(approvals.require(request)),
      );
      assert.strictEqual(code, "approval_unavailable");
      assert.lengthOf(thread.dispatched, 0);
    }),
  );

  it.live("saves an always answer to settings", () =>
    Effect.gen(function* () {
      const thread = fakeThread();
      const allowed = yield* withApprovals(thread, ({ approvals, settings }) =>
        Effect.gen(function* () {
          const waiting = yield* Effect.forkChild(approvals.require(request));
          yield* answerWhenShown(thread, approvals, "allow_always");
          yield* Fiber.join(waiting);
          return (yield* settings.getSettings).computerUseAllowedApps;
        }),
      );
      assert.deepStrictEqual(allowed, ["com.apple.TextEdit"]);
    }),
  );

  it.live("rejects an answer to a card that is no longer pending", () =>
    Effect.gen(function* () {
      const thread = fakeThread();
      yield* withApprovals(thread, ({ approvals }) =>
        Effect.gen(function* () {
          const waiting = yield* Effect.forkChild(approvals.require(request));
          yield* answerWhenShown(thread, approvals, "allow_once");
          yield* Fiber.join(waiting);
          const error = yield* Effect.flip(
            approvals.answer({ threadId, turnItemId, decision: "allow_always" }),
          );
          assert.strictEqual(error.reason, "already_answered");
        }),
      );
    }),
  );

  it.live("asks about the front separately, for this turn only", () =>
    Effect.gen(function* () {
      const thread = fakeThread();
      yield* withApprovals(
        thread,
        ({ approvals, settings }) =>
          Effect.gen(function* () {
            const foreground = { ...request, kind: "foreground" as const };
            const foregroundCard = ComputerUseApprovals.approvalTurnItemId(
              threadId,
              "run-1" as never,
              "com.apple.TextEdit",
              "foreground",
            );
            const waiting = yield* Effect.forkChild(approvals.require(foreground));
            while (!thread.turnItems.some((item) => item.id === foregroundCard)) {
              yield* Effect.sleep(Duration.millis(20));
            }
            assert.strictEqual(
              thread.turnItems.find((item) => item.id === foregroundCard)?.approvalKind,
              "foreground",
            );
            // Even "always" only allows the front for this turn.
            yield* approvals.answer({
              threadId,
              turnItemId: foregroundCard,
              decision: "allow_always",
            });
            yield* Fiber.join(waiting);

            const card = thread.turnItems.find((item) => item.id === foregroundCard);
            assert.strictEqual(card?.approvalStatus, "allowed_once");
            assert.deepStrictEqual((yield* settings.getSettings).computerUseAllowedApps, [
              "com.apple.Notes",
            ]);
          }),
        { allowedApps: ["com.apple.Notes"] },
      );
    }),
  );
});
