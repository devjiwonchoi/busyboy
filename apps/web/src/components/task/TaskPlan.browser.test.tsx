import "~/index.css";

import type {
  ProjectTaskSpec,
  ProjectTeamTaskDetail,
  ProjectTeamUpdateTaskSpecInput,
} from "@t3tools/contracts";
import { emptyProjectTaskSpec, newProjectTaskTodo } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const AT = "2026-11-06T09:00:00.000Z";

const state = vi.hoisted(() => ({
  detail: null as unknown as ProjectTeamTaskDetail,
  listeners: new Set<() => void>(),
  updates: [] as ProjectTeamUpdateTaskSpecInput[],
  restores: [] as number[],
  splits: [] as string[],
}));

function publish() {
  for (const listener of state.listeners) listener();
}

/** Appends a version, like the server does after every write. */
function appendVersion(spec: ProjectTaskSpec, note: string) {
  const version = state.detail.versions.length + 1;
  state.detail = {
    ...state.detail,
    versions: [
      ...state.detail.versions,
      {
        taskId: state.detail.task.id,
        version,
        spec,
        author: "user",
        authorThreadId: null,
        note,
        createdAt: AT,
      },
    ],
  };
  publish();
}

vi.mock(import("../../state/projectTeam"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const { AsyncResult } = await import("effect/reactivity");
  const ok = () => Promise.resolve(AsyncResult.success(undefined) as never);
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
    useUpdateTaskSpec: (() => (_env: string, input: ProjectTeamUpdateTaskSpecInput) => {
      state.updates.push(input);
      appendVersion(input.spec, input.note ?? "Edited");
      return ok();
    }) as never,
    useRestoreTaskSpec: (() => (_env: string, input: { version: number }) => {
      state.restores.push(input.version);
      const source = state.detail.versions.find((v) => v.version === input.version)!;
      appendVersion(source.spec, `Restored v${input.version}`);
      return ok();
    }) as never,
    useSplitTaskTodo: (() => (_env: string, input: { todoId: string }) => {
      state.splits.push(input.todoId);
      const latest = state.detail.versions.at(-1)!.spec;
      appendVersion(
        {
          ...latest,
          todos: latest.todos.map((todo) =>
            todo.id === input.todoId ? { ...todo, subtaskId: "task-sub" as never } : todo,
          ),
        },
        "Split",
      );
      return ok();
    }) as never,
  };
});

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  Link: (({
    params,
    children,
    className,
  }: {
    params?: { taskId?: string };
    children?: React.ReactNode;
    className?: string;
  }) => (
    <a href={`#${params?.taskId ?? ""}`} className={className}>
      {children}
    </a>
  )) as never,
}));

import { TaskPlan } from "./TaskPlan";

let container: HTMLDivElement;
let root: Root;

const todo = (id: string, text: string) => newProjectTaskTodo(id, text);

beforeEach(() => {
  state.updates = [];
  state.restores = [];
  state.splits = [];
  state.detail = {
    key: "BB-7",
    task: {
      id: "task-7",
      projectId: "project-1",
      number: 7,
      title: "Fix drag scroll",
      request: "The list jumps.",
      stage: "planning",
      waitsOn: [],
      parentTaskId: null,
      leadThreadId: "lead-1",
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
        spec: {
          ...emptyProjectTaskSpec(),
          background: "The list jumps.",
          goal: "",
          successCriteria: "",
          nonGoals: "",
          todos: [],
        },
        author: "user",
        authorThreadId: null,
        note: "Created",
        createdAt: AT,
      },
      {
        taskId: "task-7",
        version: 2,
        spec: {
          ...emptyProjectTaskSpec(),
          background: "The list jumps.",
          goal: "Keep the scroll position.",
          successCriteria: "",
          nonGoals: "",
          todos: [todo("t1", "Add a journey test"), todo("t2", "Keep scrollTop")],
        },
        author: "agent",
        authorThreadId: "lead-1",
        note: "Plan",
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
});

function render() {
  return act(async () =>
    root.render(
      <div style={{ display: "flex", height: 800, width: "100%", maxWidth: 1200 }}>
        <TaskPlan
          environmentId={"env-1" as never}
          projectId={"project-1" as never}
          taskId={"task-7" as never}
        />
      </div>,
    ),
  );
}

const button = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("button,[role=option]")].find(
    (element) => element.textContent?.trim() === name,
  )!;

const header = () => container.querySelector<HTMLElement>('[data-testid="task-status"]')!;

describe("TaskPlan status", () => {
  it("shows the task's status, and Ask question once the task waits on the user", async () => {
    await render();
    expect(header().dataset.status).toBe("planning");
    expect(header().textContent).toBe("Planning");

    state.detail = {
      ...state.detail,
      openAttention: [
        {
          id: "attention-1",
          projectId: "project-1",
          taskId: "task-7",
          kind: "decision",
          question: "Which list library?",
          options: ["Keep ours", "Switch"],
          answer: null,
          answeredAt: null,
          askerThreadId: "lead-1",
          batchId: "batch-1",
          createdAt: AT,
          supersededAt: null,
          answeredBy: null,
        },
      ] as never,
    };
    await act(async () => publish());
    await vi.waitFor(() => expect(header().textContent).toBe("Ask question"));
  });

  it("shows an open PR as In Review even with an idle lead", async () => {
    state.detail = {
      ...state.detail,
      task: {
        ...state.detail.task,
        stage: "in_review",
        prUrl: "https://github.com/acme/busyboy/pull/81",
      },
    };
    await render();
    expect(header().textContent).toBe("In Review · PR #81");
  });

  it("shows a PR task as Ready once it passed the Ready gate", async () => {
    state.detail = {
      ...state.detail,
      task: {
        ...state.detail.task,
        stage: "in_review",
        prUrl: "https://github.com/acme/busyboy/pull/81",
        lastOutcome: "ready",
        ready: {
          head: "abc1234",
          gate: "checks",
          localChecks: "",
          readyAt: AT,
        },
      },
    };
    await render();
    expect(header().textContent).toBe("Ready · PR #81");
    const link = [...container.querySelectorAll("a")].find((a) => a.textContent === "Pull request");
    expect(link?.getAttribute("href")).toBe("https://github.com/acme/busyboy/pull/81");
  });

  it("marks a cloud task with a small Cloud pill next to its status", async () => {
    state.detail = { ...state.detail, task: { ...state.detail.task, location: "cloud" } };
    await render();
    const pill = container.querySelector<HTMLElement>('[data-cloud-badge="pill"]');
    expect(pill?.textContent).toBe("Cloud");
    expect(pill?.title).toBe("Runs in a cloud sandbox");
    expect(pill?.parentElement).toBe(header().parentElement);
  });

  it("shows no Cloud pill for a local task", async () => {
    state.detail = { ...state.detail, task: { ...state.detail.task, location: "local" } };
    await render();
    expect(header().textContent).toBe("Planning");
    expect(container.querySelector("[data-cloud-badge]")).toBeNull();
  });

  it("shows a finished task as Done and archived, at phone width too", async () => {
    await page.viewport(390, 844);
    state.detail = { ...state.detail, task: { ...state.detail.task, stage: "cancelled" } };
    await render();
    expect(header().textContent).toBe("Done · cancelled");
    expect(header().getBoundingClientRect().width).toBeGreaterThan(0);
    expect(container.textContent).toContain("Archived.");
  });
});

describe.each([
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
])("TaskPlan phase badge on $name", ({ width, height }) => {
  const phase = () => container.querySelector<HTMLElement>("[data-task-phase]");
  const withTask = (task: Partial<ProjectTeamTaskDetail["task"]>) => {
    state.detail = { ...state.detail, task: { ...state.detail.task, ...task } };
  };

  it("sits next to the status and follows the task from planning to done", async () => {
    await page.viewport(width, height);
    await render();
    expect(header().nextElementSibling).toBe(phase());
    expect(phase()?.textContent).toBe("계획");
    const box = container.getBoundingClientRect();
    expect(phase()!.getBoundingClientRect().right).toBeLessThanOrEqual(box.right + 0.5);

    withTask({ stage: "running", iterateRound: 3 });
    await act(async () => publish());
    await vi.waitFor(() => expect(phase()?.textContent).toBe("구현·리뷰 · 3회차"));

    // Ready comes from the server's Ready gate.
    withTask({
      stage: "in_review",
      shipRound: 2,
      prUrl: "https://github.com/acme/busyboy/pull/81",
      lastOutcome: "ready",
      ready: { head: "abc1234", gate: "checks", localChecks: "", readyAt: AT },
    });
    await act(async () => publish());
    await vi.waitFor(() => expect(phase()?.textContent).toBe("배포 준비됨 · 2회차"));
    expect(phase()?.dataset.taskPhaseTone).toBe("ready");

    withTask({ stage: "done" });
    await act(async () => publish());
    await vi.waitFor(() => expect(phase()?.textContent).toBe("완료"));

    withTask({ stage: "cancelled" });
    await act(async () => publish());
    await vi.waitFor(() => expect(phase()).toBeNull());
  });
});

describe("TaskPlan", () => {
  it("shapes a task's spec, browses versions, restores one and splits a todo", async () => {
    await render();
    const page = container.querySelector('[data-testid="task-plan"]')!;
    expect(page.textContent).toContain("BB-7");
    expect(page.textContent).toContain("Fix drag scroll");
    expect(page.textContent).toContain("Keep the scroll position.");
    // v2 added the goal and the todos, so they are marked as changed.
    expect(container.querySelectorAll("[data-changed]").length).toBe(3);

    // Check a todo: an edit on top of v2 with that todo flipped.
    await userEvent.click(container.querySelector('[aria-label="Add a journey test"]')!);
    await vi.waitFor(() => expect(state.updates).toHaveLength(1));
    expect(state.updates[0]?.baseVersion).toBe(2);
    expect(state.updates[0]?.spec.todos[0]?.done).toBe(true);
    expect(state.updates[0]?.note).toBe('Checked "Add a journey test"');

    // Add a todo.
    await userEvent.type(container.querySelector('[aria-label="New todo"]')!, "Run lint");
    await userEvent.click(button("Add"));
    await vi.waitFor(() => expect(state.updates).toHaveLength(2));
    expect(state.updates[1]?.baseVersion).toBe(3);
    expect(state.updates[1]?.spec.todos.map((t) => t.text)).toEqual([
      "Add a journey test",
      "Keep scrollTop",
      "Run lint",
    ]);

    // Edit the end result and success criteria.
    await userEvent.click(button("Edit"));
    const goal = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="End result"]')!;
    await userEvent.clear(goal);
    await userEvent.type(goal, "Dragging never jumps.");
    await userEvent.type(
      container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Success criteria"]')!,
      "No jump.",
    );
    await userEvent.click(button("Save"));
    await vi.waitFor(() => expect(state.updates).toHaveLength(3));
    expect(state.updates[2]?.spec.goal).toBe("Dragging never jumps.");
    expect(state.updates[2]?.spec.successCriteria).toBe("No jump.");
    expect(state.updates[2]?.note).toBe("Edited by the user");
    await vi.waitFor(() => expect(page.textContent).toContain("Dragging never jumps."));

    // Pick v1: read-only, then restore it as v6.
    await userEvent.click(container.querySelector('[aria-label="Spec version"]')!);
    await userEvent.click(
      await vi.waitFor(() => {
        const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find(
          (element) => element.textContent?.startsWith("v1 ·"),
        );
        if (option === undefined) throw new Error("v1 option not shown");
        return option;
      }),
    );
    await vi.waitFor(() => expect(page.textContent).toContain("Viewing v1 (Created). Read-only."));
    expect(container.querySelector('[aria-label="New todo"]')).toBeNull();
    await userEvent.click(button("Restore this version"));
    await vi.waitFor(() => expect(state.restores).toEqual([1]));
    await vi.waitFor(() => expect(page.textContent).not.toContain("Read-only."));
    expect(state.detail.versions.at(-1)?.note).toBe("Restored v1");

    // Back to a version with todos via History, restore it, then split a todo.
    expect(container.querySelector('[aria-label="Spec history"]')?.textContent).toContain(
      "Restored v1",
    );
    await userEvent.click(container.querySelector('[aria-label="View v5"]')!);
    await vi.waitFor(() => expect(page.textContent).toContain("Viewing v5"));
    await userEvent.click(button("Restore this version"));
    await vi.waitFor(() => expect(state.restores).toEqual([1, 5]));
    await vi.waitFor(() => expect(button("Split into task")).toBeDefined());
    await userEvent.click(button("Split into task"));
    await vi.waitFor(() => expect(state.splits).toEqual(["t2"]));
    await vi.waitFor(() => expect(page.textContent).toContain("Open subtask"));
    const history = container.querySelector('[aria-label="Spec history"]')!;
    expect(history.textContent).toContain("v8");
    expect(history.textContent).toContain("Agent · Plan");
  });
});
