import {
  EnvironmentId,
  ProjectId,
  type ProjectTaskCard,
  ProjectTaskId,
  type ProjectTeamMessageTaskInput,
  ThreadId,
} from "@t3tools/contracts";
import {
  resolveComposerDispatchMode,
  threadFollowUpBehavior,
  type ComposerDispatchMode,
} from "@t3tools/client-runtime/state/composer-dispatch";
import { AsyncResult } from "effect/reactivity";
import { act, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { PM_TASK_STRIP_COLLAPSED_STORAGE_KEY, PmTaskStrip } from "./PmTaskStrip";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");
const STARTED_AT = new Date(Date.now() - 5 * 60_000).toISOString();

function taskCard(number: number, title: string, overrides: Partial<ProjectTaskCard> = {}) {
  return {
    id: ProjectTaskId.make(`task-${number}`),
    number,
    title,
    stage: "running",
    leadThreadId: ThreadId.make(`lead-${number}`),
    latestUpdate: { text: "Wrote the failing test", at: STARTED_AT },
    lastDirectMessage: null,
    ...overrides,
  } satisfies ProjectTaskCard;
}

/**
 * The server side: the task cards the attention stream carries and the messages the leads got.
 * Simulated: the RPC is mocked at the useMessageTask boundary; like the real server it records
 * the message and then pushes a summary whose card carries it as lastDirectMessage.
 */
const server = vi.hoisted(() => ({
  taskCards: [] as ProjectTaskCard[],
  listeners: new Set<() => void>(),
  calls: [] as ProjectTeamMessageTaskInput[],
  fail: false,
  release: null as (() => void) | null,
}));

function publish(taskCards: ProjectTaskCard[]) {
  server.taskCards = taskCards;
  for (const listener of server.listeners) listener();
}

async function messageTask(input: ProjectTeamMessageTaskInput) {
  server.calls.push(input);
  await new Promise<void>((resolve) => {
    server.release = resolve;
  });
  if (server.fail) return AsyncResult.failure(new Error("lead unreachable") as never);
  publish(
    server.taskCards.map((card) =>
      card.id === input.taskId
        ? { ...card, lastDirectMessage: { text: input.text, at: new Date().toISOString() } }
        : card,
    ),
  );
  return AsyncResult.success({});
}

vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  // The same function every render, like the real hook's stable command.
  useMessageTask: (() => MESSAGE_TASK) as never,
}));
const MESSAGE_TASK = (_environmentId: EnvironmentId, input: ProjectTeamMessageTaskInput) =>
  messageTask(input);

/** The strip as ChatComposer mounts it, fed by the (simulated) attention stream. */
function PmTasks() {
  const taskCards = useSyncExternalStore(
    (listener) => {
      server.listeners.add(listener);
      return () => server.listeners.delete(listener);
    },
    () => server.taskCards,
  );
  return (
    <PmTaskStrip environmentId={ENVIRONMENT_ID} projectId={PROJECT_ID} taskCards={taskCards} />
  );
}

const dispatched: ComposerDispatchMode[] = [];

/**
 * The composer's send path while the thread's turn is running. ChatComposer is too large to
 * mount here, so this composes what it uses: the real follow-up decision, the real dispatch
 * resolver for Enter / Mod+Enter, and the real send button that labels the action. The
 * running turn is simulated.
 */
function RunningComposer({
  isProjectManagerThread,
  setting,
}: {
  isProjectManagerThread: boolean;
  setting: "queue" | "steer";
}) {
  const [prompt, setPrompt] = useState("");
  const followUpBehavior = threadFollowUpBehavior(isProjectManagerThread, setting);
  const send = (alternateModifier: boolean) => {
    dispatched.push(
      resolveComposerDispatchMode({
        running: true,
        alternateModifier,
        activeTurnDefault: followUpBehavior,
        canSteer: true,
      }),
    );
    setPrompt("");
  };
  return (
    <div>
      <textarea
        aria-label="Composer"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          send(event.metaKey || event.ctrlKey);
        }}
      />
      <ComposerPrimaryActions
        compact={false}
        canOperateThread
        pendingAction={null}
        isRunning
        canInterrupt
        followUpBehavior={followUpBehavior}
        canSteer
        showPlanFollowUpPrompt={false}
        promptHasText={prompt.length > 0}
        isSendBusy={false}
        sendDisabledReason={null}
        isConnecting={false}
        isEnvironmentUnavailable={false}
        isPreparingWorktree={false}
        hasSendableContent={prompt.trim().length > 0}
        onSubmitMessage={(event) => {
          event.preventDefault();
          send(event.metaKey || event.ctrlKey);
        }}
        onPreviousPendingQuestion={() => {}}
        onInterrupt={() => {}}
        onImplementPlanInNewThread={() => {}}
      />
    </div>
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.removeItem(PM_TASK_STRIP_COLLAPSED_STORAGE_KEY);
  server.taskCards = [
    taskCard(3, "Fix the login redirect"),
    taskCard(4, "Add CSV export", { stage: "in_review", latestUpdate: null }),
  ];
  server.calls = [];
  server.fail = false;
  server.release = null;
  dispatched.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  window.localStorage.removeItem(PM_TASK_STRIP_COLLAPSED_STORAGE_KEY);
  vi.unstubAllGlobals();
});

const cardEl = (taskId: string) =>
  container.querySelector<HTMLElement>(`[data-task-card="${taskId}"]`)!;
const leadInput = (title: string) =>
  container.querySelector<HTMLInputElement>(`input[aria-label="Message the lead of ${title}"]`)!;

async function typeAndEnter(input: HTMLElement, text: string) {
  await userEvent.click(input);
  await userEvent.keyboard(text);
  await act(async () => {
    await userEvent.keyboard("{Enter}");
  });
}

describe("the PM thread never blocks", () => {
  it("messages a task's lead from its card at once, while the PM turn runs", async () => {
    await act(() => root.render(<PmTasks />));

    expect(container.querySelector("[data-pm-task-strip]")?.textContent).toContain("Tasks · 2");
    const first = cardEl("task-3");
    expect(first.textContent).toContain("Fix the login redirect");
    expect(first.querySelector("[data-task-stage-chip]")?.textContent).toBe("running");
    expect(first.textContent).toContain("Wrote the failing test");
    expect(first.textContent).toContain("5m ago");
    expect(cardEl("task-4").querySelector("[data-task-stage-chip]")?.textContent).toBe("in review");

    // Whitespace alone sends nothing.
    await typeAndEnter(leadInput("Fix the login redirect"), "   ");
    expect(server.calls).toEqual([]);

    await act(async () => {
      await userEvent.clear(leadInput("Fix the login redirect"));
    });
    await typeAndEnter(leadInput("Fix the login redirect"), "Use the session cookie instead");

    // The message leaves right away; nothing waits on the PM's turn.
    expect(server.calls).toEqual([
      { projectId: PROJECT_ID, taskId: "task-3", text: "Use the session cookie instead" },
    ]);
    expect(leadInput("Fix the login redirect").disabled).toBe(true);

    await act(async () => server.release!());

    expect(leadInput("Fix the login redirect").value).toBe("");
    expect(leadInput("Fix the login redirect").disabled).toBe(false);
    expect(server.taskCards[0]!.lastDirectMessage?.text).toBe("Use the session cookie instead");
    expect(cardEl("task-3").querySelector("[data-task-last-message]")?.textContent).toBe(
      "You · just now:Use the session cookie instead",
    );
    // Only that task's card changed.
    expect(cardEl("task-4").querySelector("[data-task-last-message]")).toBeNull();
  });

  it("keeps the text when the send fails", async () => {
    server.fail = true;
    await act(() => root.render(<PmTasks />));

    await typeAndEnter(leadInput("Add CSV export"), "Ship it behind a flag");
    await act(async () => server.release!());

    expect(leadInput("Add CSV export").value).toBe("Ship it behind a flag");
    expect(leadInput("Add CSV export").disabled).toBe(false);
    expect(cardEl("task-4").querySelector("[data-task-last-message]")).toBeNull();
  });

  it("collapses from its header, remembers it, and hides with no tasks", async () => {
    await act(() => root.render(<PmTasks />));
    const header = () =>
      container.querySelector<HTMLButtonElement>("[data-pm-task-strip] button[aria-expanded]")!;

    await act(async () => {
      await userEvent.click(header());
    });
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-task-card]")).toBeNull();

    // A fresh mount (another visit to the PM thread) stays collapsed.
    await act(() => root.unmount());
    root = createRoot(container);
    await act(() => root.render(<PmTasks />));
    expect(header().getAttribute("aria-expanded")).toBe("false");

    await act(() => publish([]));
    expect(container.querySelector("[data-pm-task-strip]")).toBeNull();
  });

  it("steers into the running PM turn on Enter and queues on Mod+Enter", async () => {
    // The user's global setting is "queue"; the PM thread steers anyway.
    await act(() => root.render(<RunningComposer isProjectManagerThread setting="queue" />));
    const composer = container.querySelector<HTMLTextAreaElement>("textarea")!;

    await typeAndEnter(composer, "Also check the mobile flow");
    expect(dispatched).toEqual(["steer"]);

    await userEvent.click(composer);
    await userEvent.keyboard("Hold this for later");
    expect(container.querySelector('[aria-label="Steer message"]')).not.toBeNull();
    await act(async () => {
      await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    });
    expect(dispatched).toEqual(["steer", "queue"]);
  });

  it("leaves other threads on the user's setting", async () => {
    await act(() =>
      root.render(<RunningComposer isProjectManagerThread={false} setting="queue" />),
    );
    const composer = container.querySelector<HTMLTextAreaElement>("textarea")!;

    await userEvent.click(composer);
    await userEvent.keyboard("Next step");
    expect(container.querySelector('[aria-label="Queue message"]')).not.toBeNull();
    await act(async () => {
      await userEvent.keyboard("{Enter}");
    });
    expect(dispatched).toEqual(["queue"]);
  });
});
