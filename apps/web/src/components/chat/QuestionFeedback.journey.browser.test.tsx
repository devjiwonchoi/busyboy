import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { act, createRef, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputNote,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { MessagesTimeline } from "./MessagesTimeline";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-11-05T03:00:00.000Z";
const threadRef = { environmentId: ENVIRONMENT_ID, threadId: ThreadId.make("thread") };

const questions = [
  {
    id: "plan",
    header: "#3 Plan",
    question: "Approve the plan for task #3?",
    options: [
      { label: "Approve (Recommended)", description: "Start building it" },
      { label: "Request changes", description: "Tell the lead what to change" },
    ],
    multiSelect: false,
  },
  {
    id: "ship",
    header: "Ship",
    question: "Open the PR today?",
    options: [
      { label: "Yes", description: "Open it today" },
      { label: "No", description: "Wait" },
    ],
    multiSelect: false,
  },
];

const prompt = {
  requestId: RuntimeRequestId.make("question-feedback"),
  createdAt: CREATED_AT,
  dismissible: false,
  responseCapability: "live" as const,
  questions,
};

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

function timelineProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: "environment-local:question-feedback",
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

/** What the thread shows once the server records the answer: work, then the answered question. */
function answeredTimeline(answers: Record<string, string | string[]>): Entry[] {
  const work = (id: string, entry: Record<string, unknown>) =>
    ({
      id,
      kind: "work",
      createdAt: CREATED_AT,
      entry: { id, createdAt: CREATED_AT, runId: null, ...entry },
    }) as Entry;
  return [
    work("command", {
      label: "Ran command",
      command: "pnpm test",
      tone: "tool",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
    }),
    work("question", {
      label: "Answered questions",
      tone: "tool",
      itemType: "user_input_request",
      toolLifecycleStatus: "completed",
      structuredPayload: { type: "user_input_request", requestId: prompt.requestId, questions },
      questionAnswer: {
        requestId: prompt.requestId,
        answers,
        attachmentsByQuestionId: {},
        questionTextById: Object.fromEntries(questions.map((q) => [q.id, q.question])),
      },
    }),
  ];
}

/** The question card wired to the same draft and submit logic the chat uses. */
function Journey({ onSubmit }: { onSubmit: (answers: Record<string, string | string[]>) => void }) {
  const [questionIndex, setQuestionIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [submitted, setSubmitted] = useState<Record<string, string | string[]> | null>(null);
  if (submitted) {
    return <MessagesTimeline {...timelineProps()} timelineEntries={answeredTimeline(submitted)} />;
  }
  const advance = () => {
    const progress = derivePendingUserInputProgress(questions, drafts, questionIndex);
    if (!progress.isLastQuestion) {
      setQuestionIndex(questionIndex + 1);
      return;
    }
    const answers = buildPendingUserInputAnswers(questions, drafts);
    if (!answers) return;
    onSubmit(answers);
    setSubmitted(answers);
  };
  return (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[prompt]}
      cwd="/repo"
      threadRef={threadRef}
      respondingRequestIds={[]}
      answers={drafts}
      questionIndex={questionIndex}
      onToggleOption={(questionId, value) => {
        const question = questions.find((entry) => entry.id === questionId)!;
        setDrafts((existing) => ({
          ...existing,
          [questionId]: togglePendingUserInputOptionSelection(
            question,
            existing[questionId],
            value,
          ),
        }));
      }}
      onChangeNote={(questionId, note) => {
        setDrafts((existing) => ({
          ...existing,
          [questionId]: setPendingUserInputNote(existing[questionId], note),
        }));
      }}
      onAdvance={advance}
      onDismiss={() => {}}
    />
  );
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function buttonWithText(text: string) {
  const button = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(text),
  );
  expect(button, `button ${text}`).toBeDefined();
  return button!;
}

it("sends Request changes with the typed note and keeps the answered question in the thread", async () => {
  const onSubmit = vi.fn();
  await act(async () => root.render(<Journey onSubmit={onSubmit} />));
  expect(container.textContent).toContain("1/2");

  // Request changes opens a focused note field and waits instead of moving on.
  await act(async () => buttonWithText("Request changes").click());
  const note = await vi.waitFor(() => {
    const field = container.querySelector<HTMLTextAreaElement>("[data-pending-user-input-note]");
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    return field!;
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(container.textContent).toContain("1/2");

  await userEvent.type(note, "Split the migration into its own PR");
  await act(async () => buttonWithText("Next").click());
  await vi.waitFor(() => expect(container.textContent).toContain("2/2"));

  // A plain option on the last question still submits on its own.
  await act(async () => buttonWithText("Yes").click());
  await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  expect(onSubmit).toHaveBeenCalledWith({
    plan: "Request changes\nNote: Split the migration into its own PR",
    ship: "Yes",
  });

  // The card is gone, and the thread shows the question, options, pick, and note, already open.
  const section = await vi.waitFor(() => {
    const element = container.querySelector<HTMLElement>("[data-answered-question]");
    expect(element).not.toBeNull();
    return element!;
  });
  expect(section.textContent).toContain("Approve the plan for task #3?");
  expect(section.textContent).toContain("Approve (Recommended)");
  const picked = [...section.querySelectorAll("[data-selected=true]")].map((el) => el.textContent);
  expect(picked).toEqual([
    expect.stringContaining("Request changes"),
    expect.stringContaining("Yes"),
  ]);
  expect(section.querySelector("[data-answered-question-note]")?.textContent).toBe(
    "Note: Split the migration into its own PR",
  );
  expect(section.textContent).toContain("Open the PR today?");
  expect(section.getBoundingClientRect().height).toBeGreaterThan(80);
});
