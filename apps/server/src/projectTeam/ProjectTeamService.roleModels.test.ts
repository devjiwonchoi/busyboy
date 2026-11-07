import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ProjectTeamRepository from "../persistence/ProjectTeamRepository.ts";
import * as ProjectTeamService from "./ProjectTeamService.ts";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INSTANCE_ID,
  PROJECT_ID,
  setUpManager,
  startLead,
  withTeam,
} from "./testkit.ts";

const service = ProjectTeamService.ProjectTeamService;
const claude = ProviderInstanceId.make("claude-work");
const codex = ProviderInstanceId.make("codex");

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
        yield* team.updateSettings({
          projectId: PROJECT_ID,
          roleModels: {
            plan: { providerInstanceId: claude, model: "claude-opus-5-5" },
            implement: { providerInstanceId: codex, model: "gpt-5.5" },
            fix: { providerInstanceId: codex, model: "gpt-5.5" },
          },
        });

        const { task, leadThreadId } = yield* startLead(pm, "Add hello.sh", harness.delegate);
        const leadCall = (yield* Ref.get(harness.delegated)).at(-1);
        assert.deepStrictEqual(leadCall?.target, {
          providerInstanceId: claude,
          model: "claude-opus-5-5",
        });
        assert.include(leadCall?.task ?? "", "## Models per role");
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
        });
        assert.strictEqual(implementCall?.role, "implementation");
        assert.strictEqual(implementCall?.task, "Build t1: write hello.sh and its test.");

        // Review has no model, so it runs on the lead's own model: no target.
        yield* team.delegateStep(
          leadThreadId,
          { role: "review", task: "Review main...HEAD against the criteria." },
          harness.delegate,
        );
        const reviewCall = (yield* Ref.get(harness.delegated)).at(-1);
        assert.strictEqual(reviewCall?.target, undefined);
        assert.strictEqual(reviewCall?.role, "review");

        const repository = yield* ProjectTeamRepository.ProjectTeamRepository;
        const stored = Option.getOrThrow(yield* repository.getTask(task.id));
        assert.deepStrictEqual(
          {
            plan: stored.modelSteps.plan?.model,
            implement: stored.modelSteps.implement?.model,
            review: stored.modelSteps.review?.model,
            fix: stored.modelSteps.fix,
          },
          {
            plan: "claude-opus-5-5",
            implement: "gpt-5.5",
            review: DEFAULT_MODEL,
            fix: undefined,
          },
        );
        assert.deepStrictEqual(yield* stepLog(task.id), [
          "plan → claude-work · claude-opus-5-5",
          "implement → codex · gpt-5.5",
          `review → ${DEFAULT_PROVIDER_INSTANCE_ID} · ${DEFAULT_MODEL}`,
        ]);

        const summary = (yield* team.attentionSnapshot).projects.find(
          (project) => project.projectId === PROJECT_ID,
        );
        assert.strictEqual(
          summary?.tasks.find((reference) => reference.id === task.id)?.modelSteps.implement?.model,
          "gpt-5.5",
        );
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
        const { task: created } = yield* team.createTask(pm, {
          intake: "New work.",
          title: "Add hello.sh",
          request: "Add hello.sh.",
        });
        const detail = yield* team.setTaskRoleModels({
          projectId: PROJECT_ID,
          taskId: created.id,
          roleModels: {
            plan: { providerInstanceId: codex, model: "gpt-5.5" },
            implement: { providerInstanceId: claude, model: "claude-sonnet-5-5" },
          },
        });
        assert.deepStrictEqual(detail.task.roleModels.implement?.model, "claude-sonnet-5-5");

        // The PM's own pick loses to the plan model.
        const { leadThreadId } = yield* team.startTask(
          pm,
          { taskId: created.id, target: { providerInstanceId: claude, model: "claude-haiku-5-5" } },
          harness.delegate,
        );
        assert.deepStrictEqual((yield* Ref.get(harness.delegated)).at(-1)?.target, {
          providerInstanceId: codex,
          model: "gpt-5.5",
        });

        yield* team.delegateStep(
          leadThreadId,
          { role: "implement", task: "Build t1." },
          harness.delegate,
        );
        assert.deepStrictEqual((yield* Ref.get(harness.delegated)).at(-1)?.target, {
          providerInstanceId: claude,
          model: "claude-sonnet-5-5",
        });

        // Clearing the task's override falls back to the project default.
        yield* team.setTaskRoleModels({
          projectId: PROJECT_ID,
          taskId: created.id,
          roleModels: { implement: null },
        });
        yield* team.delegateStep(
          leadThreadId,
          { role: "implement", task: "Build t2." },
          harness.delegate,
        );
        assert.deepStrictEqual((yield* Ref.get(harness.delegated)).at(-1)?.target, {
          providerInstanceId: codex,
          model: "gpt-5.5",
        });

        // Clearing the project default leaves the role on the lead's own model.
        const cleared = yield* team.updateSettings({
          projectId: PROJECT_ID,
          roleModels: { implement: null },
        });
        assert.strictEqual(cleared.settings.roleModels, undefined);
        yield* team.delegateStep(
          leadThreadId,
          { role: "implement", task: "Build t3." },
          harness.delegate,
        );
        assert.strictEqual((yield* Ref.get(harness.delegated)).at(-1)?.target, undefined);
      }),
    ),
  );

  it.effect("keeps the PM's pick and today's behavior when no role has a model", () =>
    withTeam((harness) =>
      Effect.gen(function* () {
        const team = yield* service;
        const pm = yield* setUpManager;
        const { task: created } = yield* team.createTask(pm, {
          intake: "New work.",
          title: "Add hello.sh",
          request: "Add hello.sh.",
        });
        yield* team.startTask(
          pm,
          { taskId: created.id, target: { providerInstanceId: claude, model: "claude-haiku-5-5" } },
          harness.delegate,
        );
        assert.deepStrictEqual((yield* Ref.get(harness.delegated)).at(-1)?.target, {
          providerInstanceId: claude,
          model: "claude-haiku-5-5",
        });
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
