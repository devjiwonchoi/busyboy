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
import {
  PROJECT_ID,
  setUpManager,
  userSays,
  withTeam,
  type TeamHarness,
} from "../../../projectTeam/testkit.ts";
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
interface DelegateCall {
  readonly scope: ThreadId;
  readonly completionWake: string | undefined;
  readonly worktreeBase: string | undefined;
}

const registration = (harness: TeamHarness, delegateCalls: Ref.Ref<ReadonlyArray<DelegateCall>>) =>
  McpHttpServer.toolkitRegistration(ProjectTeamToolkit, ProjectTeamHandlers.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(liveThreadsLayer),
    Layer.provide(
      Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
        delegateTask: (scope, input, options) =>
          Ref.update(delegateCalls, (all) => [
            ...all,
            {
              scope: scope.thread!.threadId,
              completionWake: options?.completionWake,
              worktreeBase: options?.worktreeBase,
            },
          ]).pipe(Effect.andThen(harness.delegate(input))),
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
  it.effect(
    "keeps PM tools from task leads, lets leads draft subtasks, and keeps ask_user from the PM",
    () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const pm = yield* setUpManager;
          const created = yield* call(pm, "task_create", {
            intake: "New work.",
            goal: "Deliver the requested result.",
            verification: "Check the result.",
            title: "A",
            request: "Do A.",
          });
          assert.isFalse(created.isError);
          const team = yield* ProjectTeamService.ProjectTeamService;
          const card = (yield* team.attentionSnapshot).projects[0]!.decisionCards.find(
            (entry) => entry.item.taskId === content(created).task.id,
          )!;
          yield* team.answerDecision({
            projectId: PROJECT_ID,
            attentionItemId: card.item.id,
            answer: "태스크로 추가",
          });
          const started = yield* call(pm, "task_start", { taskId: content(created).task.id });
          assert.isFalse(started.isError);
          const lead = content(started).leadThreadId as ThreadId;

          const leadStart = yield* call(lead, "task_start", { taskId: content(created).task.id });
          assert.isTrue(leadStart.isError);
          assert.include(JSON.stringify(leadStart.content), "not available to a task lead");

          // A lead's task_create drafts a subtask of its own task.
          const leadCreate = yield* call(lead, "task_create", { title: "B", request: "Do B." });
          assert.isFalse(leadCreate.isError);
          assert.strictEqual(content(leadCreate).task.parentTaskId, content(created).task.id);

          const pmAsk = yield* call(pm, "ask_user", { kind: "decision", question: "Which?" });
          assert.isTrue(pmAsk.isError);
          assert.include(JSON.stringify(pmAsk.content), "not available to a PM");
        }).pipe(
          Effect.provide(registration(harness, Ref.makeUnsafe<ReadonlyArray<DelegateCall>>([]))),
        ),
      ),
  );

  it.effect("lets the PM set who merges with team_settings_update", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const pm = yield* setUpManager;
        const updated = yield* call(pm, "team_settings_update", { mergeOwner: "user" });
        assert.isFalse(updated.isError);
        assert.strictEqual(content(updated).settings.mergeOwner, "user");
        const team = yield* ProjectTeamService.ProjectTeamService;
        const status = yield* team.teamStatus(pm, {});
        assert.strictEqual(status.settings.mergeOwner, "user");
      }).pipe(
        Effect.provide(registration(harness, Ref.makeUnsafe<ReadonlyArray<DelegateCall>>([]))),
      ),
    ),
  );

  it.effect("runs create, start, ask_user and attention_answer end to end", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const delegateCalls = yield* Ref.make<ReadonlyArray<DelegateCall>>([]);
        return yield* Effect.gen(function* () {
          const pm = yield* setUpManager;
          const created = yield* call(pm, "task_create", {
            intake: "New work.",
            goal: "Deliver the requested result.",
            verification: "Check the result.",
            title: "Add hello.sh",
            request: "Add hello.sh with a test.",
          });
          assert.strictEqual(content(created).task.stage, "proposed");

          const team = yield* ProjectTeamService.ProjectTeamService;
          const card = (yield* team.attentionSnapshot).projects[0]!.decisionCards.find(
            (entry) => entry.item.taskId === content(created).task.id,
          )!;
          yield* team.answerDecision({
            projectId: PROJECT_ID,
            attentionItemId: card.item.id,
            answer: "태스크로 추가",
          });
          const started = yield* call(pm, "task_start", { taskId: content(created).task.id });
          assert.isFalse(started.isError);
          assert.strictEqual(content(started).task.stage, "planning");
          const lead = content(started).leadThreadId as ThreadId;
          // The task lead is delegated from the PM's own MCP scope, its end does
          // not wake the PM (the outcome reactor decides that), and its worktree
          // starts from origin's default branch rather than the PM's local HEAD.
          assert.deepStrictEqual(yield* Ref.get(delegateCalls), [
            { scope: pm, completionWake: "never", worktreeBase: "origin-default" },
          ]);

          const asked = yield* call(lead, "ask_user", {
            kind: "decision",
            question: "Add hello.sh in bash or sh?",
          });
          assert.isFalse(asked.isError);
          const item = content(asked).item;
          assert.strictEqual(item.askerThreadId, lead);

          const status = yield* call(pm, "team_status", {});
          assert.isFalse(status.isError);
          assert.deepStrictEqual(
            content(status).openAttention.map((open: { id: string }) => open.id),
            [item.id],
          );

          // The PM may relay only words the user typed in its chat.
          userSays(harness, pm, "Bash, please.");
          const answered = yield* call(pm, "attention_answer", {
            attentionItemId: item.id,
            answer: "Bash, please.",
          });
          assert.isFalse(answered.isError);
          assert.strictEqual(content(answered).item.answer, "Bash, please.");

          const after = yield* call(lead, "task_read", { taskId: content(created).task.id });
          assert.isFalse(after.isError);
          assert.deepStrictEqual(content(after).openAttention, []);
        }).pipe(Effect.provide(registration(harness, delegateCalls)));
      }),
    ),
  );

  it.effect("refuses self-approval, cross-task, cross-project, and non-team callers", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const pm = yield* setUpManager;
        const startTask = (title: string) =>
          Effect.gen(function* () {
            const created = yield* call(pm, "task_create", {
              intake: "New work.",
              goal: "Deliver the requested result.",
              verification: "Check the result.",
              title,
              request: `${title}.`,
            });
            const team = yield* ProjectTeamService.ProjectTeamService;
            const card = (yield* team.attentionSnapshot).projects[0]!.decisionCards.find(
              (entry) => entry.item.taskId === content(created).task.id,
            )!;
            yield* team.answerDecision({
              projectId: PROJECT_ID,
              attentionItemId: card.item.id,
              answer: "태스크로 추가",
            });
            const started = yield* call(pm, "task_start", { taskId: content(created).task.id });
            return {
              taskId: content(created).task.id as string,
              lead: content(started).leadThreadId as ThreadId,
            };
          });
        const first = yield* startTask("First");
        const second = yield* startTask("Second");

        const asked = yield* call(first.lead, "ask_user", {
          kind: "decision",
          question: "Bash or sh?",
        });
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
        const crossProjectDismiss = yield* call(otherPm, "attention_dismiss", {
          attentionItemId: content(asked).item.id,
          reason: "Moot.",
        });
        assert.isTrue(crossProjectDismiss.isError);
        const otherLeadDismiss = yield* call(second.lead, "attention_dismiss", {
          attentionItemId: content(asked).item.id,
          reason: "Moot.",
        });
        assert.isTrue(otherLeadDismiss.isError);
        assert.include(JSON.stringify(otherLeadDismiss.content), "only close its own questions");
        const outsiderDismiss = yield* call(ThreadId.make("not-on-the-team"), "attention_dismiss", {
          attentionItemId: content(asked).item.id,
          reason: "Moot.",
        });
        assert.isTrue(outsiderDismiss.isError);

        const dismissed = yield* call(pm, "attention_dismiss", {
          attentionItemId: content(asked).item.id,
          reason: "The user picked bash in chat",
        });
        assert.isFalse(dismissed.isError);
        assert.isNotNull(content(dismissed).item.supersededAt);
        assert.isNull(content(dismissed).item.answer);
        const notices = (yield* Ref.get(harness.sent)).filter(
          (sent) => sent.threadId === first.lead,
        );
        assert.strictEqual(notices.length, 1);
        assert.isTrue(notices[0]!.text.startsWith("[Question closed by BusyBoy PM]"));
        assert.include(notices[0]!.text, "The user picked bash in chat");
      }).pipe(
        Effect.provide(registration(harness, Ref.makeUnsafe<ReadonlyArray<DelegateCall>>([]))),
      ),
    ),
  );
});
