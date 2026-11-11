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
  attentionContext,
  setUpManager,
  userSays,
  withTeam,
  writeReadyPlan,
  type TeamHarness,
} from "../../../projectTeam/testkit.ts";
import { requiredPlanGates } from "../../../projectTeam/planGates.ts";
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
          const lead = content(created).task.leadThreadId as ThreadId;

          const leadStart = yield* call(lead, "task_start", { taskId: content(created).task.id });
          assert.isTrue(leadStart.isError);
          assert.include(JSON.stringify(leadStart.content), "not available to a task lead");

          // A lead's task_create drafts a subtask of its own task.
          const leadCreate = yield* call(lead, "task_create", { title: "B", request: "Do B." });
          assert.isFalse(leadCreate.isError);
          assert.strictEqual(content(leadCreate).task.parentTaskId, content(created).task.id);

          const pmAsk = yield* call(pm, "ask_user", {
            context: attentionContext({ action: "Which?" }),
            kind: "decision",
            question: "Which?",
          });
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
          // task_create starts the lead at once: no proposal card, no separate task_start.
          assert.isFalse(created.isError);
          assert.strictEqual(content(created).task.stage, "planning");
          const team = yield* ProjectTeamService.ProjectTeamService;
          assert.deepStrictEqual((yield* team.attentionSnapshot).projects[0]!.decisionCards, []);
          const lead = content(created).task.leadThreadId as ThreadId;
          // The task lead is delegated from the PM's own MCP scope, its end does
          // not wake the PM (the outcome reactor decides that), and its worktree
          // starts from origin's default branch rather than the PM's local HEAD.
          assert.deepStrictEqual(yield* Ref.get(delegateCalls), [
            { scope: pm, completionWake: "never", worktreeBase: "origin-default" },
          ]);

          const missingContext = yield* call(lead, "ask_user", {
            kind: "decision",
            question: "Add hello.sh in bash or sh?",
          }).pipe(Effect.flip);
          assert.strictEqual(missingContext._tag, "InvalidParams");
          assert.include(missingContext.message, 'at ["context"]');

          const asked = yield* call(lead, "ask_user", {
            context: attentionContext({ action: "Add hello.sh in bash or sh?" }),
            kind: "decision",
            question: "Add hello.sh in bash or sh?",
          });
          assert.isFalse(asked.isError);
          const item = content(asked).item;
          assert.strictEqual(item.askerThreadId, lead);
          assert.deepStrictEqual(
            item.context,
            attentionContext({ action: "Add hello.sh in bash or sh?" }),
          );

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
            return {
              taskId: content(created).task.id as string,
              lead: content(created).task.leadThreadId as ThreadId,
            };
          });
        const first = yield* startTask("First");
        const second = yield* startTask("Second");

        const asked = yield* call(first.lead, "ask_user", {
          context: attentionContext({ action: "Bash or sh?" }),
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

  it.effect("sends a lead's plan approval to the plan checker, which alone records verdicts", () =>
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
          const lead = content(created).task.leadThreadId as ThreadId;
          yield* writeReadyPlan(lead);

          const asked = yield* call(lead, "ask_user", {
            context: attentionContext({ action: "Approve the plan?" }),
            kind: "approval",
            question: "Approve the plan?",
          });
          assert.isFalse(asked.isError);
          assert.strictEqual(content(asked).planCheck.status, "checking");
          assert.include(content(asked).message, "end your turn");
          // The checker is the lead's own child, like a task_delegate step.
          assert.strictEqual((yield* Ref.get(delegateCalls)).at(-1)?.scope, lead);
          const team = yield* ProjectTeamService.ProjectTeamService;
          assert.deepStrictEqual((yield* team.attentionSnapshot).projects[0]!.decisionCards, []);

          const verdicts = [{ gate: "problem", pass: true, reason: "충분해요." }];
          const byLead = yield* call(lead, "task_plan_check_set", { specVersion: 2, verdicts });
          assert.isTrue(byLead.isError);
          const checker = content(asked).planCheck.checker.threadId as ThreadId;
          const byChecker = yield* call(checker, "task_plan_check_set", {
            specVersion: 2,
            verdicts: requiredPlanGates("light").map((gate) => ({
              gate: gate.id,
              pass: true,
              reason: "충분해요.",
            })),
          });
          assert.isFalse(byChecker.isError);
          assert.strictEqual(content(byChecker).task.stage, "awaiting_approval");
        }).pipe(Effect.provide(registration(harness, delegateCalls)));
      }),
    ),
  );
});
