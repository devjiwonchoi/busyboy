import { RegistryProvider } from "@effect/atom-react";
import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { act, createRef, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { MessagesTimeline } from "./MessagesTimeline";

// A user's thread after BusyBoy compacted it in the background: the timeline
// shows a small marker (no divider, no "/compact" bubble), hovering it explains
// what happened, and the context meter counts the compactions.

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const AT = "2026-11-06T10:00:00.000Z";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

let threadCount = 0;
function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  threadCount += 1;
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:compaction-${threadCount}`,
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

function message(id: string, role: "user" | "assistant", text: string, runId: string): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: AT,
    message: {
      id: MessageId.make(id),
      role,
      text,
      runId: RunId.make(runId),
      createdAt: AT,
      updatedAt: AT,
      streaming: false,
    },
  } as Entry;
}

function compaction(id: string, runId: string, label: string, running = false): Entry {
  return {
    id,
    kind: "work",
    createdAt: AT,
    entry: {
      id,
      createdAt: AT,
      runId: RunId.make(runId),
      label,
      tone: "info",
      itemType: "compaction",
      sourceActivityKind: "context-compaction",
      toolLifecycleStatus: running ? "inProgress" : "completed",
    },
  } as Entry;
}

const usage: ContextWindowSnapshot = {
  usedTokens: 31_000,
  totalProcessedTokens: null,
  maxTokens: 200_000,
  remainingTokens: 169_000,
  usedPercentage: 15.5,
  remainingPercentage: 84.5,
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  lastUsedTokens: null,
  lastInputTokens: null,
  lastCachedInputTokens: null,
  lastOutputTokens: null,
  lastReasoningOutputTokens: null,
  toolUses: null,
  durationMs: null,
  compactsAutomatically: null,
  autoCompactThreshold: null,
  cost: null,
  updatedAt: AT,
  compactionCount: 2,
} as ContextWindowSnapshot;

const roots: Root[] = [];
let container: HTMLDivElement;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function render(element: ReactElement) {
  container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height: 900px; width: 900px; display: flex; flex-direction: column;";
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<RegistryProvider>{element}</RegistryProvider>));
}

const openPopupText = () =>
  [...document.querySelectorAll('[data-slot="tooltip-popup"][data-open]')]
    .map((node) => node.textContent ?? "")
    .join("");

describe("quiet context compaction", () => {
  it("shows a background compaction as a small marker with details on hover and a count in the meter", async () => {
    await render(
      <>
        <MessagesTimeline
          {...baseProps()}
          timelineEntries={[
            message("m-1", "user", "Refactor the billing module", "run-1"),
            message("m-2", "assistant", "Done: split billing into three files.", "run-1"),
            message("context-care:compact:turn-1", "user", "/compact", "run-2"),
            compaction("compaction-1", "run-2", "Context compacted 182k → 31k tokens"),
            message("m-3", "user", "Now add tests", "run-3"),
          ]}
        />
        <ContextWindowMeter usage={usage} modelDisplayName="Claude" />
      </>,
    );

    // The conversation reads as if nothing happened: no divider, no "/compact" bubble.
    expect(container.textContent).toContain("Refactor the billing module");
    expect(container.textContent).toContain("Now add tests");
    expect(container.textContent).not.toContain("/compact");
    expect(container.textContent).not.toContain("Context compacted");
    expect(container.querySelector('[role="separator"]')).toBeNull();

    // Hovering the small marker explains what happened.
    const marker = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Context compacted 182k → 31k tokens"]',
    );
    expect(marker).not.toBeNull();
    await userEvent.hover(marker!);
    await vi.waitFor(() =>
      expect(openPopupText()).toContain("Context compacted 182k → 31k tokens"),
    );
    await userEvent.unhover(marker!);

    // The context meter says how often this thread has compacted.
    await userEvent.hover(
      container.querySelector<HTMLButtonElement>('button[aria-label^="Context window"]')!,
    );
    await vi.waitFor(() => expect(document.body.textContent).toContain("Compacted2 times"));
  });

  it("shows a running compaction only as a pulsing marker, without a working row", async () => {
    await render(
      <MessagesTimeline
        {...baseProps()}
        isWorking
        isCompacting
        activeTurnInProgress
        latestRun={{
          runId: RunId.make("run-2"),
          status: "running",
          startedAt: AT,
          completedAt: null,
        }}
        timelineEntries={[
          message("m-1", "user", "Refactor the billing module", "run-1"),
          message("m-2", "assistant", "Done.", "run-1"),
          message("context-care:compact:turn-1", "user", "/compact", "run-2"),
          compaction("compaction-1", "run-2", "Compacting context", true),
        ]}
      />,
    );

    expect(container.textContent).not.toContain("/compact");
    expect(container.textContent).not.toMatch(/Working|Compacting…/);
    expect(container.querySelector('[data-timeline-compaction-marker="active"]')).not.toBeNull();
    expect(container.querySelector('[role="separator"]')).toBeNull();
  });

  it("keeps a /compact the user typed visible", async () => {
    await render(
      <MessagesTimeline
        {...baseProps()}
        timelineEntries={[
          message("m-1", "user", "/compact", "run-1"),
          compaction("compaction-1", "run-1", "Context compacted"),
        ]}
      />,
    );
    expect(container.textContent).toContain("/compact");
  });
});
