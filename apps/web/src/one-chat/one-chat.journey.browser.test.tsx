import {
  EnvironmentId,
  PLAN_APPROVAL_START,
  type ProjectDecisionCard,
  type ProjectTaskReference,
  type ProjectTeamAnswerDecisionInput,
  type ProjectTeamAttentionSummary,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import {
  buildActionCards,
  buildWorkItems,
  type OneChatProject,
  workCounts,
} from "@t3tools/shared/one-chat";
import { Atom } from "effect/reactivity";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { keepsClassicLayout, OneChatGate } from "./one-chat-gate";
import { OneChatScreen } from "./one-chat-screen";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const DIRECTOR_THREAD = ThreadId.make("director-thread");
const SIDE_THREAD = ThreadId.make("side-thread");
const AT = "2026-11-13T03:00:00.000Z";

interface FakeMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly streaming: boolean;
  readonly at: number;
}

/** The server side the screen talks to: summaries, thread messages, and what the screen sent. */
const server = vi.hoisted(() => ({
  projects: [] as OneChatProject[],
  threads: new Map<string, FakeMessage[]>(),
  listeners: new Set<() => void>(),
  version: 0,
  answers: [] as ProjectTeamAnswerDecisionInput[],
  sent: [] as { threadId: string; text: string }[],
  created: [] as string[],
  deleted: [] as string[],
  settings: [] as Record<string, unknown>[],
  enabled: true,
  failAnswers: false,
  /** When set, a new side chat thread waits for this before it exists. */
  holdCreate: null as Promise<void> | null,
}));

function publish() {
  server.version += 1;
  for (const listener of server.listeners) listener();
}

function useServerVersion() {
  return useSyncExternalStore(
    (listener) => {
      server.listeners.add(listener);
      return () => server.listeners.delete(listener);
    },
    () => server.version,
  );
}

vi.mock(import("./one-chat-data"), async (original) => ({
  ...(await original()),
  useOneChatData: (() => {
    useServerVersion();
    const items = buildWorkItems(server.projects);
    return {
      environmentId: ENVIRONMENT_ID,
      directorRef: { environmentId: ENVIRONMENT_ID, threadId: DIRECTOR_THREAD },
      directorProjectId: "director-project",
      projects: server.projects,
      graph: null,
      taskWorktrees: [],
      workItems: items,
      counts: workCounts(items),
      cards: buildActionCards(server.projects),
    };
  }) as never,
  useThreadView: ((ref: { threadId: string } | null) => {
    useServerVersion();
    return {
      messages: ref === null ? [] : (server.threads.get(ref.threadId) ?? []),
      running: false,
      thread: {
        projectId: "director-project",
        modelSelection: { provider: "claudeAgent", model: "claude-opus-5-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
      },
    };
  }) as never,
}));

vi.mock(import("./one-chat-commands"), () => ({
  useOneChatCommands: () => ({
    send: async ({ threadId, text }: { threadId: string; text: string }) => {
      server.sent.push({ threadId, text });
      const messages = server.threads.get(threadId) ?? [];
      server.threads.set(threadId, [
        ...messages,
        { id: `u${messages.length}`, role: "user", text, streaming: false, at: Date.now() },
        {
          id: `a${messages.length}`,
          role: "assistant",
          text: `Reply to: ${text}`,
          streaming: false,
          at: Date.now() + 1,
        },
      ]);
      publish();
      return true;
    },
    stop: async () => {},
    createTempThread: async () => {
      if (server.holdCreate) await server.holdCreate;
      server.created.push(SIDE_THREAD);
      server.threads.set(SIDE_THREAD, []);
      return SIDE_THREAD;
    },
    deleteThread: async (_environmentId: unknown, threadId: string) => {
      server.deleted.push(threadId);
      server.threads.delete(threadId);
    },
  }),
}));

vi.mock(import("../state/projectTeam"), async (original) => ({
  ...(await original()),
  useAnswerDecision: (() => async (_environmentId: unknown, input: ProjectTeamAnswerDecisionInput) => {
    server.answers.push(input);
    if (server.failAnswers) return { _tag: "Failure" };
    server.projects = server.projects.map((project) => ({
      ...project,
      summary: {
        ...project.summary,
        decisionCards: project.summary.decisionCards.map((card) =>
          card.item.id === input.attentionItemId
            ? { ...card, item: { ...card.item, answer: input.answer, answeredAt: AT } }
            : card,
        ),
      },
    }));
    publish();
    return { _tag: "Success" };
  }) as never,
  useTaskDetail: (() => ({
    data: {
      versions: [
        {
          spec: {
            summary: "Never miss a card",
            goal: "Cards reach the phone",
            nonGoals: "Show card text on the lock screen\nAdd a new push service",
            criteria: [{ id: "c1", text: "Alert within a minute", provenBy: "device recording" }],
            flow: "flowchart TD\n  A --> B",
            prototype: "<p>mockup</p>",
            files: [{ path: "src/push.ts", change: "new" }],
          },
        },
      ],
    },
  })) as never,
}));

vi.mock(import("../state/server"), async (original) => ({
  ...(await original()),
  primaryServerKeybindingsAtom: Atom.make(DEFAULT_RESOLVED_KEYBINDINGS) as never,
}));

vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useUpdateClientSettings: (() => async (patch: Record<string, unknown>) => {
    server.settings.push(patch);
  }) as never,
  useClientSettings: ((select: (settings: { oneChatScreenEnabled: boolean }) => unknown) =>
    select({ oneChatScreenEnabled: server.enabled })) as never,
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => async () => {}) as never,
  useLocation: ((options: { select: (location: { pathname: string }) => unknown }) =>
    options.select({ pathname: "/" })) as never,
}));

function task(id: string, extra: Partial<ProjectTaskReference> = {}): ProjectTaskReference {
  return {
    id,
    number: 1,
    parentTaskId: null,
    waitsOn: [],
    title: `Task ${id}`,
    stage: "running",
    leadThreadId: null,
    prUrl: null,
    lastOutcome: null,
    openQuestion: false,
    openBlocker: false,
    updatedAt: AT,
    iterateRound: 0,
    shipRound: 0,
    modelSteps: {},
    checks: null,
    ...extra,
  } as ProjectTaskReference;
}

function card(
  id: string,
  taskId: string,
  extra: Partial<ProjectDecisionCard["item"]> = {},
): ProjectDecisionCard {
  return {
    item: {
      id,
      projectId: "project-1",
      taskId,
      kind: "decision",
      question: "Which push service?\n\nThe built-in one keeps cost at zero.",
      options: ["Built-in: no new service (Recommended)", "Third party: faster"],
      answer: null,
      answeredAt: null,
      supersededAt: null,
      createdAt: AT,
      summary: null,
      verification: null,
      details: null,
      ...extra,
    },
    taskNumber: 1,
    taskTitle: `Task ${taskId}`,
    plan: null,
  } as unknown as ProjectDecisionCard;
}

function project(
  projectId: string,
  name: string,
  tasks: ProjectTaskReference[],
  decisionCards: ProjectDecisionCard[] = [],
): OneChatProject {
  return {
    projectId,
    name,
    summary: { projectId, tasks, decisionCards } as unknown as ProjectTeamAttentionSummary,
  };
}

let root: Root | null = null;
let container: HTMLElement;

async function mount(element = <OneChatScreen />) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
  });
}

/** The classic layout as the root route renders it, behind the gate. */
const classicLayout = (
  <OneChatGate>
    <div data-slot="sidebar">Classic sidebar</div>
  </OneChatGate>
);

const query = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const buttonNamed = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find((button) => button.textContent?.trim() === name) ??
  null;
const startsWithButton = (prefix: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find((button) =>
    button.textContent?.trim().startsWith(prefix),
  ) ?? null;
const composer = () => query<HTMLTextAreaElement>("[data-one-chat-screen] textarea")!;

beforeEach(() => {
  server.projects = [];
  server.threads = new Map([[DIRECTOR_THREAD, []]]);
  server.answers = [];
  server.sent = [];
  server.created = [];
  server.deleted = [];
  server.settings = [];
  server.enabled = true;
  server.failAnswers = false;
  server.holdCreate = null;
  localStorage.clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = "";
});

it("keeps settings and task pages on the classic layout so the switch can be turned off", () => {
  expect(keepsClassicLayout("/settings/general")).toBe(true);
  expect(keepsClassicLayout("/tasks/environment-local/project-1/task-1")).toBe(true);
  expect(keepsClassicLayout("/")).toBe(false);
});

it("keeps the classic screen unchanged while the switch is off", async () => {
  server.enabled = false;
  await mount(classicLayout);
  expect(query("[data-slot='sidebar']")?.textContent).toBe("Classic sidebar");
  expect(query("[data-one-chat-screen]")).toBeNull();
});

it("shows one chat with no sidebar or right panel and leads back to the classic screen", async () => {
  await mount(classicLayout);
  expect(query("[data-one-chat-screen]")).not.toBeNull();
  expect(query("[data-slot='sidebar']")).toBeNull();
  expect(query("[data-right-panel]")).toBeNull();
  await act(async () => buttonNamed("Classic screen")!.click());
  expect(server.settings).toEqual([{ oneChatScreenEnabled: false }]);
});

it("hides the toast when nothing waits or runs, then shows one line that expands in place", async () => {
  await mount();
  expect(document.body.textContent).not.toContain("Waiting on you");

  server.projects = [
    project(
      "project-1",
      "busyboy",
      [task("ask"), task("run", { checks: [{ text: "a", passed: true }, { text: "b", passed: false }] })],
      [card("c1", "ask")],
    ),
  ];
  await act(async () => publish());
  expect(document.body.textContent).toContain("Waiting on you 1");
  expect(document.body.textContent).toContain("Running 1");

  await act(async () => startsWithButton("Expand")!.click());
  expect(document.body.textContent).toContain("1 of 2 proven");
  expect(document.body.textContent).toContain("@busyboy");

  await act(async () => startsWithButton("Collapse")!.click());
  expect(document.body.textContent).not.toContain("1 of 2 proven");
});

it("opens the work list large and full screen", async () => {
  server.projects = [project("project-1", "busyboy", [task("run")])];
  await mount();
  await act(async () => startsWithButton("Open large")!.click());
  const dialog = query("[role='dialog']")!;
  expect(dialog.textContent).toContain("Task run");
  await act(async () => startsWithButton("Full screen", dialog)!.click());
  expect(startsWithButton("Exit full screen", query("[role='dialog']")!)).not.toBeNull();
});

it("scrolls to the card from a waiting row and highlights it", async () => {
  server.projects = [project("project-1", "busyboy", [task("ask")], [card("c1", "ask")])];
  await mount();
  await act(async () => startsWithButton("Expand")!.click());
  const row = query("[data-one-chat-work-row='ask']")!;
  await act(async () => row.querySelector("button")!.click());
  const cardElement = query("[data-one-chat-card='c1']")!;
  await vi.waitFor(() => expect(cardElement.dataset.highlighted).toBe("true"));
});

it("shows a card as one question, one gray line and options with one recommended, then folds it", async () => {
  server.projects = [project("project-1", "busyboy", [task("ask")], [card("c1", "ask")])];
  await mount();
  const cardElement = query("[data-one-chat-card='c1']")!;
  expect(cardElement.querySelector("[data-one-chat-card-question]")!.textContent).toBe(
    "Which push service?",
  );
  expect(cardElement.querySelector("[data-one-chat-card-subline]")!.textContent).toBe(
    "The built-in one keeps cost at zero.",
  );
  const recommended = [...cardElement.querySelectorAll("button")].filter((button) =>
    button.textContent?.includes("(Recommended)"),
  );
  expect(recommended.map((button) => button.textContent)).toEqual(["Built-in (Recommended)"]);
  expect(buttonNamed("Details", cardElement)).not.toBeNull();

  await act(async () => recommended[0]!.click());
  expect(server.answers.map((answer) => answer.answer)).toEqual([
    "Built-in: no new service (Recommended)",
  ]);
  const folded = query("[data-one-chat-card='c1']")!;
  expect(folded.querySelector("[data-one-chat-card-picked]")!.textContent).toContain("Built-in");
  expect(folded.querySelectorAll("button")).toHaveLength(0);
});

it("shows plan cards with criteria and do-nots, and the details in the agreed order", async () => {
  server.projects = [
    project(
      "project-1",
      "busyboy",
      [task("plan", { checks: [{ text: "Alert within a minute", passed: false }] })],
      [
        card("p1", "plan", {
          kind: "approval",
          options: [],
          question: "Mobile alerts, go?",
          details: [{ label: "Merge", text: "The PM merges after review" }],
        }),
      ],
    ),
  ];
  await mount();
  const cardElement = query("[data-one-chat-card='p1']")!;
  expect(cardElement.querySelector("[data-one-chat-card-criteria]")!.textContent).toContain(
    "Alert within a minute",
  );
  expect(cardElement.querySelector("[data-one-chat-card-non-goals]")!.textContent).toContain(
    "Show card text on the lock screen",
  );

  await act(async () => buttonNamed("Details", cardElement)!.click());
  const headings = [...query("[role='dialog']")!.querySelectorAll("h3")].map(
    (heading) => heading.textContent,
  );
  expect(headings).toEqual([
    "Purpose",
    "Success criteria and checks",
    "Do not",
    "Flow",
    "Mockup",
    "File tree",
    "Rules",
  ]);

  await act(async () => startsWithButton("Agree", query("[role='dialog']")!)!.click());
  expect(server.answers.map((answer) => answer.answer)).toEqual([PLAN_APPROVAL_START]);
});

it("asks the Director to merge from a result card instead of merging", async () => {
  server.projects = [
    project("project-1", "busyboy", [
      task("done", { stage: "in_review", ready: true, title: "Alerts", prUrl: "https://x/pull/1" }),
    ]),
  ];
  await mount();
  const cardElement = query("[data-one-chat-card='result:done']")!;
  expect(cardElement.textContent).toContain("Alerts: check the result?");
  await act(async () => startsWithButton("Looks good, merge", cardElement)!.click());
  expect(server.sent).toEqual([
    { threadId: DIRECTOR_THREAD, text: "@busyboy Alerts: I checked the result. Please merge it." },
  ]);
  expect(server.answers).toEqual([]);
  await vi.waitFor(() =>
    expect(
      query("[data-one-chat-card='result:done'] [data-one-chat-card-picked]")?.textContent,
    ).toContain("Looks good, merge"),
  );
});

it("suggests projects with their status after @ and inserts the handle", async () => {
  server.projects = [
    project("project-1", "busyboy", [task("ask"), task("run")], [card("c1", "ask")]),
    project("project-2", "blog", []),
  ];
  await mount();
  await userEvent.click(composer());
  await userEvent.keyboard("@b");
  const menu = query("[data-one-chat-mention-menu]")!;
  expect(menu.textContent).toContain("@busyboy");
  expect(menu.textContent).toContain("Waiting on you 1 · Running 1");
  expect(menu.textContent).toContain("Quiet");
  await userEvent.keyboard("{Enter}");
  expect(composer().value).toBe("@busyboy ");
});

it("sends with Enter but not while composing Korean text", async () => {
  await mount();
  await userEvent.click(composer());
  composer().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  await userEvent.keyboard("hello");
  composer().dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
  );
  expect(server.sent).toEqual([]);
  composer().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(server.sent).toEqual([{ threadId: DIRECTOR_THREAD, text: "hello" }]));
});

it("keeps the side chat out of the Director chat, quotes it into the main composer, and deletes it", async () => {
  await mount();
  await userEvent.click(composer());
  await userEvent.keyboard("/side{Enter}");
  await vi.waitFor(() => expect(server.created).toEqual([SIDE_THREAD]));
  expect(server.sent).toEqual([]);

  const sheet = query("[role='dialog']")!;
  expect(sheet.textContent).toContain("Temporary · gone when closed");
  await userEvent.click(sheet.querySelector("textarea")!);
  await userEvent.keyboard("what if email?{Enter}");
  await vi.waitFor(() =>
    expect(server.sent).toEqual([{ threadId: SIDE_THREAD, text: "what if email?" }]),
  );
  expect(server.threads.get(DIRECTOR_THREAD)).toEqual([]);

  await vi.waitFor(() => expect(startsWithButton("Quote in main chat")).not.toBeNull());
  await act(async () => startsWithButton("Quote in main chat")!.click());
  expect(composer().value).toContain("> Reply to: what if email?");

  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(server.deleted).toEqual([SIDE_THREAD]));
});

it("opens the side chat with the shortcut and deletes its thread when the shortcut closes it", async () => {
  await mount();
  await userEvent.keyboard("{Meta>}{Shift>}s{/Shift}{/Meta}");
  await vi.waitFor(() => expect(server.created).toEqual([SIDE_THREAD]));
  await vi.waitFor(() => expect(query("[data-one-chat-side-chat] textarea")).not.toBeNull());
  await userEvent.keyboard("{Meta>}{Shift>}s{/Shift}{/Meta}");
  await vi.waitFor(() => expect(server.deleted).toEqual([SIDE_THREAD]));
});

it("deletes a side chat thread that finishes starting after the side chat closed", async () => {
  let finishCreate = () => {};
  server.holdCreate = new Promise((resolve) => {
    finishCreate = resolve;
  });
  await mount();
  await userEvent.keyboard("{Meta>}{Shift>}s{/Shift}{/Meta}");
  await userEvent.keyboard("{Meta>}{Shift>}s{/Shift}{/Meta}");
  expect(server.created).toEqual([]);
  await act(async () => finishCreate());
  await vi.waitFor(() => expect(server.deleted).toEqual([SIDE_THREAD]));
});

it("answers a card once even when clicked twice, and reopens it when the answer fails", async () => {
  server.projects = [project("project-1", "busyboy", [task("ask")], [card("c1", "ask")])];
  server.failAnswers = true;
  await mount();
  const recommended = startsWithButton("Built-in", query("[data-one-chat-card='c1']")!)!;
  await act(async () => {
    recommended.click();
    recommended.click();
  });
  expect(server.answers).toHaveLength(1);
  await vi.waitFor(() =>
    expect(startsWithButton("Built-in", query("[data-one-chat-card='c1']")!)).not.toBeNull(),
  );
});

it("shows the Director's own questions under their task's project and answers them on the Director", async () => {
  server.projects = [
    project("project-1", "busyboy", [task("ask", { title: "Alerts" })]),
    {
      ...project("director-project", "Director", [], [card("d1", "ask")]),
      summary: {
        projectId: "director-project",
        kind: "director",
        tasks: [],
        decisionCards: [card("d1", "ask", { projectId: "director-project" as never })],
      } as unknown as ProjectTeamAttentionSummary,
    },
  ];
  await mount();
  const cardElement = query("[data-one-chat-card='d1']")!;
  expect(cardElement.textContent).toContain("Which push service?");
  expect(query("[data-one-chat-screen]")!.textContent).toContain("Waiting on you 1");
  await act(async () => startsWithButton("Built-in", cardElement)!.click());
  expect(server.answers.map((answer) => [answer.projectId, answer.attentionItemId])).toEqual([
    ["director-project", "d1"],
  ]);
});
