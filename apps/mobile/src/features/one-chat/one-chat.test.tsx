// @vitest-environment jsdom
import {
  PLAN_APPROVAL_START,
  type ProjectDecisionCard,
  type ProjectTaskReference,
  type ProjectTeamAttentionSummary,
} from "@t3tools/contracts";
import {
  buildActionCards,
  buildWorkItems,
  type OneChatProject,
} from "@t3tools/shared/one-chat";
import { act, createElement, type ReactNode, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const AT = "2026-11-13T03:00:00.000Z";

interface FakeMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** The server side the screen talks to, and every call the screen made. */
const server = vi.hoisted(() => ({
  enabled: true,
  projects: [] as unknown[],
  director: [] as FakeMessage[],
  side: [] as FakeMessage[],
  listeners: new Set<() => void>(),
  version: 0,
  sentToDirector: [] as string[],
  sentToSide: [] as string[],
  answers: [] as { projectId: string; attentionItemId: string; answer: string }[],
  deleted: [] as string[],
  scrolledTo: [] as number[],
  preferences: [] as Record<string, unknown>[],
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

type Props = Record<string, unknown> & { children?: ReactNode };

/** DOM stand-ins for the native primitives the screen uses. */
async function nativeStandIns() {
  const react = await import("react");
  const { createElement: h } = react;
  const box = ({ children, testID }: Props) =>
    h("div", { "data-testid": testID as string }, children);
  const press = ({ children, onPress, disabled, accessibilityLabel, testID }: Props) =>
    h(
      "button",
      {
        onClick: onPress as () => void,
        disabled: disabled as boolean,
        "aria-label": accessibilityLabel as string,
        "data-testid": testID as string,
      },
      children,
    );
  const FlatList = react.forwardRef(function FlatList(
    {
      data,
      renderItem,
      keyExtractor,
      testID,
    }: {
      data: unknown[];
      renderItem: (info: { item: unknown }) => ReactNode;
      keyExtractor: (item: unknown) => string;
      testID: string;
    },
    ref,
  ) {
    react.useImperativeHandle(ref, () => ({
      scrollToIndex: ({ index }: { index: number }) => server.scrolledTo.push(index),
      scrollToEnd: () => {},
      scrollToOffset: () => {},
    }));
    return h(
      "div",
      { "data-testid": testID },
      data.map((item) =>
        h("div", { key: keyExtractor(item), "data-key": keyExtractor(item) }, renderItem({ item })),
      ),
    );
  });
  return {
    View: box,
    ScrollView: box,
    Pressable: press,
    Modal: ({ children }: Props) => h("div", { role: "dialog" }, children),
    Linking: { openURL: () => {} },
    TextInput: ({ value, onChangeText, accessibilityLabel }: Props) =>
      h("textarea", {
        "aria-label": accessibilityLabel as string,
        value: value as string,
        onChange: (event: { currentTarget: { value: string } }) =>
          (onChangeText as (text: string) => void)(event.currentTarget.value),
      }),
    FlatList,
  };
}

vi.mock("react-native", () => nativeStandIns());
vi.mock("react-native-keyboard-controller", async () => ({
  KeyboardAvoidingView: (await nativeStandIns()).View,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("react-native-webview", () => ({ WebView: () => null }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ setOptions: () => {}, navigate: () => {} }),
}));
vi.mock("../../components/ui/AppText", async () => {
  const { createElement: h } = await import("react");
  return {
    AppText: ({ children, testID }: Props) => h("span", { "data-testid": testID as string }, children),
  };
});
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../lib/composerImages", () => ({ pickComposerImages: vi.fn() }));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: ({ markdown }: { markdown: string }) => createElement("span", null, markdown),
}));
vi.mock("../files/FileMarkdownPreview", () => ({ useMarkdownPreviewStyles: () => ({}) }));
vi.mock("../workspace/WorkspaceRootScreen", () => ({
  WorkspaceRootScreen: () => createElement("div", { "data-testid": "classic-home" }),
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: "preferences",
  updateMobilePreferencesAtom: "update-preferences",
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ _tag: "Success", value: { oneChatScreenEnabled: server.enabled } }),
  useAtomSet: () => (patch: Record<string, unknown>) => server.preferences.push(patch),
}));
vi.mock("effect/reactivity", () => ({
  AsyncResult: { isSuccess: (result: { _tag: string }) => result._tag === "Success" },
}));
vi.mock("./use-task-spec", () => ({
  useTaskSpec: () => ({
    summary: "Never miss a card",
    goal: "Cards reach the phone",
    nonGoals: "Show card text on the lock screen",
    criteria: [{ id: "c1", text: "Alert within a minute", provenBy: "device recording" }],
    flow: "flowchart TD\n  A --> B",
    prototype: "",
    files: [{ path: "src/push.ts", change: "new" }],
  }),
}));
vi.mock("./use-one-chat-draft", () => ({
  useOneChatDraft: () => {
    const [text, setText] = useState("");
    return {
      text,
      attachments: [],
      setText,
      addAttachments: () => 0,
      removeAttachment: () => {},
      clear: () => setText(""),
    };
  },
}));
vi.mock("./use-one-chat-data", () => ({
  useThreadChat: (_environmentId: unknown, threadId: string | null) => {
    useServerVersion();
    return {
      messages: threadId === "side" ? server.side : [],
      running: false,
      activeRunId: null,
    };
  },
  useOneChatData: () => {
    useServerVersion();
    const projects = server.projects as OneChatProject[];
    return {
      environmentId: "env",
      directorThreadId: "director",
      directorProjectId: "director-project",
      projects,
      graph: null,
      cards: buildActionCards(projects),
      workItems: buildWorkItems(projects),
      chat: { messages: server.director, running: false, activeRunId: null },
    };
  },
}));
vi.mock("./use-one-chat-actions", () => ({
  useOneChatActions: () => ({
    sendToDirector: async (text: string) => {
      server.sentToDirector.push(text);
      return true;
    },
    answerCard: async (projectId: string, attentionItemId: string, answer: string) => {
      server.answers.push({ projectId, attentionItemId, answer });
      return { _tag: "Success" };
    },
    stopDirector: () => {},
    createSideChat: async () => "side",
    sendToSideChat: async (_threadId: string, text: string) => {
      server.sentToSide.push(text);
      server.side = [
        ...server.side,
        { id: `u${server.side.length}`, role: "user", text },
        { id: `a${server.side.length}`, role: "assistant", text: `Reply to: ${text}` },
      ];
      publish();
    },
    deleteSideChat: async (threadId: string) => {
      server.deleted.push(threadId);
    },
  }),
}));

import { HomeOrOneChat } from "./home-or-one-chat";

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

function card(id: string, taskId: string, extra: Record<string, unknown> = {}) {
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
let host: HTMLDivElement;

function render() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<HomeOrOneChat />));
}

const byTestId = (id: string, scope: ParentNode = host) =>
  scope.querySelector<HTMLElement>(`[data-testid='${id}']`);
const buttonWith = (text: string, scope: ParentNode = host) =>
  [...scope.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ??
  null;
const click = (element: Element | null) =>
  act(() => {
    (element as HTMLElement).click();
  });
async function type(label: string, value: string) {
  const input = host.querySelector<HTMLTextAreaElement>(`textarea[aria-label='${label}']`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  server.enabled = true;
  server.projects = [];
  server.director = [];
  server.side = [];
  server.sentToDirector = [];
  server.sentToSide = [];
  server.answers = [];
  server.deleted = [];
  server.scrolledTo = [];
  server.preferences = [];
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

it("keeps the classic home when the switch is off and shows one chat when it is on", () => {
  server.enabled = false;
  render();
  expect(byTestId("classic-home")).not.toBeNull();
  expect(byTestId("one-chat-screen")).toBeNull();
  act(() => root!.unmount());
  host.remove();

  server.enabled = true;
  render();
  expect(byTestId("classic-home")).toBeNull();
  expect(byTestId("one-chat-screen")).not.toBeNull();
  click(host.querySelector("button[aria-label='More']"));
  click(buttonWith("Classic screen"));
  expect(server.preferences).toEqual([{ oneChatScreenEnabled: false }]);
});

it("hides the toast at zero and expands rows in place, jumping to waiting cards", () => {
  render();
  expect(byTestId("work-toast")).toBeNull();
  act(() => {
    server.projects = [
      project(
        "project-1",
        "busyboy",
        [task("ask"), task("run", { checks: [{ text: "a", passed: true }, { text: "b", passed: false }] })],
        [card("c1", "ask")],
      ),
    ];
    publish();
  });
  const toast = byTestId("work-toast")!;
  expect(toast.textContent).toContain("Waiting on you 1 · Running 1");
  click(buttonWith("Expand", toast));
  expect(toast.textContent).toContain("@busyboy");
  expect(toast.textContent).toContain("1 of 2 proven");

  const askRow = [...toast.querySelectorAll("[data-testid='work-row']")][0]!;
  click(askRow.querySelector("button"));
  expect(byTestId("work-row-details", askRow)).not.toBeNull();
  const cardIndex = [...byTestId("one-chat-feed")!.children].findIndex(
    (row) => row.getAttribute("data-key") === "card:c1",
  );
  expect(server.scrolledTo).toEqual([cardIndex]);

  click(buttonWith("Open large", toast));
  const dialog = host.querySelector("[role='dialog']")!;
  click(buttonWith("Full screen", dialog));
  expect(buttonWith("Exit full screen", dialog)).not.toBeNull();
});

it("shows a card with one recommended option and folds it to the pick", () => {
  server.projects = [project("project-1", "busyboy", [task("ask")], [card("c1", "ask")])];
  render();
  const cardElement = byTestId("action-card")!;
  expect(byTestId("action-card-question", cardElement)!.textContent).toBe("Which push service?");
  expect(cardElement.textContent).toContain("The built-in one keeps cost at zero.");
  const recommended = [...cardElement.querySelectorAll("button")].filter((button) =>
    button.textContent?.includes("(Recommended)"),
  );
  expect(recommended).toHaveLength(1);
  expect(buttonWith("Details", cardElement)).not.toBeNull();
  click(recommended[0]!);
  expect(server.answers).toEqual([
    {
      projectId: "project-1",
      attentionItemId: "c1",
      answer: "Built-in: no new service (Recommended)",
    },
  ]);
  expect(byTestId("action-card-answer")!.textContent).toContain("You chose: Built-in");
});

it("agrees to a plan and shows its details in the agreed order", () => {
  server.projects = [
    project(
      "project-1",
      "busyboy",
      [task("plan", { checks: [{ text: "Alert within a minute", passed: false }] })],
      [card("p1", "plan", { kind: "approval", options: [], question: "Mobile alerts, go?" })],
    ),
  ];
  render();
  const cardElement = byTestId("action-card")!;
  expect(cardElement.textContent).toContain("Alert within a minute");
  expect(cardElement.textContent).toContain("Show card text on the lock screen");
  click(buttonWith("Details", cardElement));
  const text = host.querySelector("[role='dialog']")!.textContent!;
  const order = ["Purpose", "Success criteria and checks", "Do not", "Flow", "File tree"].map(
    (heading) => text.indexOf(heading),
  );
  expect(order.every((index) => index >= 0)).toBe(true);
  expect(order).toEqual(order.toSorted((a, b) => a - b));
  click(buttonWith("Close", host.querySelector("[role='dialog']")!));
  click(buttonWith("Agree", byTestId("action-card")!));
  expect(server.answers).toEqual([
    { projectId: "project-1", attentionItemId: "p1", answer: PLAN_APPROVAL_START },
  ]);
});

it("shows the Director's own question under its task's project and answers it on the Director", () => {
  server.projects = [
    project("project-1", "busyboy", [task("ask")]),
    {
      projectId: "director-project",
      name: "Director",
      summary: {
        projectId: "director-project",
        kind: "director",
        tasks: [],
        decisionCards: [card("d1", "ask", { projectId: "director-project" })],
      } as unknown as ProjectTeamAttentionSummary,
    },
  ];
  render();
  expect(byTestId("work-toast")!.textContent).toContain("Waiting on you 1 · Running 1");
  const cardElement = byTestId("action-card")!;
  expect(cardElement.textContent).toContain("busyboy");
  click(buttonWith("(Recommended)", cardElement));
  expect(server.answers).toEqual([
    {
      projectId: "director-project",
      attentionItemId: "d1",
      answer: "Built-in: no new service (Recommended)",
    },
  ]);
});

it("opens the end state of a running task that has no card", () => {
  server.projects = [project("project-1", "busyboy", [task("run", { title: "Alerts" })])];
  render();
  const toast = byTestId("work-toast")!;
  click(buttonWith("Expand", toast));
  click(toast.querySelector("[data-testid='work-row'] button"));
  click(buttonWith("View end state", toast));
  const dialog = host.querySelector("[role='dialog']")!;
  expect(dialog.textContent).toContain("Alerts");
  expect(dialog.textContent).toContain("Cards reach the phone");
});

it("asks the Director to merge from a result card instead of merging", () => {
  server.projects = [
    project("project-1", "busyboy", [
      task("done", { stage: "in_review", ready: true, title: "Alerts", prUrl: "https://x/pull/1" }),
    ]),
  ];
  render();
  click(buttonWith("Looks good, merge", byTestId("action-card")!));
  expect(server.sentToDirector).toEqual(["@busyboy Alerts: I checked the result. Please merge it."]);
  expect(server.answers).toEqual([]);
  expect(byTestId("action-card-answer")!.textContent).toContain("Looks good, merge");
});

it("suggests projects with their status after @ and inserts the handle", async () => {
  server.projects = [
    project("project-1", "busyboy", [task("ask"), task("run")], [card("c1", "ask")]),
    project("project-2", "blog", []),
  ];
  render();
  await type("Message", "@b");
  const popover = byTestId("project-mention-popover")!;
  expect(popover.textContent).toContain("Waiting on you 1 · Running 1");
  expect(popover.textContent).toContain("Quiet");
  click(buttonWith("@busyboy", popover));
  expect(host.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message']")!.value).toBe(
    "@busyboy ",
  );
});

it("keeps the side chat out of the Director chat, quotes it, and deletes it on close", async () => {
  render();
  await type("Message", "/side");
  click(host.querySelector("button[aria-label='Send']"));
  expect(server.sentToDirector).toEqual([]);
  const sheet = byTestId("side-chat-sheet")!;
  expect(sheet.textContent).toContain("Temporary · gone when closed");
  await act(async () => {});

  await type("Side chat message", "what if email?");
  click(host.querySelector("button[aria-label='Send side chat message']"));
  expect(server.sentToSide).toEqual(["what if email?"]);
  expect(server.sentToDirector).toEqual([]);

  click(buttonWith("Quote in main chat"));
  expect(host.querySelector<HTMLTextAreaElement>("textarea[aria-label='Message']")!.value).toContain(
    "> Reply to: what if email?",
  );

  click(buttonWith("Close", byTestId("side-chat-sheet")!));
  expect(server.deleted).toEqual(["side"]);
});
