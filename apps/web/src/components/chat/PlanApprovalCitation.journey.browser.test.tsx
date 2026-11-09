import type { LegendListRef } from "@legendapp/list/react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  MessageId,
  PLAN_APPROVAL_START,
  ProjectAttentionBatchId,
  ProjectAttentionItemId,
  ProjectId,
  ProjectTaskId,
  ThreadId,
  type AssistantCitation,
  type ProjectDecisionCard,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, createRef, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { useComposerDraftStore } from "../../composerDraftStore";
import { longPressSelect, tap } from "../../test-touch-selection";
import { toastManager } from "../ui/toast";
import { MessagesTimeline } from "./MessagesTimeline";
import type { AssistantCitationRequest } from "./AssistantCitationSource";
import { useChatAnnotations, withComposerAnnotations } from "./useChatAnnotations";

const mocks = vi.hoisted(() => ({ answer: vi.fn() }));
vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerForThread: (() => null) as never,
  useProjectManagerEntries: (() => []) as never,
  useTaskDetail: (() => ({ data: null, error: null })) as never,
  useAnswerDecision: (() => mocks.answer) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => () => Promise.resolve()) as never,
}));

const environmentId = EnvironmentId.make("environment-local");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("pm-thread"));
const summary = "Keep the login redirect inside the auth guard.";
const at = "2026-11-07T03:00:00.000Z";
const card: ProjectDecisionCard = {
  taskNumber: 1,
  taskTitle: "Login redirect",
  plan: {
    summary,
    todos: [
      {
        id: "guard",
        text: "Move redirect into the auth guard",
        done: false,
        doneWhen: "Redirect is guarded",
        dependsOn: [],
      },
    ],
    subtasks: [],
  },
  item: {
    id: ProjectAttentionItemId.make("attention-login"),
    projectId: ProjectId.make("project-1"),
    taskId: ProjectTaskId.make("task-1"),
    kind: "approval",
    question: "Approve this plan?",
    options: [PLAN_APPROVAL_START],
    answer: null,
    answeredAt: null,
    answeredBy: null,
    askerThreadId: ThreadId.make("lead-1"),
    batchId: ProjectAttentionBatchId.make("batch-1"),
    createdAt: at,
    supersededAt: null,
    specVersion: 1,
    summary,
    verification: null,
  },
};
const listRef = createRef<LegendListRef | null>();
const timelineProps = {
  isWorking: false,
  activeTurnInProgress: false,
  listRef,
  latestRun: null,
  turnDiffSummaries: [],
  runs: [],
  routeThreadKey: `environment-local:${threadRef.threadId}`,
  onOpenTurnDiff: () => {},
  onOpenThread: () => {},
  onForkFromRun: async () => {},
  onRollbackCheckpoint: () => {},
  supportsConversationRollback: false,
  onRevertToTurnCount: () => {},
  isRevertingCheckpoint: false,
  onImageExpand: () => {},
  activeThreadEnvironmentId: environmentId,
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
  timelineEntries: [],
} satisfies ComponentProps<typeof MessagesTimeline>;

let sent: string[];
let savedCitation: AssistantCitation | null;

/** ChatView's annotation wiring around the real virtual timeline and its plan-card row. */
function ChatPage({ cards }: { cards: ProjectDecisionCard[] }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [request, setRequest] = useState<AssistantCitationRequest | null>(null);
  const annotations = useChatAnnotations(threadRef);
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}>
      <div
        ref={setHost}
        style={{
          position: "relative",
          minHeight: 0,
          flex: 1,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {annotations.overlay(host)}
        <MessagesTimeline
          {...timelineProps}
          decisionCards={cards}
          citationRequest={request}
          onCiteAssistantText={(citation) => annotations.add(citation)}
        />
      </div>
      <div style={{ padding: 12 }}>
        {annotations.chip}
        <button
          onClick={() => {
            const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
            savedCitation = draft?.annotations?.[0]?.citation ?? null;
            sent.push(withComposerAnnotations("What do you think?", draft?.annotations ?? []));
            useComposerDraftStore.getState().clearComposerContent(threadRef);
          }}
        >
          Send
        </button>
        <button
          onClick={() => {
            if (savedCitation) {
              setRequest({ key: "sent-quote", citation: savedCitation });
            }
          }}
        >
          Open sent quote
        </button>
      </div>
    </div>
  );
}

let root: Root;
let container: HTMLDivElement;
const pill = () => document.querySelector<HTMLElement>("[data-annotation-pill]");
const source = () =>
  document.querySelector<HTMLElement>(`[data-assistant-citation-source="${card.item.id}"]`);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sent = [];
  savedCitation = null;
  mocks.answer.mockReset();
  mocks.answer.mockResolvedValue(AsyncResult.success({ item: card.item }));
  useComposerDraftStore.getState().clearComposerContent(threadRef);
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  window.getSelection()?.removeAllRanges();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([
  { name: "desktop", width: 1100, height: 800 },
  { name: "phone", width: 390, height: 844 },
])("plan citations on $name", ({ width, height }) => {
  it("adds a plan quote to the composer, sends it, and opens its source", async () => {
    await page.viewport(width, height);
    const toast = vi.spyOn(toastManager, "add");
    await act(() => root.render(<ChatPage cards={[card]} />));
    await vi.waitFor(() => expect(source()?.textContent).toContain(summary));

    if (width < 768) {
      await longPressSelect(page.getByText(summary).element(), "login", "guard");
      await tap(
        await vi.waitFor(() => page.getByRole("button", { name: "Add to chat" }).element()),
      );
    } else {
      await userEvent.tripleClick(page.getByText(summary));
      await userEvent.click(page.getByRole("button", { name: "Add to chat" }));
    }
    await vi.waitFor(() => expect(pill()?.dataset.annotationPill).toBe("new"));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-annotation-pin="1"]')?.textContent).toBe("1"),
    );
    await userEvent.click(page.getByRole("button", { name: "Save annotation" }));
    await userEvent.click(page.getByRole("button", { name: "1 annotation" }));
    await vi.waitFor(() =>
      expect(document.querySelector("[data-annotations-list]")?.textContent).toContain(
        "login redirect",
      ),
    );
    await userEvent.keyboard("{Escape}");
    await userEvent.click(page.getByRole("button", { name: "Send", exact: true }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("t3-citation://v1/");
    expect(sent[0]).toContain("login+redirect+inside+the+auth+guard");
    expect(sent[0]!.endsWith("What do you think?")).toBe(true);
    expect(savedCitation?.messageId).toBe(MessageId.make(card.item.id));

    // The same navigation request ChatView receives from a sent citation must highlight the card.
    await userEvent.click(page.getByRole("button", { name: "Open sent quote" }));
    await vi.waitFor(() => expect(source()?.dataset.citationHighlighted).toBe("true"));
    expect(toast.mock.calls).toEqual([]);
  });

  it("keeps View details and Approve usable without selection actions", async () => {
    await page.viewport(width, height);
    await act(() => root.render(<ChatPage cards={[card]} />));
    await userEvent.click(page.getByRole("button", { name: "View details" }));
    await vi.waitFor(() =>
      expect(document.querySelector("[data-plan-review]")?.getAttribute("data-plan-review")).toBe(
        card.item.id,
      ),
    );
    expect(document.querySelector('[aria-label="Selection actions"]')).toBeNull();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.querySelector("[data-plan-review]")).toBeNull());
    await userEvent.click(page.getByRole("button", { name: "Approve", exact: true }));
    await vi.waitFor(() =>
      expect(mocks.answer).toHaveBeenCalledWith(environmentId, {
        projectId: card.item.projectId,
        attentionItemId: card.item.id,
        answer: PLAN_APPROVAL_START,
      }),
    );
    expect(document.querySelector('[aria-label="Selection actions"]')).toBeNull();
  });
});

it.each([
  {
    name: "answered live board",
    plan: card.plan,
    answer: PLAN_APPROVAL_START,
    answeredAt: at,
    supersededAt: null,
  },
  { name: "answered", plan: null, answer: PLAN_APPROVAL_START, answeredAt: at, supersededAt: null },
  { name: "resolved", plan: null, answer: null, answeredAt: null, supersededAt: at },
])(
  "keeps $name plan cards available as citation sources",
  async ({ plan, answer, answeredAt, supersededAt }) => {
    await act(() =>
      root.render(
        <ChatPage
          cards={[
            {
              ...card,
              plan,
              item: { ...card.item, answer, answeredAt, supersededAt },
            },
          ]}
        />,
      ),
    );
    await vi.waitFor(() =>
      expect(
        source()?.querySelector("[data-decision-card]")?.getAttribute("data-decision-card"),
      ).toBe(card.item.id),
    );
  },
);

const decisionContext = "Keep the login redirect inside the auth guard until the router is ready.";
const decision: ProjectDecisionCard = {
  ...card,
  plan: null,
  item: {
    ...card.item,
    kind: "decision",
    question: `How far should the redirect fix go?\n\n${decisionContext}`,
    options: ["Guard first — Ship today (Recommended)", "Whole router — Takes three days"],
  },
};

describe.each([
  { name: "desktop", width: 900, height: 900 },
  { name: "phone", width: 390, height: 844 },
])("decision citations on $name", ({ width, height }) => {
  it("adds a context quote, sends it, and highlights its decision source", async () => {
    await page.viewport(width, height);
    const toast = vi.spyOn(toastManager, "add");
    await act(() => root.render(<ChatPage cards={[decision]} />));
    await vi.waitFor(() => expect(source()?.textContent).toContain(decisionContext));
    if (width < 768) {
      await longPressSelect(page.getByText(decisionContext).element(), "login", "guard");
      await tap(
        await vi.waitFor(() => page.getByRole("button", { name: "Add to chat" }).element()),
      );
    } else {
      await userEvent.tripleClick(page.getByText(decisionContext));
      await userEvent.click(page.getByRole("button", { name: "Add to chat" }));
    }
    await vi.waitFor(() => expect(pill()?.dataset.annotationPill).toBe("new"));
    await userEvent.click(page.getByRole("button", { name: "Save annotation" }));
    await userEvent.click(page.getByRole("button", { name: "Send", exact: true }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("t3-citation://v1/");
    expect(sent[0]).toContain("login+redirect+inside+the+auth+guard");
    expect(savedCitation?.messageId).toBe(MessageId.make(decision.item.id));
    await userEvent.click(page.getByRole("button", { name: "Open sent quote" }));
    await vi.waitFor(() => expect(source()?.dataset.citationHighlighted).toBe("true"));
    expect(toast.mock.calls).toEqual([]);
  });

  it("lets the user pick, write a note, and submit without selection actions", async () => {
    await page.viewport(width, height);
    await act(() => root.render(<ChatPage cards={[decision]} />));
    await userEvent.click(page.getByRole("radio", { name: /Guard first/ }));
    expect(mocks.answer.mock.calls).toEqual([]);
    await userEvent.type(
      page.getByRole("textbox", { name: "Note for your answer" }),
      "Keep the flag",
    );
    await userEvent.click(page.getByRole("button", { name: "Submit", exact: true }));
    await vi.waitFor(() =>
      expect(mocks.answer).toHaveBeenCalledWith(environmentId, {
        projectId: decision.item.projectId,
        attentionItemId: decision.item.id,
        answer: `${decision.item.options[0]}\nNote: Keep the flag`,
      }),
    );
    expect(document.querySelector('[aria-label="Selection actions"]')).toBeNull();
  });
});
