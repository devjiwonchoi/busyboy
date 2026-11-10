import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as CloudLeadService from "../cloudLead/CloudLeadService.ts";
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import type { CodexCheck } from "../cloudLead/CloudLeadRuntime.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import {
  approvePlan,
  createAcceptedTask,
  PROJECT_ID,
  setUpManager,
  startLead,
  withTeam,
} from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;

describe("ProjectTeamService location", () => {
  it.effect(
    "starts a cloud lead in the cloud, keeps the task cloud, and runs its steps on its checkout",
    () =>
      withTeam((harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const pm = yield* setUpManager;
          const { task: created } = yield* createAcceptedTask(pm, {
            title: "Add hello.sh",
            request: "Add hello.sh.",
            intake: "New work.",
          });

          const { task, leadThreadId } = yield* team.startTask(
            pm,
            { taskId: created.id, location: "cloud" },
            harness.delegate,
          );
          const leadCall = (yield* Ref.get(harness.delegated)).at(-1);
          assert.strictEqual(leadCall?.location, "cloud");
          assert.include(leadCall?.task ?? "", "## Cloud");
          assert.strictEqual(task.location, "cloud");
          assert.strictEqual(
            (yield* team.readTask(pm, { taskId: task.id })).task.location,
            "cloud",
          );
          const reference = (yield* team.attentionSnapshot).projects
            .find((project) => project.projectId === PROJECT_ID)
            ?.tasks.find((entry) => entry.id === task.id);
          assert.strictEqual(reference?.location, "cloud");

          // Steps share the lead's checkout, so delegate_task runs them in its sandbox.
          for (const role of ["review", "implement"] as const) {
            yield* team.delegateStep(leadThreadId, { role, task: "Do it." }, harness.delegate);
            const call = (yield* Ref.get(harness.delegated)).at(-1);
            assert.strictEqual(call?.isolation, undefined);
          }
        }),
      ),
  );

  it.effect("starts a lead locally by default", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const pm = yield* setUpManager;
        const { task, leadThreadId } = yield* startLead(pm, "Add hello.sh", harness.delegate);
        const leadCall = (yield* Ref.get(harness.delegated)).at(-1);
        assert.strictEqual(leadCall?.location, undefined);
        assert.notInclude(leadCall?.task ?? "", "## Cloud");
        assert.strictEqual(task.location, "local");

        const team = yield* service;
        yield* team.delegateStep(
          leadThreadId,
          { role: "review", task: "Review main...HEAD against the criteria." },
          harness.delegate,
        );
        assert.strictEqual((yield* Ref.get(harness.delegated)).at(-1)?.location, undefined);
      }),
    ),
  );

  it.effect("releases a cloud task's sandbox when the task is cancelled", () => {
    const released: string[] = [];
    return withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const pm = yield* setUpManager;
          const { task: created } = yield* createAcceptedTask(pm, {
            title: "Add hello.sh",
            request: "Add hello.sh.",
            intake: "New work.",
          });
          const { leadThreadId } = yield* team.startTask(
            pm,
            { taskId: created.id, location: "cloud" },
            harness.delegate,
          );
          yield* team.updateTask(pm, { taskId: created.id, stage: "cancelled" });
          // The release runs in the background.
          for (let i = 0; i < 20 && released.length === 0; i += 1) yield* Effect.yieldNow;
          assert.deepEqual(released, [leadThreadId]);
        }),
      {
        cloudLead: {
          ...CloudLeadService.unavailableHooks,
          prepare: () => Effect.die("not used"),
          checkCodex: () => Effect.die("not used"),
          syncToMac: () => Effect.void,
          release: (threadId) => Effect.sync(() => void released.push(threadId)),
        },
      },
    );
  });

  const claude = ProviderInstanceId.make("claude-work");
  const codex = ProviderInstanceId.make("codex");
  const PLAN = { providerInstanceId: claude, model: "claude-opus-5-5" };
  const CODEX = { providerInstanceId: codex, model: "gpt-6.1-sol" };

  /** A cloud lead with every step on Codex, whose sandbox answers checkCodex with `check`. */
  const cloudLeadOnCodex = (check: CodexCheck) =>
    withTeam(
      (harness) =>
        Effect.gen(function* () {
          const team = yield* service;
          const pm = yield* setUpManager;
          harness.providers.push(
            { instanceId: claude, driver: "claudeAgent" } as unknown as ServerProvider,
            { instanceId: codex, driver: "codex" } as unknown as ServerProvider,
          );
          yield* team.updateSettings({
            projectId: PROJECT_ID,
            roleModels: { plan: PLAN, implement: CODEX, review: CODEX, fix: CODEX },
          });
          const { task: created } = yield* createAcceptedTask(pm, {
            title: "Add hello.sh",
            request: "Add hello.sh.",
            intake: "New work.",
          });
          const { task, leadThreadId } = yield* team.startTask(
            pm,
            { taskId: created.id, location: "cloud" },
            harness.delegate,
          );
          const lead = harness.addThread(leadThreadId);
          lead.worktreePath = "/mac/worktrees/lead";
          lead.shell = { location: "cloud" };
          yield* approvePlan(leadThreadId);
          const targets = [];
          for (const role of ["implement", "review"] as const) {
            yield* team.delegateStep(leadThreadId, { role, task: "Do it." }, harness.delegate);
            targets.push((yield* Ref.get(harness.delegated)).at(-1)?.target);
          }
          const { task: after } = yield* team.readTask(pm, { taskId: task.id });
          return { targets, roleModels: after.roleModels };
        }),
      {
        cloudLead: {
          ...CloudLeadService.unavailableHooks,
          prepare: () => Effect.die("not used"),
          checkCodex: () => Effect.succeed(check),
          syncToMac: () => Effect.void,
          release: () => Effect.void,
        },
      },
    );

  it.effect(
    "moves a cloud task's steps, review included, to the plan model when Codex can't log in",
    () =>
      Effect.gen(function* () {
        const { targets, roleModels } = yield* cloudLeadOnCodex({
          ok: false,
          reason: "no cloud Codex login is saved (cloud secret codex_auth_json)",
          transient: false,
        });
        assert.deepStrictEqual(targets, [PLAN, PLAN]);
        assert.deepStrictEqual(roleModels, { implement: PLAN, fix: PLAN, review: PLAN });
      }),
  );

  it.effect("moves only the current step when the cloud Codex login is busy elsewhere", () =>
    Effect.gen(function* () {
      const { targets, roleModels } = yield* cloudLeadOnCodex({
        ok: false,
        reason: "another cloud sandbox is using the cloud Codex login",
        transient: true,
      });
      assert.deepStrictEqual(targets, [PLAN, PLAN]);
      assert.deepStrictEqual(roleModels, {});
    }),
  );
});
