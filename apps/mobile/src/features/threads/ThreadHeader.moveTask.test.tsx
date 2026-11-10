// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// iOS reads the button from the native header items; Android renders it as the app bar's
// trailing content. The fake AppBar exposes both, so each platform's path is checked.
const harness = vi.hoisted(() => ({
  rightItems: [] as ReadonlyArray<Record<string, unknown>>,
  task: null as null | Record<string, unknown>,
  moves: [] as Array<{ environmentId: string; input: Record<string, unknown> }>,
  finishMove: null as null | ((result: unknown) => void),
  toasts: [] as Array<{ type: string; title: string; description?: string }>,
  leadDriver: "claudeAgent",
}));

vi.mock("@react-navigation/native", () => {
  const navigation = {
    canGoBack: () => true,
    dispatch: () => {},
    goBack: () => {},
    navigate: () => {},
    addListener: () => () => {},
    setOptions: (options: { unstable_headerRightItems?: () => Array<Record<string, unknown>> }) => {
      harness.rightItems = options.unstable_headerRightItems?.() ?? [];
    },
  };
  return { StackActions: { replace: () => ({}) }, useNavigation: () => navigation };
});
vi.mock("../../native/useOpenPullRequest", () => ({ useOpenPullRequest: () => () => {} }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/projectTeam", () => ({
  useLeadThreadTask: () => harness.task,
  useMoveTask: () => (environmentId: string, input: Record<string, unknown>) => {
    harness.moves.push({ environmentId, input });
    return new Promise((resolve) => {
      harness.finishMove = resolve;
    });
  },
}));
vi.mock("../../state/use-vcs-action-state", () => ({
  showGitActionResult: (result: { type: string; title: string; description?: string }) =>
    harness.toasts.push(result),
}));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { providersByEnvironmentAtom: "providers-atom" },
}));
vi.mock("@effect/atom-react", async (original) => {
  const actual = await original<typeof import("@effect/atom-react")>();
  return {
    ...actual,
    useAtomValue: ((atom: unknown) =>
      atom === "providers-atom"
        ? new Map([["environment-1", [{ instanceId: "claude-1", driver: harness.leadDriver }]]])
        : actual.useAtomValue(atom as never)) as typeof actual.useAtomValue,
  };
});
vi.mock("../../components/ui/AppBar", async () => {
  const { NativeStackScreenOptions } = await import("../../native/StackHeader");
  return {
    AppBar: (props: import("../../components/ui/AppBar.types").AppBarProps) => (
      <>
        <NativeStackScreenOptions options={props.options} optionsVersion={props.optionsVersion} />
        <div data-testid="app-bar-trailing">{props.trailing}</div>
      </>
    ),
  };
});
vi.mock("react-native", () => {
  const passthrough =
    (tag: "div" | "span") =>
    (props: { children?: ReactNode; testID?: string; accessibilityLabel?: string }) => {
      const Tag = tag;
      return (
        <Tag data-testid={props.testID} aria-label={props.accessibilityLabel}>
          {props.children}
        </Tag>
      );
    };
  return {
    ActivityIndicator: () => <span data-testid="spinner" />,
    Alert: { alert: () => {} },
    Linking: {},
    Platform: {},
    Pressable: (props: {
      children?: ReactNode;
      testID?: string;
      accessibilityLabel?: string;
      accessibilityHint?: string;
      accessibilityState?: { disabled?: boolean };
      onPress?: () => void;
    }) => (
      <button
        type="button"
        data-testid={props.testID}
        aria-label={props.accessibilityLabel}
        aria-description={props.accessibilityHint}
        aria-disabled={props.accessibilityState?.disabled}
        onClick={props.onPress}
      >
        {props.children}
      </button>
    ),
    View: passthrough("div"),
    Text: passthrough("span"),
    TextInput: passthrough("span"),
  };
});
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: false },
    panes: { primarySidebarVisible: false, auxiliaryPaneVisible: false },
    togglePrimarySidebar: () => {},
    toggleAuxiliaryPane: () => {},
  }),
}));
vi.mock("../layout/native-mail-search-toolbar", () => ({
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED: true,
  createNativeMailSearchToolbarItem: () => ({}),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));

import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useMoveTaskControl } from "./useMoveTaskControl";
import { ThreadHeader } from "./ThreadHeader";

const THREAD = {
  environmentId: "environment-1",
  projectId: "project-1",
  id: "thread-1",
  providerInstanceId: "claude-1",
} as never;

// The route screen derives the control from the thread, as here.
function Header() {
  const moveTask = useMoveTaskControl(THREAD);
  return (
    <ThreadHeader
      title="Fix drag scroll"
      subtitle=""
      headerColor="#000"
      usesNativeHeaderGlass
      moveTask={moveTask}
      gitControls={{
        environmentId: "environment-1",
        threadId: "thread-1",
        currentBranch: "master",
        gitStatus: null,
        gitOperationLabel: null,
        onPull: async () => {},
        onRunAction: async () => null,
        canOpenTerminal: true,
        canOperateTerminal: true,
        canOpenFiles: true,
        projectScripts: [],
        terminalSessions: [],
        onOpenTerminal: () => {},
        onOpenNewTerminal: () => {},
        onRunProjectScript: async () => {},
      }}
      hasThreadCwd
      hasWorkspaceRoot
      fileInspectorSupported={false}
      inspectorMode={null}
      onToggleInspector={() => {}}
      onOpenGitInspector={() => {}}
      onOpenFilesInspector={() => {}}
    />
  );
}

let root: Root | null = null;
let container: HTMLDivElement;

function render() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container ??= document.createElement("div");
  root ??= createRoot(container);
  act(() => root!.render(<Header />));
}

/** The native header's move item, mounted the way the header would draw it. */
function withNativeMoveItem<T>(read: (host: HTMLElement) => T): T | null {
  const item = harness.rightItems.find((entry) => entry.identifier === "thread-right-move-task");
  if (item === undefined) return null;
  const host = document.createElement("div");
  const itemRoot = createRoot(host);
  act(() => itemRoot.render(item.element as React.ReactElement));
  const value = read(host);
  act(() => itemRoot.unmount());
  return value;
}

const trailing = () => container.querySelector('[data-testid="app-bar-trailing"]')!;
const trailingButton = () => trailing().querySelector("button");

function setTask(patch: Record<string, unknown>) {
  harness.task = { ...harness.task, ...patch };
  render();
}

beforeEach(() => {
  harness.task = {
    id: "task-7",
    stage: "running",
    leadThreadId: "thread-1",
    location: "local",
    moveTarget: null,
  };
  harness.moves = [];
  harness.finishMove = null;
  harness.toasts = [];
  harness.leadDriver = "claudeAgent";
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.rightItems = [];
});

describe("ThreadHeader move button", () => {
  it("moves a local lead to the cloud, with a pill while it moves, then offers to bring it back", async () => {
    render();
    expect(trailingButton()?.textContent).toBe("클라우드로 옮기기");
    expect(withNativeMoveItem((host) => host.textContent)).toBe("클라우드로 옮기기");

    // Pressing the native (iOS) item starts the move with the latest callbacks.
    withNativeMoveItem((host) => act(() => host.querySelector("button")!.click()));
    expect(harness.moves).toEqual([
      {
        environmentId: "environment-1",
        input: { projectId: "project-1", taskId: "task-7", to: "cloud" },
      },
    ]);
    expect(trailing().textContent).toBe("클라우드로 옮기는 중…");
    expect(trailingButton()).toBeNull();
    expect(withNativeMoveItem((host) => host.textContent)).toBe("클라우드로 옮기는 중…");

    // The server marks the task moving, then finishes in the cloud.
    setTask({ moveTarget: "cloud" });
    expect(trailing().textContent).toBe("클라우드로 옮기는 중…");
    await act(async () => {
      harness.task = { ...harness.task, location: "cloud", moveTarget: null };
      harness.finishMove!(AsyncResult.success(undefined));
    });
    render();
    expect(trailingButton()?.textContent).toBe("로컬로 가져오기");
    expect(withNativeMoveItem((host) => host.textContent)).toBe("로컬로 가져오기");

    act(() => trailingButton()!.click());
    expect(harness.moves.at(-1)?.input.to).toBe("local");
    expect(trailing().textContent).toBe("로컬로 가져오는 중…");
    expect(harness.toasts).toEqual([]);
  });

  it("shows the pill for a move already running", () => {
    harness.task = { ...harness.task, location: "cloud", moveTarget: "local" };
    render();
    expect(trailing().textContent).toBe("로컬로 가져오는 중…");
    expect(container.querySelector('[data-testid="thread-move-task-moving"]')).not.toBeNull();
  });

  it("shows a toast and the button again when the move fails", async () => {
    render();
    act(() => trailingButton()!.click());
    await act(async () => {
      harness.finishMove!(AsyncResult.failure(Cause.fail(new Error("이미 옮기는 중이에요."))));
    });
    expect(trailingButton()?.textContent).toBe("클라우드로 옮기기");
    expect(harness.toasts).toEqual([
      { type: "error", title: "클라우드로 옮기지 못했어요", description: "이미 옮기는 중이에요." },
    ]);
  });

  it("disables the button for a finished task and says why on press", () => {
    harness.task = { ...harness.task, stage: "done" };
    render();
    const button = trailingButton()!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-description")).toBe("끝난 태스크는 옮길 수 없어요");
    act(() => button.click());
    expect(harness.moves).toEqual([]);
    expect(harness.toasts).toEqual([
      { type: "error", title: "옮길 수 없어요", description: "끝난 태스크는 옮길 수 없어요" },
    ]);
  });

  it("disables the button for a lead that is not Claude", () => {
    harness.leadDriver = "codex";
    render();
    expect(trailingButton()?.getAttribute("aria-description")).toBe("Claude 리드만 옮길 수 있어요");
    act(() => trailingButton()!.click());
    expect(harness.moves).toEqual([]);
  });

  it("shows no move button on a thread that leads no task", () => {
    harness.task = null;
    render();
    expect(trailingButton()).toBeNull();
    expect(withNativeMoveItem(() => true)).toBeNull();
  });
});
