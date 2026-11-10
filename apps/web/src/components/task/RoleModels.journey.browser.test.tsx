import "~/index.css";

import {
  approvalPlanOf,
  emptyProjectTaskSpec,
  EnvironmentId,
  newProjectTaskTodo,
  PLAN_APPROVAL_START,
  ProjectAttentionBatchId,
  ProjectAttentionItemId,
  type ProjectDecisionCard,
  ProjectId,
  ProjectTaskId,
  type ProjectTaskModelSteps,
  type ProjectTaskReference,
  type ProjectTaskRoleModels,
  type ProjectTeamAttentionSummary,
  type ProjectTeamSetTaskRoleModelsInput,
  type ProjectTeamTaskDetail,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const PROJECT_ID = ProjectId.make("project-1");
const TASK_ID = ProjectTaskId.make("task-7");
const CODEX = ProviderInstanceId.make("codex");
const AT = "2026-11-07T03:00:00.000Z";

/** The server: the PM summary, the task's detail, and the writes the UI sent. */
const server = vi.hoisted(() => ({
  summary: null as unknown as ProjectTeamAttentionSummary,
  detail: null as unknown as ProjectTeamTaskDetail,
  listeners: new Set<() => void>(),
  settingsPatches: [] as unknown[],
  taskPatches: [] as ProjectTeamSetTaskRoleModelsInput[],
  providers: [] as ServerProvider[],
}));

function publish() {
  for (const listener of server.listeners) listener();
}

function useServer<T>(read: () => T): T {
  return useSyncExternalStore((listener) => {
    server.listeners.add(listener);
    return () => server.listeners.delete(listener);
  }, read);
}

function applyPatch(
  current: ProjectTaskRoleModels,
  patch: Record<string, unknown>,
): ProjectTaskRoleModels {
  const next: Record<string, unknown> = { ...current };
  for (const [role, value] of Object.entries(patch)) {
    if (value === null) delete next[role];
    else next[role] = value;
  }
  return next as ProjectTaskRoleModels;
}

vi.mock(import("../../state/projectTeam"), async (original) => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    ...(await original()),
    useProjectManager: (() => useServer(() => server.summary)) as never,
    useProjectManagerEntries: (() => {
      const summary = useServer(() => server.summary);
      return [{ environmentId: ENVIRONMENT_ID, summary }];
    }) as never,
    useTaskDetail: (() => {
      const detail = useServer(() => server.detail);
      return { data: detail, error: null, isPending: false, isSuccess: true } as never;
    }) as never,
    // Mirrors the server: it stores the patch and pushes the next summary.
    useUpdateTeamSettings: (() =>
      async (
        _ref: unknown,
        patch: { roleModels?: Record<string, unknown>; mergeOwner?: "pm" | "user" },
      ) => {
        server.settingsPatches.push(patch);
        server.summary = {
          ...server.summary,
          settings: {
            ...server.summary.settings,
            ...(patch.roleModels === undefined
              ? {}
              : {
                  roleModels: applyPatch(
                    server.summary.settings.roleModels ?? {},
                    patch.roleModels,
                  ),
                }),
            ...(patch.mergeOwner === undefined ? {} : { mergeOwner: patch.mergeOwner }),
          },
        };
        publish();
        return AsyncResult.success(undefined);
      }) as never,
    useSetTaskRoleModels: (() =>
      async (_env: unknown, input: ProjectTeamSetTaskRoleModelsInput) => {
        server.taskPatches.push(input);
        server.detail = {
          ...server.detail,
          task: {
            ...server.detail.task,
            roleModels: applyPatch(server.detail.task.roleModels, input.roleModels),
          },
        };
        publish();
        return AsyncResult.success(server.detail);
      }) as never,
    useAnswerDecision: (() => async () => AsyncResult.success(undefined)) as never,
  };
});

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => [ENVIRONMENT_ID]) as never,
  useEnvironmentProviders: (() => new Map([[ENVIRONMENT_ID, server.providers]])) as never,
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  Link: (({ params, to: _to, ...rest }: { params?: { taskId?: string }; to?: string }) => (
    <a href={`#${params?.taskId ?? ""}`} {...rest} />
  )) as never,
}));

import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import { PlanApprovalCard } from "../chat/PlanApprovalCard";
import { ProjectManagerSettingsSection } from "../settings/ProjectManagerSettings";
import { TaskPlan } from "./TaskPlan";

const projectRef = { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID };

const model = (slug: string, name: string) => ({
  slug,
  name,
  isCustom: false,
  capabilities: null,
});

const codexProvider: ServerProvider = {
  instanceId: CODEX,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: AT,
  models: [model("gpt-5.5", "GPT-5.5"), model("gpt-5.4", "GPT-5.4")],
  slashCommands: [],
  skills: [],
};

const STEPS: ProjectTaskModelSteps = {
  plan: { providerInstanceId: CODEX, model: "gpt-5.4", at: AT },
  implement: { providerInstanceId: CODEX, model: "gpt-5.5", at: AT },
};

function taskRef(stage: ProjectTaskReference["stage"]): ProjectTaskReference {
  return {
    id: TASK_ID,
    number: 7,
    parentTaskId: null,
    waitsOn: [],
    title: "Fix drag scroll",
    stage,
    leadThreadId: null,
    prUrl: null,
    lastOutcome: null,
    openQuestion: false,
    openBlocker: false,
    iterateRound: 0,
    shipRound: 0,
    modelSteps: STEPS,
    updatedAt: AT,
  };
}

const spec = {
  ...emptyProjectTaskSpec(),
  summary: "Keep the scroll position while dragging.",
  goal: "Keep the scroll position.",
  todos: [
    newProjectTaskTodo("t1", "Add a journey test"),
    newProjectTaskTodo("t2", "Keep scrollTop"),
  ],
};

function makeDetail(): ProjectTeamTaskDetail {
  return {
    key: "T-7",
    task: {
      id: TASK_ID,
      projectId: PROJECT_ID,
      number: 7,
      title: "Fix drag scroll",
      request: "The list jumps.",
      stage: "running",
      waitsOn: [],
      parentTaskId: null,
      leadThreadId: null,
      prUrl: null,
      planSummary: null,
      resultSummary: null,
      lastOutcome: null,
      nudgeCount: 0,
      iterateRound: 0,
      shipRound: 0,
      review: null,
      roleModels: {},
      modelSteps: STEPS,
      stageChangedAt: AT,
      createdAt: AT,
      updatedAt: AT,
    },
    versions: [
      {
        taskId: TASK_ID,
        version: 1,
        spec,
        author: "agent",
        authorThreadId: null,
        note: "Plan",
        createdAt: AT,
      },
    ],
    sessions: [],
    children: [],
    openAttention: [],
  } as unknown as ProjectTeamTaskDetail;
}

const planCard: ProjectDecisionCard = {
  taskNumber: 7,
  taskTitle: "Fix drag scroll",
  plan: approvalPlanOf(spec),
  item: {
    id: ProjectAttentionItemId.make("attention-plan"),
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    kind: "approval",
    question: "Plan for drag scroll.",
    options: [PLAN_APPROVAL_START],
    answer: PLAN_APPROVAL_START,
    answeredAt: AT,
    askerThreadId: ThreadId.make("lead-7"),
    batchId: ProjectAttentionBatchId.make("batch-plan"),
    createdAt: AT,
    supersededAt: null,
    answeredBy: "user",
    specVersion: 1,
    summary: null,
    verification: null,
  },
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  server.providers = [codexProvider];
  server.summary = makeProjectManagerSummaryFixture({ tasks: [taskRef("running")] });
  server.detail = makeDetail();
  server.settingsPatches = [];
  server.taskPatches = [];
  container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "width: 100%; padding: 12px; box-sizing: border-box;";
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const byLabel = <T extends HTMLElement>(label: string) =>
  document.querySelector<T>(`[aria-label="${label}"]`);

/** Opens a role's picker and chooses a model from it, as the user does. */
async function chooseModel(trigger: HTMLElement, name: string) {
  await userEvent.click(trigger);
  const option = await vi.waitFor(() => {
    const match = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) =>
      element.textContent?.includes(name),
    );
    expect(match, `option ${name}`).toBeDefined();
    return match!;
  });
  await userEvent.click(option);
  // The picker closes once a model is chosen.
  await vi.waitFor(() => expect(document.querySelector("[data-model-picker-content]")).toBeNull());
}

function expectInside(element: Element, outer: Element) {
  const rect = element.getBoundingClientRect();
  const bounds = outer.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
  expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
}

for (const viewport of [
  { name: "desktop", width: 1100, height: 800 },
  { name: "phone", width: 390, height: 844 },
]) {
  describe(`models per role (${viewport.name})`, () => {
    beforeEach(async () => {
      await page.viewport(viewport.width, viewport.height);
    });

    it("picks the project's Implement model in settings and clears it", async () => {
      function Settings() {
        const summary = useServer(() => server.summary);
        return <ProjectManagerSettingsSection projectRef={projectRef as never} summary={summary} />;
      }
      await act(async () => root.render(<Settings />));
      const rows = [...container.querySelectorAll<HTMLElement>("[data-role-model]")];
      expect(rows.map((row) => row.dataset.roleModel)).toEqual([
        "plan",
        "implement",
        "review",
        "fix",
      ]);
      expect(container.textContent).toContain("Models per role");
      const implement = byLabel("Implement model")!;
      expect(implement.textContent).toContain("Lead's model");
      expectInside(implement, container);

      await chooseModel(implement, "GPT-5.4");
      expect(server.settingsPatches).toEqual([
        { roleModels: { implement: { providerInstanceId: CODEX, model: "gpt-5.4" } } },
      ]);
      await vi.waitFor(() => expect(byLabel("Implement model")!.textContent).toContain("GPT-5.4"));
      expect(byLabel("Review model")!.textContent).toContain("Lead's model");

      await userEvent.click(byLabel("Use the lead's model for implement")!);
      expect(server.settingsPatches.at(-1)).toEqual({ roleModels: { implement: null } });
      await vi.waitFor(() =>
        expect(byLabel("Implement model")!.textContent).toContain("Lead's model"),
      );
      expect(byLabel("Use the lead's model for implement")).toBeNull();
    });

    it("shows which model ran each step on the task page and overrides a role", async () => {
      server.summary = {
        ...server.summary,
        settings: {
          ...server.summary.settings,
          roleModels: { review: { providerInstanceId: CODEX, model: "gpt-5.5" } },
        },
      };
      await act(async () =>
        root.render(
          <TaskPlan environmentId={ENVIRONMENT_ID} projectId={PROJECT_ID} taskId={TASK_ID} />,
        ),
      );
      const section = await vi.waitFor(() => {
        const element = container.querySelector<HTMLElement>("[data-task-models]");
        expect(element).not.toBeNull();
        return element!;
      });
      expect(section.querySelector("[data-model-step='implement']")?.textContent).toBe(
        "구현 · GPT-5.5",
      );
      expect(section.querySelector("[data-model-step='plan']")?.textContent).toBe("계획 · GPT-5.4");
      expect(section.querySelector("[data-model-step='review']")).toBeNull();
      // Unset roles show what they fall back to: the project's model, else the lead's.
      expect(byLabel("리뷰 모델")!.textContent).toContain("GPT-5.5 · 프로젝트");
      expect(byLabel("수정 모델")!.textContent).toContain("리드 모델");
      expectInside(byLabel("수정 모델")!, container);

      await chooseModel(byLabel("수정 모델")!, "GPT-5.4");
      expect(server.taskPatches).toEqual([
        {
          projectId: PROJECT_ID,
          taskId: TASK_ID,
          roleModels: { fix: { providerInstanceId: CODEX, model: "gpt-5.4" } },
        },
      ]);
      await vi.waitFor(() => expect(byLabel("수정 모델")!.textContent).toContain("GPT-5.4"));

      await userEvent.click(byLabel("수정 모델 지우기")!);
      expect(server.taskPatches.at(-1)).toEqual({
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        roleModels: { fix: null },
      });
      await vi.waitFor(() => expect(byLabel("수정 모델")!.textContent).toContain("리드 모델"));
    });

    it("shows each step's time, tokens and cost, and the task's total", async () => {
      server.detail = {
        ...server.detail,
        task: {
          ...server.detail.task,
          stepUsage: {
            plan: { durationMs: 6 * 60_000, runs: 1, inputTokens: 220_000, outputTokens: 9_000, costUsd: 0.9 },
            implement: {
              durationMs: 14 * 60_000,
              runs: 2,
              inputTokens: 1_200_000,
              outputTokens: 38_000,
              costUsd: 2.1,
            },
          },
          metrics: {
            size: "medium",
            reviewFindings: 3,
            fixRounds: 1,
            ciFailures: 0,
            memoryStallMs: 0,
          },
        },
      };
      await act(async () =>
        root.render(
          <TaskPlan environmentId={ENVIRONMENT_ID} projectId={PROJECT_ID} taskId={TASK_ID} />,
        ),
      );
      const section = await vi.waitFor(() => {
        const element = container.querySelector<HTMLElement>("[data-task-models]");
        expect(element).not.toBeNull();
        return element!;
      });
      const implement = section.querySelector<HTMLElement>("[data-model-step='implement']")!;
      expect(implement.textContent).toBe("구현 · GPT-5.5 · 14m ×2 · 1.2M/38k · $2.10");
      expect(section.querySelector("[data-model-step='plan']")?.textContent).toBe(
        "계획 · GPT-5.4 · 6m · 220k/9k · $0.90",
      );
      const total = section.querySelector<HTMLElement>("[data-task-usage-total]")!;
      expect(total.textContent).toBe(
        "합계 20m · 1.4M/47k 토큰 · 약 $3.00 · 리뷰 지적 3 · 수정 1회 · CI 실패 0 · 크기 중",
      );
      expectInside(implement, container);
      expectInside(total, container);
    });

    it("sets who merges in team settings and keeps it", async () => {
      function Settings() {
        const summary = useServer(() => server.summary);
        return <ProjectManagerSettingsSection projectRef={projectRef as never} summary={summary} />;
      }
      await act(async () => root.render(<Settings />));
      const group = byLabel("Who merges")!;
      expect(container.textContent).toContain("Who merges");
      expectInside(group, container);
      const option = (label: string) =>
        [...group.querySelectorAll<HTMLElement>("button")].find(
          (button) => button.textContent === label,
        )!;
      // No choice yet means the PM merges, as before.
      expect(option("PM").getAttribute("aria-pressed")).toBe("true");

      await userEvent.click(option("Me"));
      expect(server.settingsPatches).toEqual([{ mergeOwner: "user" }]);
      await vi.waitFor(() => expect(option("Me").getAttribute("aria-pressed")).toBe("true"));

      // Reopening the settings shows the saved choice.
      await act(async () => root.render(<div />));
      await act(async () => root.render(<Settings />));
      const reopened = [...byLabel("Who merges")!.querySelectorAll<HTMLElement>("button")].find(
        (button) => button.textContent === "Me",
      )!;
      expect(reopened.getAttribute("aria-pressed")).toBe("true");
    });

    it("shows the model per step on the plan card, live and once done", async () => {
      await act(async () =>
        root.render(<PlanApprovalCard card={planCard} environmentId={ENVIRONMENT_ID} />),
      );
      const card = container.querySelector<HTMLElement>("[data-plan-board]")!;
      const implement = await vi.waitFor(() => {
        const element = card.querySelector<HTMLElement>("[data-model-step='implement']");
        expect(element).not.toBeNull();
        return element!;
      });
      expect(implement.textContent).toBe("구현 · GPT-5.5");
      expect(card.querySelector("[data-model-step='plan']")?.textContent).toBe("계획 · GPT-5.4");
      expectInside(implement, card);
      // The steps sit under the phase badge.
      const phase = card.querySelector<HTMLElement>("[data-task-phase]")!;
      expect(implement.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        phase.getBoundingClientRect().bottom - 1,
      );

      await act(async () => {
        server.summary = { ...server.summary, tasks: [taskRef("done")] };
        publish();
      });
      await vi.waitFor(() =>
        expect(card.querySelector("[data-task-phase]")?.getAttribute("data-task-phase")).toBe(
          "done",
        ),
      );
      expect(card.querySelector("[data-model-step='implement']")?.textContent).toBe(
        "구현 · GPT-5.5",
      );
    });
  });
}
