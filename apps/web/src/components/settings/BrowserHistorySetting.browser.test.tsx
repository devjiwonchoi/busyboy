import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { clearBrowsingHistory, importChromeHistory } = vi.hoisted(() => ({
  clearBrowsingHistory: vi.fn().mockResolvedValue(undefined),
  importChromeHistory: vi.fn(),
}));

vi.mock(import("../preview/previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: { clearBrowsingHistory, importChromeHistory } as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: (({ control, children }: { control: unknown; children: unknown }) => (
    <div>
      {control as never}
      {children as never}
    </div>
  )) as never,
}));

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { recordVisitForThread, useBrowserHistoryStore } from "~/browserHistoryStore";
import { readThreadPreviewState, rememberPreviewUrl } from "~/previewStateStore";

import { BrowserHistorySetting } from "./BrowserHistorySetting";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const buttonNamed = (name: string) =>
  [...document.querySelectorAll("button")].find((button) => button.textContent === name);

describe("BrowserHistorySetting", () => {
  it("clears the address-bar history and recently used pages after confirming", async () => {
    useBrowserHistoryStore.setState({
      byProjectKey: {
        project: [{ url: "https://reset.example.com/?token=abc", lastVisitedAt: 1 }],
      },
    });
    // A thread whose project is not known yet keeps its visits pending.
    const thread = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread"));
    recordVisitForThread(thread, "https://pending.example.com/", 2);
    rememberPreviewUrl(thread, "https://seen.example.com/");
    await act(async () => root.render(<BrowserHistorySetting disabled={false} />));

    await act(async () => buttonNamed("Clear history")!.click());
    expect(document.body.textContent).toContain("Clear browsing history?");
    expect(clearBrowsingHistory).not.toHaveBeenCalled();

    const confirm = [...document.querySelectorAll("button")].filter(
      (button) => button.textContent === "Clear history",
    );
    await act(async () => confirm.at(-1)!.click());

    await vi.waitFor(() => expect(clearBrowsingHistory).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(useBrowserHistoryStore.getState().byProjectKey).toEqual({}));
    expect(useBrowserHistoryStore.getState().pendingVisitsByThreadKey).toEqual({});
    expect(readThreadPreviewState(thread).recentlySeenUrls).toEqual([]);
  });

  it("keeps Clear history unavailable while a Chrome import runs", async () => {
    let finishImport = (_result: { imported: number }) => {};
    importChromeHistory.mockReturnValue(
      new Promise((resolve) => {
        finishImport = resolve;
      }),
    );
    await act(async () => root.render(<BrowserHistorySetting disabled={false} />));

    await act(async () => buttonNamed("Import from Chrome")!.click());
    expect(buttonNamed("Clear history")!.disabled).toBe(true);

    await act(async () => finishImport({ imported: 3 }));
    await vi.waitFor(() => expect(buttonNamed("Clear history")!.disabled).toBe(false));
  });
});
