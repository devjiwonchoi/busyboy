// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// iOS reads the pill from the native header items; Android renders it as the app bar's
// trailing content. The fake AppBar exposes both, so each platform's path is checked.
const harness = vi.hoisted(() => ({
  rightItems: [] as ReadonlyArray<Record<string, unknown>>,
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
    Alert: { alert: () => {} },
    Linking: {},
    Platform: {},
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

import { ThreadHeader } from "./ThreadHeader";

// The route screen passes `runsInCloud` from the thread's own location, so a cloud
// delegate child with no task shows the pill too.
function Header(props: { readonly location?: "local" | "cloud" }) {
  return (
    <ThreadHeader
      title="Fix drag scroll"
      subtitle=""
      headerColor="#000"
      usesNativeHeaderGlass
      runsInCloud={props.location === "cloud"}
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

function render(element: React.ReactElement) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container ??= document.createElement("div");
  root ??= createRoot(container);
  act(() => root!.render(element));
}

/** The native header's Cloud item, rendered the way the header would draw it. */
function nativeCloudItemText(): string | null {
  const item = harness.rightItems.find((entry) => entry.identifier === "thread-right-cloud");
  if (item === undefined) return null;
  const host = document.createElement("div");
  const itemRoot = createRoot(host);
  act(() => itemRoot.render(item.element as React.ReactElement));
  const text = host.textContent;
  act(() => itemRoot.unmount());
  return text;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.rightItems = [];
});

describe("ThreadHeader cloud pill", () => {
  it("shows a small Cloud pill for a thread that runs in the cloud", () => {
    render(<Header location="cloud" />);
    expect(nativeCloudItemText()).toBe("Cloud");
    // The pill comes first, nearest the title, ahead of the Git controls.
    expect(harness.rightItems[0]?.identifier).toBe("thread-right-cloud");
    const pill = container.querySelector('[data-testid="thread-cloud-pill"]');
    expect(pill?.textContent).toBe("Cloud");
    expect(pill?.getAttribute("aria-label")).toBe("Cloud, runs in a cloud sandbox");
  });

  it("shows no Cloud pill for a local thread", () => {
    render(<Header location="local" />);
    expect(harness.rightItems.length).toBeGreaterThan(0);
    expect(nativeCloudItemText()).toBeNull();
    expect(container.textContent).not.toContain("Cloud");
  });

  it("shows no Cloud pill when the thread has no location", () => {
    render(<Header />);
    expect(nativeCloudItemText()).toBeNull();
    expect(container.querySelector('[data-testid="thread-cloud-pill"]')).toBeNull();
  });

  it("adds the pill when the thread's location turns to cloud", () => {
    render(<Header />);
    expect(nativeCloudItemText()).toBeNull();
    render(<Header location="cloud" />);
    expect(nativeCloudItemText()).toBe("Cloud");
  });
});
