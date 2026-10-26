import { EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const titles = vi.hoisted(
  () =>
    new Map([
      ["first-thread", "Explain the cache"],
      ["second-thread", "Rename helpers"],
    ]),
);

vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/browser/browserDefaults", () => ({ useBrowserDefaults: () => ({ profiles: [] }) }));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: ((ref: { threadId: string } | null) => {
    const title = ref === null ? undefined : titles.get(ref.threadId);
    return title === undefined ? null : { title };
  }) as never,
}));

import type { RightPanelSurface } from "../rightPanelStore";
import { RightPanelTabs } from "./RightPanelTabs";

const first = {
  id: "side-chat:first-thread",
  kind: "side-chat",
  threadId: "first-thread",
} as const;
const second = {
  id: "side-chat:second-thread",
  kind: "side-chat",
  threadId: "second-thread",
} as const;
const noop = () => undefined;
let root: Root;
let onActivate: ReturnType<typeof vi.fn<(surface: RightPanelSurface) => void>>;
let onAddSideChat: ReturnType<typeof vi.fn<() => void>>;

async function render() {
  await act(() =>
    root.render(
      <RightPanelTabs
        mode="inline"
        open
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        getShortcutContext={() => ({
          terminalFocus: false,
          terminalOpen: false,
          previewFocus: false,
          previewOpen: false,
          isWeb: true,
          isDesktop: false,
        })}
        surfaces={[first, second]}
        environmentId={EnvironmentId.make("environment")}
        activeSurfaceId={second.id}
        pendingSurfaceIds={new Set()}
        previewSessions={{}}
        desktopByTabId={{}}
        terminalLabelsById={new Map()}
        onActivate={onActivate}
        onCloseSurface={noop}
        onCloseOtherSurfaces={noop}
        onCloseSurfacesToRight={noop}
        onCloseAllSurfaces={noop}
        onCopyFilePath={noop}
        onAddBrowser={noop}
        onAddBrowserInProfile={noop}
        onAddTerminal={noop}
        onAddDiff={noop}
        onAddFiles={noop}
        onAddPullRequest={noop}
        onAddPullRequests={noop}
        onAddSideChat={onAddSideChat}
        browserAvailable={false}
        terminalAvailable={false}
        diffAvailable={false}
        filesAvailable={false}
        pullRequestAvailable={false}
        pullRequestsAvailable={false}
        sideChatAvailable
      >
        <div>content</div>
      </RightPanelTabs>,
    ),
  );
}

beforeEach(() => {
  onActivate = vi.fn<(surface: RightPanelSurface) => void>();
  onAddSideChat = vi.fn<() => void>();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("side chat tabs", () => {
  it("keeps each side chat as its own tab, titled by its conversation", async () => {
    await render();
    await expect.element(page.getByText("Explain the cache")).toBeVisible();
    await expect.element(page.getByText("Rename helpers")).toBeVisible();

    await userEvent.click(page.getByText("Explain the cache"));
    expect(onActivate).toHaveBeenCalledWith(first);
  });

  it("adds another side chat from the panel's add menu", async () => {
    await render();
    await userEvent.click(page.getByRole("button", { name: "Add panel surface" }));
    await userEvent.click(page.getByRole("menuitem", { name: /Side chat/ }));
    expect(onAddSideChat).toHaveBeenCalledOnce();
  });
});
