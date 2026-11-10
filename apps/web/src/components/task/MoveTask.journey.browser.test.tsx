import "~/index.css";

import type {
  ExecutionLocation,
  ProjectTeamMoveTaskInput,
  ProjectTeamTaskDetail,
} from "@t3tools/contracts";
import { emptyProjectTaskSpec } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const AT = "2026-11-06T09:00:00.000Z";

const state = vi.hoisted(() => ({
  detail: null as unknown as ProjectTeamTaskDetail,
  listeners: new Set<() => void>(),
  moves: [] as ProjectTeamMoveTaskInput[],
  finishMove: null as null | ((result: unknown) => void),
  leadDriver: "claudeAgent",
}));

function publish() {
  for (const listener of state.listeners) listener();
}

function setTask(patch: Partial<ProjectTeamTaskDetail["task"]>) {
  state.detail = { ...state.detail, task: { ...state.detail.task, ...patch } };
  publish();
}

vi.mock(import("../../state/projectTeam"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original()),
    useTaskDetail: (() => {
      const detail = useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => state.detail,
      );
      return {
        data: detail,
        error: null,
        isPending: false,
        isSuccess: true,
        failure: null,
        dataUpdatedAt: 0,
        refresh: () => {},
      };
    }) as never,
    useProjectManager: (() => ({
      pmThreadId: "pm-thread",
      persona: { name: "Jota" },
      settings: {},
    })) as never,
    // The move resolves only when the test says the server finished.
    useMoveTask: (() => (_env: string, input: ProjectTeamMoveTaskInput) => {
      state.moves.push(input);
      return new Promise((resolve) => {
        state.finishMove = resolve;
      });
    }) as never,
  };
});

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadShell: ((ref: { threadId: string } | null) =>
    ref === null
      ? null
      : { id: ref.threadId, providerInstanceId: "lead-provider", runtime: null }) as never,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: (() =>
    new Map([
      ["env-1", [{ instanceId: "lead-provider", driver: state.leadDriver, models: [] }]],
    ])) as never,
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  Link: (({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  )) as never,
}));

import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { toastManager } from "../ui/toast";
import { TaskPlan } from "./TaskPlan";

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await page.viewport(900, 600);
  state.moves = [];
  state.finishMove = null;
  state.leadDriver = "claudeAgent";
  state.detail = {
    key: "BB-7",
    task: {
      id: "task-7",
      projectId: "project-1",
      number: 7,
      title: "Fix drag scroll",
      request: "The list jumps.",
      stage: "running",
      waitsOn: [],
      parentTaskId: null,
      leadThreadId: "lead-1",
      location: "local",
      moveTarget: null,
      prUrl: null,
      planSummary: null,
      resultSummary: null,
      lastOutcome: null,
      nudgeCount: 0,
      iterateRound: 0,
      shipRound: 0,
      roleModels: {},
      modelSteps: {},
      review: null,
      ready: null,
      stageChangedAt: AT,
      createdAt: AT,
      updatedAt: AT,
    },
    versions: [
      {
        taskId: "task-7",
        version: 1,
        spec: { ...emptyProjectTaskSpec(), background: "The list jumps." },
        author: "user",
        authorThreadId: null,
        note: "Created",
        createdAt: AT,
      },
    ],
    sessions: [{ taskId: "task-7", threadId: "lead-1", role: "lead", createdAt: AT }],
    children: [],
    openAttention: [],
  } as unknown as ProjectTeamTaskDetail;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function render() {
  return act(async () =>
    root.render(
      <div style={{ display: "flex", height: 600, width: "100%", padding: 16 }}>
        <TaskPlan
          environmentId={"env-1" as never}
          projectId={"project-1" as never}
          taskId={"task-7" as never}
        />
      </div>,
    ),
  );
}

const moveButton = () =>
  container.querySelector<HTMLButtonElement>("button[data-move-task]") ?? null;
const movingPill = () => container.querySelector<HTMLElement>('[data-move-task="moving"]');

async function expectButton(label: string, to: ExecutionLocation) {
  await vi.waitFor(
    () => {
      const button = moveButton();
      expect(button?.textContent).toBe(label);
      expect(button?.dataset.moveTask).toBe(to);
      expect(movingPill()).toBeNull();
    },
    { timeout: 3000 },
  );
  return moveButton()!;
}

async function expectPill(label: string) {
  await vi.waitFor(
    () => {
      expect(movingPill()?.textContent).toBe(label);
      expect(moveButton()).toBeNull();
    },
    { timeout: 3000 },
  );
}

it("moves a local lead to the cloud and back, showing a pill while it moves", async () => {
  await render();
  const toCloud = await expectButton("클라우드로 옮기기", "cloud");
  await page.screenshot({ path: "__screenshots__/move-task-local.png" });

  await userEvent.click(toCloud);
  expect(state.moves).toEqual([{ projectId: "project-1", taskId: "task-7", to: "cloud" }]);
  // The request is in flight, then the server marks the task moving.
  await expectPill("클라우드로 옮기는 중…");
  setTask({ moveTarget: "cloud" });
  await expectPill("클라우드로 옮기는 중…");
  await page.screenshot({ path: "__screenshots__/move-task-moving.png" });

  // The move finishes: the lead runs in the cloud and the button offers to bring it back.
  await act(async () => {
    setTask({ location: "cloud", moveTarget: null });
    state.finishMove!(AsyncResult.success(undefined));
  });
  const toLocal = await expectButton("로컬로 가져오기", "local");
  expect(container.querySelector('[data-cloud-badge="pill"]')).not.toBeNull();
  await page.screenshot({ path: "__screenshots__/move-task-cloud.png" });

  await userEvent.click(toLocal);
  expect(state.moves.at(-1)).toEqual({ projectId: "project-1", taskId: "task-7", to: "local" });
  await expectPill("로컬로 가져오는 중…");
});

it("shows the pill for a move already running when the page opens", async () => {
  setTask({ location: "cloud", moveTarget: "local" });
  await render();
  await expectPill("로컬로 가져오는 중…");
});

it("shows a quiet toast and the button again when the move fails", async () => {
  const toast = vi.spyOn(toastManager, "add");
  await render();
  await userEvent.click(await expectButton("클라우드로 옮기기", "cloud"));
  await expectPill("클라우드로 옮기는 중…");
  await act(async () => {
    state.finishMove!(AsyncResult.failure(Cause.fail(new Error("이미 옮기는 중이에요."))));
  });
  await expectButton("클라우드로 옮기기", "cloud");
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "error",
      title: "클라우드로 옮기지 못했어요",
      description: "이미 옮기는 중이에요.",
    }),
  );
});

it("disables the button for a finished task, with the reason on hover", async () => {
  setTask({ stage: "done" });
  await render();
  const button = await expectButton("클라우드로 옮기기", "cloud");
  expect(button.disabled).toBe(true);
  await userEvent.hover(button.parentElement!);
  await vi.waitFor(
    () => expect(document.body.textContent).toContain("끝난 태스크는 옮길 수 없어요"),
    { timeout: 3000 },
  );
  await page.screenshot({ path: "__screenshots__/move-task-disabled.png" });
  expect(state.moves).toEqual([]);
});

it("disables the button for a lead that is not Claude", async () => {
  state.leadDriver = "codex";
  await render();
  const button = await expectButton("클라우드로 옮기기", "cloud");
  expect(button.disabled).toBe(true);
  await userEvent.hover(button.parentElement!);
  await vi.waitFor(
    () => expect(document.body.textContent).toContain("Claude 리드만 옮길 수 있어요"),
    { timeout: 3000 },
  );
});
