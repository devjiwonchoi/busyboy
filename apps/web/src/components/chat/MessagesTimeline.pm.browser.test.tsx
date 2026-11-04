import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { act, createRef, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { MessagesTimeline } from "./MessagesTimeline";

const PM_THREAD_ID = "pm-thread";

vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerForThread: ((ref: { threadId: string } | null) =>
    ref?.threadId === PM_THREAD_ID
      ? { persona: { name: "Juniper", avatar: { kind: "emoji", emoji: "🦊" } } }
      : null) as never,
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

async function renderTimeline(threadId: string) {
  container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<MessagesTimeline {...baseProps(threadId)} timelineEntries={entries} />),
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
