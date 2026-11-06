import { RegistryProvider } from "@effect/atom-react";
import { resolveComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { act, createRef, useState, type ComponentProps, type FormEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { MessagesTimeline } from "./MessagesTimeline";

// The user keeps talking to the project manager while it works: every message lands as a
// plain bubble in send order and the chat never shows steer, queue or compaction UI. A
// normal thread given the same inputs keeps today's steer UI.

const PM_THREAD_ID = "pm-thread";
const PROJECT_MANAGER = {
  persona: { name: "Juniper", avatar: { kind: "emoji", emoji: "🦊" } },
  decisionCards: [],
};

vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerForThread: ((ref: { threadId: string } | null) =>
    ref?.threadId === PM_THREAD_ID ? PROJECT_MANAGER : null) as never,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const RUN_ID = RunId.make("run-1");
const AT = "2026-11-07T10:00:00.000Z";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];
type Message = Extract<Entry, { kind: "message" }>["message"];

function message(id: string, text: string, overrides: Partial<Message> = {}): Entry {
  const createdAt = overrides.createdAt ?? AT;
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: RUN_ID,
      createdAt,
      updatedAt: createdAt,
      streaming: false,
      ...overrides,
    },
  } as Entry;
}

const attempt = (id: string, ordinal: number, status: string) =>
  ({
    id,
    runId: RUN_ID,
    attemptOrdinal: ordinal,
    rootNodeId: `node-${id}`,
    status,
    completedAt: null,
  }) as never;

// A running turn that was steered once already and compacted along the way.
const runningTurn: Entry[] = [
  message("m-1", "Plan the release", { inputIntent: "turn_start" }),
  {
    ...message("m-2", "Drafting the release plan", { role: "assistant" }),
    attempt: attempt("attempt-1", 1, "superseded"),
  } as Entry,
  {
    id: "compaction-1",
    kind: "work",
    createdAt: AT,
    entry: {
      id: "compaction-1",
      createdAt: AT,
      runId: RUN_ID,
      label: "Context compacted 182k → 31k tokens",
      tone: "info",
      itemType: "compaction",
      sourceActivityKind: "context-compaction",
      toolLifecycleStatus: "completed",
    },
  } as Entry,
  {
    ...message("m-3", "Checking the task board", { role: "assistant", streaming: true }),
    attempt: attempt("attempt-2", 2, "running"),
  } as Entry,
];

/**
 * The chat as ChatView wires it: the timeline above, the composer's send/stop button
 * below. Sending while the turn runs resolves the dispatch mode the way ChatComposer does
 * and adds the optimistic bubble the way ChatView does.
 */
function RunningChat(props: { threadId: string; followUpBehavior: "queue" | "steer" }) {
  const seamless = props.threadId === PM_THREAD_ID;
  const [entries, setEntries] = useState(runningTurn);
  const [prompt, setPrompt] = useState("");
  const send = (event: FormEvent) => {
    event.preventDefault();
    const text = prompt.trim();
    if (!text) return;
    const mode = resolveComposerDispatchMode({
      running: true,
      alternateModifier: false,
      activeTurnDefault: props.followUpBehavior,
      canSteer: true,
      seamless,
    });
    setEntries((current) => [
      ...current,
      message(`sent-${current.length}`, text, {
        runId: null,
        createdAt: new Date(Date.parse(AT) + current.length * 1000).toISOString(),
        inputIntent: mode === "queue" ? "queued_turn" : "steer",
      }),
    ]);
    setPrompt("");
  };
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <MessagesTimeline
          isWorking
          activeTurnInProgress
          listRef={createRef<LegendListRef | null>()}
          latestRun={{ runId: RUN_ID, status: "running", startedAt: AT, completedAt: null }}
          turnDiffSummaries={[]}
          runs={[]}
          routeThreadKey={`environment-local:${props.threadId}`}
          onOpenTurnDiff={() => {}}
          onOpenThread={() => {}}
          onForkFromRun={async () => {}}
          onRollbackCheckpoint={() => {}}
          supportsConversationRollback={false}
          onRevertToTurnCount={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          activeThreadEnvironmentId={ENVIRONMENT_ID}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="locale"
          workspaceRoot={undefined}
          anchorMessageId={null}
          onAnchorReady={() => {}}
          onAnchorSizeChanged={() => {}}
          contentInsetEndAdjustment={0}
          liveFollowEnabled
          onIsAtEndChange={() => {}}
          onManualNavigation={() => {}}
          timelineEntries={entries}
        />
      </div>
      <form onSubmit={send} className="flex items-center gap-2 p-3">
        <input
          aria-label="Message"
          className="min-w-0 flex-1"
          value={prompt}
          onChange={(event) => setPrompt(event.currentTarget.value)}
        />
        <ComposerPrimaryActions
          compact
          canOperateThread
          pendingAction={null}
          isRunning
          canInterrupt
          followUpBehavior={props.followUpBehavior}
          canSteer
          seamless={seamless}
          alternateShortcutLabel="⌘↵"
          showPlanFollowUpPrompt={false}
          promptHasText={prompt.trim().length > 0}
          isSendBusy={false}
          sendDisabledReason={null}
          isConnecting={false}
          isEnvironmentUnavailable={false}
          isPreparingWorktree={false}
          hasSendableContent={prompt.trim().length > 0}
          onPreviousPendingQuestion={() => {}}
          onInterrupt={() => {}}
          onImplementPlanInNewThread={() => {}}
        />
      </form>
    </div>
  );
}

const roots: Root[] = [];
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await page.viewport(390, 844);
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function render(props: ComponentProps<typeof RunningChat>) {
  container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height: 844px; width: 390px; display: flex; flex-direction: column;";
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <RegistryProvider>
        <RunningChat {...props} />
      </RegistryProvider>,
    ),
  );
}

async function sendInARow(texts: ReadonlyArray<string>) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Message"]')!;
  for (const text of texts) {
    await userEvent.fill(input, text);
    await userEvent.keyboard("{Enter}");
  }
}

const FOLLOW_UPS = ["Also check CI", "And ping #6", "Then post a sitrep"];

/** Bubble texts in on-screen order. */
const bubbleTexts = () =>
  FOLLOW_UPS.flatMap((text) => {
    const node = [...container.querySelectorAll("p, div")].find(
      (candidate) => candidate.childElementCount === 0 && candidate.textContent === text,
    );
    return node ? [{ text, top: node.getBoundingClientRect().top }] : [];
  })
    .toSorted((left, right) => left.top - right.top)
    .map(({ text }) => text);

const sendButtonLabel = () =>
  container
    .querySelector<HTMLButtonElement>('form button[type="submit"]')
    ?.getAttribute("aria-label");

describe("talking to the project manager while it works (phone width)", () => {
  it("shows each follow-up as a plain bubble in order, with no steer, queue or compaction UI", async () => {
    // The user's setting says queue; the PM chat ignores it and joins the running turn.
    await render({ threadId: PM_THREAD_ID, followUpBehavior: "queue" });

    // Nothing typed: only Stop, as in any running chat.
    expect(container.querySelector('button[aria-label="Stop generation"]')).not.toBeNull();

    await userEvent.fill(
      container.querySelector<HTMLInputElement>('input[aria-label="Message"]')!,
      "draft",
    );
    expect(sendButtonLabel()).toBe("Submit message");
    await userEvent.hover(container.querySelector('form button[type="submit"]')!);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent).toBe(
        "Submit message",
      ),
    );
    await userEvent.unhover(container.querySelector('form button[type="submit"]')!);

    await sendInARow(FOLLOW_UPS);

    await vi.waitFor(() => expect(bubbleTexts()).toEqual(FOLLOW_UPS));
    const text = container.textContent ?? "";
    expect(text).toContain("Plan the release");
    expect(text).toContain("Checking the task board");
    expect(text).not.toMatch(/Steer|Queued|From queue|Cut off by a steer|Compact/);
    expect(container.querySelector("[data-user-message-intent]")).toBeNull();
    expect(container.querySelector("[data-superseded-attempt-id]")).toBeNull();
    expect(container.querySelector("[data-timeline-compaction-marker]")).toBeNull();
    // The cut-off attempt's text stays inline instead of folding behind a disclosure.
    expect(text).toContain("Drafting the release plan");
  });

  it("keeps today's steer UI in a normal thread given the same inputs", async () => {
    await render({ threadId: "user-thread", followUpBehavior: "steer" });

    await userEvent.fill(
      container.querySelector<HTMLInputElement>('input[aria-label="Message"]')!,
      "draft",
    );
    expect(sendButtonLabel()).toBe("Steer message");

    await sendInARow(FOLLOW_UPS);

    await vi.waitFor(() => expect(bubbleTexts()).toEqual(FOLLOW_UPS));
    expect(container.querySelectorAll('[data-user-message-intent="steer"]')).toHaveLength(3);
    expect(container.querySelector("[data-superseded-attempt-id]")?.textContent).toContain(
      "Cut off by a steer",
    );
    expect(container.querySelector("[data-timeline-compaction-marker]")).not.toBeNull();
  });
});
