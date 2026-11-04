import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ProjectTeamService from "../../../projectTeam/ProjectTeamService.ts";
import { setUpManager, withTeam, type TeamHarness } from "../../../projectTeam/testkit.ts";
import * as ProjectTeamHandlers from "./handlers.ts";
import { ProjectTeamToolkit } from "./tools.ts";

const scopeFor = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:team"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "team", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "team", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/** The toolkit as /mcp registers it, with delegate_task going to the team harness. */
const registration = (harness: TeamHarness, delegateScopes: Ref.Ref<ReadonlyArray<ThreadId>>) =>
  McpHttpServer.toolkitRegistration(ProjectTeamToolkit, ProjectTeamHandlers.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(liveThreadsLayer),
    Layer.provide(
      Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
        delegateTask: (scope, input) =>
          Ref.update(delegateScopes, (all) => [...all, scope.thread!.threadId]).pipe(
            Effect.andThen(harness.delegate(input)),
          ),
      }),
    ),
  );

const call = (caller: ThreadId, name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scopeFor(caller)),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );
  });

const content = (result: McpSchema.CallToolResult) => result.structuredContent as any;

describe("projectTeam MCP toolkit", () => {
  it.effect("keeps PM tools from task leads and ask_user from the PM", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const pm = yield* setUpManager;
        const created = yield* call(pm, "task_create", { title: "A", request: "Do A." });
        assert.isFalse(created.isError);
        const started = yield* call(pm, "task_start", { taskId: content(created).task.id });
        assert.isFalse(started.isError);
        const lead = content(started).leadThreadId as ThreadId;

        const leadCreate = yield* call(lead, "task_create", { title: "B", request: "Do B." });
        assert.isTrue(leadCreate.isError);
        assert.include(JSON.stringify(leadCreate.content), "not available to a task lead");

        const pmAsk = yield* call(pm, "ask_user", { kind: "decision", question: "Which?" });
        assert.isTrue(pmAsk.isError);
        assert.include(JSON.stringify(pmAsk.content), "not available to a PM");
      }).pipe(Effect.provide(registration(harness, Ref.makeUnsafe<ReadonlyArray<ThreadId>>([])))),
    ),
  );

  it.effect("runs create, start, ask_user and attention_answer end to end", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const delegateScopes = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
        return yield* Effect.gen(function* () {
          const pm = yield* setUpManager;
          const created = yield* call(pm, "task_create", {
            title: "Add hello.sh",
            request: "Add hello.sh with a test.",
          });
          assert.strictEqual(content(created).task.stage, "inbox");

          const started = yield* call(pm, "task_start", { taskId: content(created).task.id });
          assert.isFalse(started.isError);
          assert.strictEqual(content(started).task.stage, "planning");
          const lead = content(started).leadThreadId as ThreadId;
          // The task lead is delegated from the PM's own MCP scope.
          assert.deepStrictEqual(yield* Ref.get(delegateScopes), [pm]);

          const asked = yield* call(lead, "ask_user", {
            kind: "approval",
            question: "Approve the plan: add hello.sh and a test?",
          });
          assert.isFalse(asked.isError);
          const item = content(asked).item;
          assert.strictEqual(item.askerThreadId, lead);

          const status = yield* call(pm, "team_status", { reason: "user_asked" });
          assert.isFalse(status.isError);
          assert.deepStrictEqual(
            content(status).openAttention.map((open: { id: string }) => open.id),
            [item.id],
          );

          const answered = yield* call(pm, "attention_answer", {
            attentionItemId: item.id,
            answer: "Approved.",
          });
          assert.isFalse(answered.isError);
          assert.strictEqual(content(answered).item.answer, "Approved.");

          const after = yield* call(lead, "task_read", { taskId: content(created).task.id });
          assert.isFalse(after.isError);
          assert.deepStrictEqual(content(after).openAttention, []);
        }).pipe(Effect.provide(registration(harness, delegateScopes)));
      }),
    ),
  );

  it.effect("refuses self-approval, cross-task, cross-project, and non-team callers", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const pm = yield* setUpManager;
        const startTask = (title: string) =>
          Effect.gen(function* () {
            const created = yield* call(pm, "task_create", { title, request: `${title}.` });
            const started = yield* call(pm, "task_start", { taskId: content(created).task.id });
            return {
              taskId: content(created).task.id as string,
              lead: content(started).leadThreadId as ThreadId,
            };
          });
        const first = yield* startTask("First");
        const second = yield* startTask("Second");

        const asked = yield* call(first.lead, "ask_user", { kind: "approval", question: "Plan?" });
        const selfApproval = yield* call(first.lead, "attention_answer", {
          attentionItemId: content(asked).item.id,
          answer: "Approved.",
        });
        assert.isTrue(selfApproval.isError);

        const crossTask = yield* call(first.lead, "task_update", {
          taskId: second.taskId,
          stage: "done",
        });
        assert.isTrue(crossTask.isError);

        const outsider = yield* call(ThreadId.make("not-on-the-team"), "task_list", {});
        assert.isTrue(outsider.isError);

        const otherProject = ProjectId.make("project-2");
        harness.addProject(otherProject, "Other");
        const team = yield* ProjectTeamService.ProjectTeamService;
        const otherPm = (yield* team.ensureManager(otherProject)).threadId;
        const crossProjectRead = yield* call(otherPm, "task_read", { taskId: first.taskId });
        assert.isTrue(crossProjectRead.isError);
        const crossProjectAnswer = yield* call(otherPm, "attention_answer", {
          attentionItemId: content(asked).item.id,
          answer: "Approved.",
        });
        assert.isTrue(crossProjectAnswer.isError);
      }).pipe(Effect.provide(registration(harness, Ref.makeUnsafe<ReadonlyArray<ThreadId>>([])))),
    ),
  );
});
