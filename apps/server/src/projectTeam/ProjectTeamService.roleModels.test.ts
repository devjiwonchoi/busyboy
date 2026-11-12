import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_TASK_STEP_MODELS,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import {
  createAcceptedTask,
  PROJECT_ID,
  SECOND_PROJECT_ID,
  setUpManager,
  setUpWorkspace,
  startLead,
  type TeamHarness,
  withTeam,
} from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;
const claude = ProviderInstanceId.make("claude-work");
const codex = ProviderInstanceId.make("codex");
const APP = DEFAULT_PROJECT_TASK_STEP_MODELS;
const medium = [{ id: "reasoningEffort", value: "medium" }];
const low = [{ id: "reasoningEffort", value: "low" }];
const lastTarget = (harness: Pick<TeamHarness, "delegated">) =>
  Effect.map(Ref.get(harness.delegated), (all) => all.at(-1)?.target);

const stepLog = (
  taskId: Parameters<
    ProjectTeamRepository.ProjectTeamRepository["Service"]["listTaskEvents"]
  >[0]["taskId"],
) =>
  Effect.flatMap(ProjectTeamRepository.ProjectTeamRepository, (repository) =>
    repository.listTaskEvents({ taskId, limit: 50 }),
  ).pipe(
    Effect.map((events) =>
      events.filter((event) => event.kind === "model_step").map((event) => event.body),
    ),
  );

describe("ProjectTeamService role models", () => {
  it.effect("starts the lead on the plan model and hands steps to their models", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const saved = yield* team.updateSettings({
          projectId: PROJECT_ID,
          roleModels: {
            plan: { providerInstanceId: claude, model: "claude-opus-5-5" },
            implement: { providerInstanceId: codex, model: "gpt-5.5", options: medium },
            fix: { providerInstanceId: codex, model: "gpt-5.5", options: low },
          },
        });
        // The thinking level is stored, not dropped.
        assert.deepStrictEqual(saved.settings.roleModels?.implement?.options, medium);

        const { task, leadThreadId } = yield* startLead(pm, "Add hello.sh", harness.delegate);
        const leadCall = (yield* Ref.get(harness.delegated)).at(-1);
        assert.deepStrictEqual(leadCall?.target, {
          providerInstanceId: claude,
          model: "claude-opus-5-5",
        });
        assert.include(leadCall?.task ?? "", "## Models per role");
        assert.include(leadCall?.task ?? "", "codex · gpt-5.5 · medium (project default)");
        assert.deepStrictEqual(task.modelSteps.plan?.providerInstanceId, claude);

        const implement = yield* team.delegateStep(
          leadThreadId,
          { role: "implement", task: "Build t1: write hello.sh and its test." },
          harness.delegate,
        );
        assert.strictEqual(implement.providerInstanceId, codex);
        const implementCall = (yield* Ref.get(harness.delegated)).at(-1);
        assert.deepStrictEqual(implementCall?.target, {
          providerInstanceId: codex,
          model: "gpt-5.5",
          options: medium,
        });
        assert.strictEqual(implementCall?.role, "implementation");

        yield* team.delegateStep(leadThreadId, { role: "fix", task: "Fix it." }, harness.delegate);
        assert.deepStrictEqual(yield* lastTarget(harness), {
          providerInstanceId: codex,
          model: "gpt-5.5",
          options: low,
        });

        // The project sets no review model, so review runs on the app's review step.
        yield* team.delegateStep(
          leadThreadId,
          { role: "review", task: "Review main...HEAD against the criteria." },
          harness.delegate,
        );
        const reviewCall = (yield* Ref.get(harness.delegated)).at(-1);
        assert.deepStrictEqual(reviewCall?.target, APP.review);
        assert.strictEqual(reviewCall?.role, "review");

        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const stored = Option.getOrThrow(yield* repository.getTask(task.id));
        assert.deepStrictEqual(
          {
            plan: stored.modelSteps.plan?.model,
            implement: stored.modelSteps.implement?.model,
            review: stored.modelSteps.review?.model,
          },
          { plan: "claude-opus-5-5", implement: "gpt-5.5", review: APP.review.model },
        );
        assert.deepStrictEqual((yield* stepLog(task.id)).slice(0, 2), [
          "plan → claude-work · claude-opus-5-5",
          "implement → codex · gpt-5.5",
        ]);
      }),
    ),
  );

  it.effect("lets a task's own models win over the project's, and clears them", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        yield* team.updateSettings({
          projectId: PROJECT_ID,
          roleModels: { implement: { providerInstanceId: codex, model: "gpt-5.5" } },
        });
        const { task: created } = yield* createAcceptedTask(pm, {
          title: "Add hello.sh",
          request: "Add hello.sh.",
          intake: "New work.",
        });
        const detail = yield* team.setTaskRoleModels({
          projectId: PROJECT_ID,
          taskId: created.id,
          roleModels: {
            plan: { providerInstanceId: codex, model: "gpt-5.5" },
            implement: { providerInstanceId: claude, model: "claude-sonnet-5-5", options: medium },
          },
        });
        assert.deepStrictEqual(detail.task.roleModels.implement?.options, medium);

        // The PM's own pick loses to the plan model.
        const { leadThreadId } = yield* team.startTask(
          pm,
          { taskId: created.id, target: { providerInstanceId: claude, model: "claude-haiku-5-5" } },
          harness.delegate,
        );
        assert.deepStrictEqual(yield* lastTarget(harness), {
          providerInstanceId: codex,
          model: "gpt-5.5",
        });

        yield* team.delegateStep(leadThreadId, { role: "implement", task: "t1" }, harness.delegate);
        assert.deepStrictEqual(yield* lastTarget(harness), {
          providerInstanceId: claude,
          model: "claude-sonnet-5-5",
          options: medium,
        });

        // Clearing the task's override falls back to the project default.
        yield* team.setTaskRoleModels({
          projectId: PROJECT_ID,
          taskId: created.id,
          roleModels: { implement: null },
        });
        yield* team.delegateStep(leadThreadId, { role: "implement", task: "t2" }, harness.delegate);
        assert.deepStrictEqual(yield* lastTarget(harness), {
          providerInstanceId: codex,
          model: "gpt-5.5",
        });

        // Clearing the project default falls back to the app's implement step.
        const cleared = yield* team.updateSettings({
          projectId: PROJECT_ID,
          roleModels: { implement: null },
        });
        assert.strictEqual(cleared.settings.roleModels, undefined);
        yield* team.delegateStep(leadThreadId, { role: "implement", task: "t3" }, harness.delegate);
        assert.deepStrictEqual(yield* lastTarget(harness), APP.implement);
      }),
    ),
  );

  it.effect("runs every project on the app's step models and their thinking levels", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const settings = yield* ServerSettings.ServerSettingsService;
        const { secondPm } = yield* setUpWorkspace(harness);

        // Out of the box: plan Opus 5.5 Extra High, implement GPT-6.1-Sol Medium, review High.
        assert.deepStrictEqual((yield* settings.getSettings).taskStepModels, APP);
        assert.deepStrictEqual(APP.plan.options, [{ id: "effort", value: "xhigh" }]);
        assert.deepStrictEqual(APP.implement, {
          providerInstanceId: codex,
          model: "gpt-6.1-sol",
          options: medium,
        });
        assert.deepStrictEqual(APP.review.options, [{ id: "effort", value: "high" }]);

        // Changing one step replaces it whole and keeps the others.
        const implement = { providerInstanceId: codex, model: "gpt-6.1-sol", options: low };
        yield* settings.updateSettings({ taskStepModels: { implement } });
        assert.deepStrictEqual((yield* settings.getSettings).taskStepModels, {
          ...APP,
          implement,
        });
        const plan = { providerInstanceId: claude, model: "claude-opus-5-5" };
        yield* settings.updateSettings({ taskStepModels: { plan } });
        assert.deepStrictEqual((yield* settings.getSettings).taskStepModels.plan, plan);
        yield* settings.updateSettings({ taskStepModels: { plan: APP.plan } });

        // A project with no role models of its own runs on them.
        const { task, leadThreadId } = yield* startLead(secondPm, "Add page", harness.delegate);
        assert.strictEqual(task.projectId, SECOND_PROJECT_ID);
        const leadCall = (yield* Ref.get(harness.delegated)).at(-1);
        assert.deepStrictEqual(leadCall?.target, APP.plan);
        assert.include(leadCall?.task ?? "", "claude-opus-5-5 · xhigh (app default)");

        yield* team.delegateStep(leadThreadId, { role: "implement", task: "t1" }, harness.delegate);
        assert.deepStrictEqual(yield* lastTarget(harness), implement);
        // Fix follows implement.
        yield* team.delegateStep(leadThreadId, { role: "fix", task: "f1" }, harness.delegate);
        assert.deepStrictEqual(yield* lastTarget(harness), implement);
        yield* team.delegateStep(leadThreadId, { role: "review", task: "r1" }, harness.delegate);
        assert.deepStrictEqual(yield* lastTarget(harness), APP.review);
      }),
    ),
  );

  it.effect("falls back to the lead's model when an app step's provider is not set up", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        // Only Claude is set up here; the app's implement step names Codex.
        harness.providers.push({
          instanceId: APP.plan.providerInstanceId,
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5" }],
        } as unknown as ServerProvider);
        const { leadThreadId } = yield* startLead(pm, "Add hello.sh", harness.delegate);
        assert.deepStrictEqual(yield* lastTarget(harness), APP.plan);
        yield* team.delegateStep(leadThreadId, { role: "implement", task: "t1" }, harness.delegate);
        assert.strictEqual(yield* lastTarget(harness), undefined);
        yield* team.delegateStep(leadThreadId, { role: "fix", task: "f1" }, harness.delegate);
        assert.strictEqual(yield* lastTarget(harness), undefined);
        yield* team.delegateStep(leadThreadId, { role: "review", task: "r1" }, harness.delegate);
        assert.deepStrictEqual(yield* lastTarget(harness), APP.review);
      }),
    ),
  );

  it.effect("lets the PM set role models and refuses task_delegate to anyone but a lead", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const result = yield* team.updateSettingsAsManager(pm, {
          roleModels: { review: { providerInstanceId: claude, model: "claude-opus-5-5" } },
        });
        assert.deepStrictEqual(result.settings.roleModels, {
          review: { providerInstanceId: claude, model: "claude-opus-5-5" },
        });
        const refused = yield* team
          .delegateStep(pm, { role: "review", task: "Review it." }, harness.delegate)
          .pipe(Effect.flip);
        assert.include(refused.message, "task_delegate");
      }),
    ),
  );
});
