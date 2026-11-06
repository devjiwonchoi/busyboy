import { EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { act, createRef, type ComponentProps, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { taskReferencesForThread } from "../../state/projectTeam.logic";
import { MessagesTimeline } from "./MessagesTimeline";

const PM_THREAD_ID = "pm-thread";

// Task numbers are per project: this project's #6 is the shortcut task.
const PROJECT_TASKS = {
  pmThreadId: ThreadId.make(PM_THREAD_ID),
  tasks: [
    {
      id: "task-6" as never,
      number: 6,
      parentTaskId: null,
      title: "Cmd+number shortcuts count the PM row first",
      stage: "running" as const,
      leadThreadId: ThreadId.make("lead-6"),
      prUrl: null,
      lastOutcome: null,
      openQuestion: false,
    },
    {
      id: "task-7" as never,
      number: 7,
      parentTaskId: null,
      title: "PM status covers every thread",
      stage: "planning" as const,
      leadThreadId: null,
      prUrl: null,
      lastOutcome: null,
      openQuestion: false,
    },
  ],
};

// One object for every render, like the real atom-backed summary.
const PROJECT_MANAGER = {
  persona: { name: "Juniper", avatar: { kind: "emoji", emoji: "🦊" } },
  decisionCards: [],
};

vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerForThread: ((ref: { threadId: string } | null) =>
    ref?.threadId === PM_THREAD_ID ? PROJECT_MANAGER : null) as never,
  useThreadTaskReferences: ((ref: { threadId: ThreadId } | null) =>
    taskReferencesForThread(PROJECT_TASKS, ref?.threadId ?? null)) as never,
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  Link: (({
    to: _to,
    params,
    ref,
    ...props
  }: {
    to: string;
    params: { environmentId: string; threadId: string };
    ref?: Ref<HTMLAnchorElement>;
    children?: ReactNode;
  }) => <a ref={ref} href={`/${params.environmentId}/${params.threadId}`} {...props} />) as never,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];
type Message = Extract<Entry, { kind: "message" }>["message"];

function baseProps(threadId: string): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:${threadId}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function message(id: string, text: string, overrides: Partial<Message> = {}): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
      ...overrides,
    },
  };
}

const SERVER = { createdBy: "system", creationSource: "server" } as const;
const SITREP_SINCE = "2026-03-17T18:00:00.000Z";

const entries: Entry[] = [
  message("stall", "1 task looks stalled: #4. Check team_status.", SERVER),
  message("reply-stall", "Pinged #4.", { role: "assistant" }),
  message(
    "project-team:sitrep:s1",
    `[Sitrep due] since ${SITREP_SINCE}. Call team_status(since) and post a 3–6 line sitrep.`,
    { ...SERVER, runId: RunId.make("run-sitrep") },
  ),
  message("sitrep-body", "Two tasks running, one waiting on review.", {
    role: "assistant",
    runId: RunId.make("run-sitrep"),
  }),
];

const roots: Root[] = [];
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function renderTimeline(threadId: string, timelineEntries: Entry[] = entries) {
  container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<MessagesTimeline {...baseProps(threadId)} timelineEntries={timelineEntries} />),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Two tasks running"));
}

describe("MessagesTimeline in a project manager thread", () => {
  it("shows server wakes as event lines, sitreps as cards, and the PM's name", async () => {
    await renderTimeline(PM_THREAD_ID);

    const lines = [...container.querySelectorAll<HTMLElement>("[data-pm-event-line]")];
    expect(lines.map((line) => line.getAttribute("role"))).toEqual(["note", "note"]);
    expect(lines.map((line) => line.textContent)).toEqual([
      "From BusyBoy: 1 task looks stalled: #4",
      "From BusyBoy: Sitrep",
    ]);
    expect(container.textContent).not.toContain("Sent by BusyBoy");
    expect(container.textContent).not.toContain("Check team_status");

    const card = container.querySelector<HTMLElement>("[data-pm-sitrep-card]");
    expect(card?.getAttribute("aria-label")).toBe("Sitrep");
    expect(card?.textContent).toContain("Two tasks running, one waiting on review.");
    expect(card?.textContent).toMatch(/^Sitrep · since \S/);
    expect(card?.textContent).not.toContain("Pinged #4.");

    const authors = [...container.querySelectorAll<HTMLElement>("[data-pm-author]")];
    expect(authors.map((author) => author.textContent)).toEqual(["🦊Juniper", "🦊Juniper"]);
    expect(authors[0]?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Juniper");
    expect(authors.every((author) => author.checkVisibility())).toBe(true);
  });
});

describe("MessagesTimeline in a normal thread", () => {
  it("keeps server messages as attributed bubbles without PM decoration", async () => {
    await renderTimeline("normal-thread");

    expect(container.querySelectorAll("[data-user-message-attribution='t3code']").length).toBe(2);
    expect(container.textContent).toContain("Sent by BusyBoy");
    expect(container.textContent).toContain("1 task looks stalled: #4. Check team_status.");
    expect(container.querySelector("[data-pm-event-line]")).toBeNull();
    expect(container.querySelector("[data-pm-sitrep-card]")).toBeNull();
    expect(container.querySelector("[data-pm-author]")).toBeNull();
  });
});

describe("Task references in a project manager thread", () => {
  const withTaskReferences: Entry[] = [
    message("ask", "How is it going?"),
    message(
      "reply",
      "#6 is running and #7 is still planning. #99 is not a task, and `#6` stays code.",
      { role: "assistant" },
    ),
    message("sitrep-anchor", "Two tasks running.", { role: "assistant" }),
  ];

  it("shows each #N as a chip with the task's name, and its details on hover", async () => {
    await renderTimeline(PM_THREAD_ID, withTaskReferences);

    const chips = [...container.querySelectorAll<HTMLElement>("[data-task-reference-chip]")];
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "#6Cmd+number shortcuts count the PM row first",
      "#7PM status covers every thread",
    ]);
    // A started task opens its lead's thread; an unstarted one has nowhere to go yet.
    expect(chips[0]?.getAttribute("href")).toBe("/environment-local/lead-6");
    expect(chips[1]?.tagName).toBe("SPAN");
    expect(container.textContent).toContain("#99 is not a task");
    expect(container.querySelector("code")?.textContent).toBe("#6");

    await userEvent.hover(chips[0]!);
    await vi.waitFor(() => {
      const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
      expect(tooltip?.textContent).toContain("#6 Cmd+number shortcuts count the PM row first");
      expect(tooltip?.textContent).toContain("In Progress");
    });
  });

  it("leaves #N alone in threads outside the PM's team", async () => {
    await renderTimeline("normal-thread", withTaskReferences);

    expect(container.querySelector("[data-task-reference-chip]")).toBeNull();
    expect(container.textContent).toContain("#6 is running and #7 is still planning.");
  });
});
