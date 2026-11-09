import "~/index.css";

import type { ScopedThreadRef } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () => ({ theme: "light", resolvedTheme: "light", themeHalves: null }) as never,
}));
vi.mock(import("~/browser/browserDefaults"), async (original) => ({
  ...(await original()),
  useBrowserDefaults: () => ({ profiles: [] }) as never,
}));

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "~/rightPanelLayout";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { RightPanelSheet } from "./RightPanelSheet";
import { RightPanelTabs } from "./RightPanelTabs";

const LEAD = { environmentId: "env-1", threadId: "lead" } as unknown as ScopedThreadRef;
const PM = { environmentId: "env-1", threadId: "pm" } as unknown as ScopedThreadRef;
const noop = () => undefined;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  await page.viewport(1280, 800);
});

/** Wired like ChatView: the real panel (inline on desktop, a sheet on phones) on the real store. */
function ThreadView(props: { threadRef: ScopedThreadRef; hasPlan: boolean }) {
  const ref = props.threadRef;
  const panel = useRightPanelStore((store) => selectThreadRightPanelState(store.byThreadKey, ref));
  const sheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const active = panel.surfaces.find((surface) => surface.id === panel.activeSurfaceId) ?? null;
  const store = useRightPanelStore.getState;
  const tabs = (
    <RightPanelTabs
      mode={sheet ? "sheet" : "inline"}
      open={panel.isOpen}
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      getShortcutContext={() => ({
        terminalFocus: false,
        terminalOpen: false,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      })}
      surfaces={panel.surfaces}
      environmentId={null}
      activeSurfaceId={active?.id ?? null}
      pendingSurfaceIds={new Set()}
      previewSessions={{}}
      desktopByTabId={{}}
      terminalLabelsById={new Map()}
      onActivate={(surface) => store().activateSurface(ref, surface.id)}
      onCloseSurface={(surface) => store().closeSurface(ref, surface.id)}
      onCloseOtherSurfaces={noop}
      onCloseSurfacesToRight={noop}
      onCloseAllSurfaces={() => store().closeAllSurfaces(ref)}
      onCopyFilePath={noop}
      onAddBrowser={noop}
      onAddBrowserInProfile={noop}
      onAddTerminal={noop}
      onAddDiff={noop}
      onAddFiles={noop}
      onAddPullRequest={noop}
      onAddPullRequests={noop}
      onAddSideChat={noop}
      onAddTaskPlan={() => store().open(ref, "task-plan")}
      taskPlanAvailable={props.hasPlan}
      browserAvailable={false}
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable={false}
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      sideChatAvailable={false}
    >
      {active?.kind === "task-plan" ? <div data-testid="plan-body">플랜</div> : null}
    </RightPanelTabs>
  );
  return (
    <div style={{ display: "flex", height: "100vh", width: "100%" }}>
      <div style={{ flex: 1, minWidth: 0 }}>chat {ref.threadId}</div>
      {sheet ? (
        <RightPanelSheet
          animationDurationMs={0}
          open={panel.isOpen}
          onClose={() => store().close(ref)}
        >
          {tabs}
        </RightPanelSheet>
      ) : panel.isOpen ? (
        tabs
      ) : null}
    </div>
  );
}

async function renderEmptyPanel(threadRef: ScopedThreadRef, hasPlan: boolean) {
  await act(async () => root.render(<ThreadView threadRef={threadRef} hasPlan={hasPlan} />));
  // The user opens the panel themselves; it starts on "Open a surface".
  await act(() => useRightPanelStore.getState().show(threadRef));
  return vi.waitFor(() => {
    const launcher = document.querySelector<HTMLElement>('[aria-label="Open a surface"]');
    if (!launcher) throw new Error("no launcher");
    return launcher;
  });
}

const planBody = () => document.querySelector('[data-testid="plan-body"]');
const launcherRows = (launcher: HTMLElement) =>
  [...launcher.querySelectorAll<HTMLElement>("button, [aria-disabled]")].filter(
    (row) => row.getAttribute("aria-label") === null,
  );
const launcherRow = (launcher: HTMLElement, label: string) =>
  launcherRows(launcher).find((row) => row.textContent?.startsWith(label))!;

async function openMenu() {
  await userEvent.click(document.querySelector<HTMLElement>('[aria-label="Add panel surface"]')!);
  return vi.waitFor(() => {
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    if (items.length === 0) throw new Error("no menu");
    return items;
  });
}
const menuItem = (items: HTMLElement[], label: string) =>
  items.find((item) => item.textContent?.startsWith(label))!;

for (const [device, width, height] of [
  ["desktop", 1280, 800],
  ["phone", 390, 844],
] as const) {
  describe(`right panel launchers on ${device}`, () => {
    it("lists Plan first in both lists, with no Project entry, and opens it in the panel", async () => {
      await page.viewport(width, height);
      const launcher = await renderEmptyPanel(LEAD, true);
      expect(launcherRows(launcher)[0]!.textContent).toBe("PlanN");
      // All projects is its own page now, not a panel surface.
      expect(launcherRow(launcher, "Project")).toBeUndefined();
      await page.screenshot({ path: `__screenshots__/launcher-open-a-surface-${device}.png` });
      await userEvent.keyboard("j");
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, LEAD).surfaces,
      ).toEqual([]);

      // "+" menu: Plan comes first and opens the plan.
      await userEvent.click(launcherRow(launcher, "Plan"));
      await vi.waitFor(() => expect(planBody()).not.toBeNull());
      const items = await openMenu();
      expect(items[0]!.textContent).toBe("PlanN");
      expect(menuItem(items, "Project")).toBeUndefined();
      await page.screenshot({ path: `__screenshots__/launcher-plus-menu-${device}.png` });
      await userEvent.keyboard("{Escape}");

      // Back on an empty panel, the shortcut opens it too.
      await act(() => useRightPanelStore.getState().closeAllSurfaces(LEAD));
      await act(() => useRightPanelStore.getState().show(LEAD));
      await vi.waitFor(() =>
        expect(document.querySelector('[aria-label="Open a surface"]')).not.toBeNull(),
      );
      await userEvent.keyboard("n");
      await vi.waitFor(() => expect(planBody()).not.toBeNull());
    });

    it("shows Plan disabled in both lists on a thread without a plan", async () => {
      await page.viewport(width, height);
      const launcher = await renderEmptyPanel(PM, false);
      const row = launcherRow(launcher, "Plan");
      expect(row.getAttribute("aria-disabled")).toBe("true");
      await userEvent.keyboard("n");
      await userEvent.click(row);
      expect(planBody()).toBeNull();
      await page.screenshot({ path: `__screenshots__/launcher-plan-disabled-${device}.png` });

      const items = await openMenu();
      const plan = menuItem(items, "Plan");
      expect(plan.getAttribute("aria-disabled")).toBe("true");
      await page.screenshot({ path: `__screenshots__/launcher-plus-plan-disabled-${device}.png` });
      await userEvent.keyboard("n");
      expect(planBody()).toBeNull();
    });
  });
}
