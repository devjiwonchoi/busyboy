import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  type BrowserHistoryChangedEvent,
  type BrowserHistoryClearInput,
  type BrowserHistoryRemoveInput,
  type BrowserHistorySearchInput,
  type BrowserHistoryVisit,
  type DesktopBrowserHistoryBridge,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

vi.mock(import("../../env"), async (original) => ({ ...(await original()), isElectron: true }));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [{ environmentId: ENVIRONMENT_ID, label: "Local" }],
    isReady: true,
  })) as never,
  usePrimaryEnvironment: () => null,
  usePrimaryEnvironmentId: () => null,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
  useClientSettingsHydrated: () => true,
  usePrimarySettingsAvailable: () => true,
  usePrimarySettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
  useUpdatePrimarySettings: (() => vi.fn()) as never,
}));
vi.mock(import("./ProjectDefaultsSettings"), async (original) => ({
  ...(await original()),
  ProjectDefaultsSettings: (() => null) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: [] },
    search: {},
    environment: null,
    environments: [],
    target: null,
    connectedEnvironments: [],
    targets: [],
  })) as never,
  useOptionalSettingsScope: () => null,
}));

import { IntegrationsSettingsPanel } from "./IntegrationsSettings";

const MINUTE = 60_000;

function visit(id: number, url: string, title: string, agoMs: number, agent = false) {
  return {
    id,
    url,
    title,
    visitedAt: Date.now() - agoMs,
    transition: agent ? "agent" : "typed",
    source: agent ? "agent" : "user",
    threadId: null,
  } satisfies BrowserHistoryVisit;
}

/** An in-memory stand-in for the desktop history store. */
function createFakeHistoryBridge(initial: ReadonlyArray<BrowserHistoryVisit>) {
  let visits = [...initial];
  const listeners = new Set<(event: BrowserHistoryChangedEvent) => void>();
  const emit = (profileId: string) => {
    for (const listener of listeners) listener({ profileId });
  };
  const bridge = {
    search: vi.fn(async (input: BrowserHistorySearchInput) => {
      const query = input.query?.toLowerCase() ?? "";
      const matches = visits
        .filter(
          (candidate) =>
            (input.source ?? "all") === "all" || candidate.source === (input.source as string),
        )
        .filter(
          (candidate) =>
            query.length === 0 ||
            candidate.url.toLowerCase().includes(query) ||
            (candidate.title ?? "").toLowerCase().includes(query),
        )
        .toSorted((a, b) => b.visitedAt - a.visitedAt);
      return { visits: matches.slice(0, input.limit), nextCursor: null };
    }),
    recent: vi.fn(async () => []),
    remove: vi.fn(async (input: BrowserHistoryRemoveInput) => {
      visits = visits.filter((candidate) => !input.visitIds?.includes(candidate.id));
      emit(input.profileId);
    }),
    clear: vi.fn(async (input: BrowserHistoryClearInput) => {
      if (input.range === "hour" && input.dataTypes.includes("history")) {
        const cutoff = Date.now() - 60 * MINUTE;
        visits = visits.filter((candidate) => candidate.visitedAt < cutoff);
      }
      emit(input.profileId);
    }),
    importLegacy: vi.fn(async () => ({ imported: 0 })),
    suggest: vi.fn(async () => ({ matches: [], topOrigin: null })),
    frequent: vi.fn(async () => []),
    remoteSuggestions: vi.fn(async () => ({ suggestions: [] })),
    status: vi.fn(async () => ({ available: true, deletionLocked: false })),
    onChanged: (listener: (event: BrowserHistoryChangedEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } satisfies DesktopBrowserHistoryBridge;
  return bridge;
}

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
  delete (window as { desktopBridge?: unknown }).desktopBridge;
  vi.unstubAllGlobals();
});

async function openSettings() {
  const router = createRouter({
    routeTree: createRootRoute({ component: IntegrationsSettingsPanel }),
    history: createMemoryHistory(),
  });
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
}

function historyRowTitles(): string[] {
  const list = container.querySelector('[role="list"][aria-label="Browsing history"]');
  return [...(list?.querySelectorAll('[role="listitem"]') ?? [])].map(
    (row) => row.querySelector("button span.truncate")?.textContent ?? "",
  );
}

describe("Settings → Browsing history", () => {
  it("searches, removes a visit, and clears the last hour of history", async () => {
    const bridge = createFakeHistoryBridge([
      visit(1, "http://localhost:5173/", "Dev server", 5 * MINUTE),
      visit(2, "https://docs.example.com/guide", "Docs guide", 20 * MINUTE, true),
      visit(3, "https://docs.example.com/api", "Docs API", 30 * MINUTE),
      visit(4, "https://news.example.org/", "News", 3 * 60 * MINUTE),
    ]);
    (window as { desktopBridge?: unknown }).desktopBridge = { browserHistory: bridge };

    await openSettings();
    await vi.waitFor(() =>
      expect(historyRowTitles()).toEqual(["Dev server", "Docs guide", "Docs API", "News"]),
    );
    expect(bridge.status).toHaveBeenCalledWith({ profileId: "default" });
    await expect.element(page.getByText("Agent", { exact: true }).first()).toBeVisible();

    await userEvent.type(page.getByRole("searchbox", { name: "Search history" }), "docs");
    await vi.waitFor(() => expect(historyRowTitles()).toEqual(["Docs guide", "Docs API"]));
    expect(bridge.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ profileId: "default", query: "docs" }),
    );

    await userEvent.click(page.getByRole("button", { name: "Remove Docs API from history" }));
    expect(bridge.remove).toHaveBeenCalledExactlyOnceWith({ profileId: "default", visitIds: [3] });
    await vi.waitFor(() => expect(historyRowTitles()).toEqual(["Docs guide"]));

    await userEvent.clear(page.getByRole("searchbox", { name: "Search history" }));
    await vi.waitFor(() =>
      expect(historyRowTitles()).toEqual(["Dev server", "Docs guide", "News"]),
    );

    await userEvent.click(page.getByRole("button", { name: "Clear browsing data…" }));
    const dialog = page.getByRole("dialog", { name: "Clear browsing data" });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(dialog.getByRole("combobox", { name: "Time range" }))
      .toHaveTextContent("Last hour");
    await expect.element(dialog.getByRole("checkbox", { name: "Browsing history" })).toBeChecked();
    await expect
      .element(dialog.getByRole("checkbox", { name: "Cookies and site data" }))
      .not.toBeChecked();
    await expect
      .element(dialog.getByText("Saved passwords are managed in Passwords."))
      .toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Clear", exact: true }));

    expect(bridge.clear).toHaveBeenCalledExactlyOnceWith({
      profileId: "default",
      range: "hour",
      dataTypes: ["history"],
      environmentIds: [ENVIRONMENT_ID],
    });
    await vi.waitFor(() => expect(historyRowTitles()).toEqual(["News"]));
  });
});
