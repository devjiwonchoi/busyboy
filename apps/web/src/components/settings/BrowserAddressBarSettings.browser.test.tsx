import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

// A tiny client-settings store so the rows re-render as the user changes them.
const store = vi.hoisted(() => {
  let settings = {} as ClientSettings;
  const listeners = new Set<() => void>();
  return {
    get: () => settings,
    reset: (next: ClientSettings) => {
      settings = next;
    },
    update: vi.fn((patch: Partial<ClientSettings>) => {
      settings = { ...settings, ...patch };
      for (const listener of listeners) listener();
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: ClientSettings) => unknown) => {
    const settings = useSyncExternalStore(store.subscribe, store.get);
    return selector ? selector(settings) : settings;
  }) as never,
  useUpdatePrimarySettings: (() => store.update) as never,
}));

import { BrowserAddressBarSettings } from "./BrowserAddressBarSettings";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  store.reset(DEFAULT_CLIENT_SETTINGS);
  store.update.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function openSettings() {
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <BrowserAddressBarSettings disabled={false} />,
    }),
    history: createMemoryHistory(),
  });
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
}

describe("Settings → Browser → Address bar", () => {
  it("sets a custom search engine and turns on search suggestions", async () => {
    await openSettings();

    // Search suggestions start off: nothing typed leaves the device by default.
    const suggestions = page.getByRole("switch", { name: "Search suggestions" });
    await expect.element(suggestions).not.toBeChecked();
    await expect
      .element(page.getByRole("switch", { name: "Suggest frequent sites" }))
      .toBeChecked();

    await userEvent.click(page.getByRole("combobox", { name: "Search engine" }));
    await userEvent.click(page.getByRole("option", { name: "Custom" }));
    expect(store.update).toHaveBeenLastCalledWith({ browserSearchEngine: "custom" });

    const customUrl = page.getByRole("textbox", { name: "Custom search URL" });
    await userEvent.fill(customUrl, "https://example.com/search");
    await userEvent.keyboard("{Enter}");
    // toHaveTextContent mis-handles the literal "%s" in this message, so read it directly.
    const alert = page.getByRole("alert");
    await expect.element(alert).toBeVisible();
    expect(alert.element().textContent).toContain("Until then, DuckDuckGo is used.");
    await expect.element(customUrl).toHaveAttribute("aria-invalid", "true");

    await userEvent.fill(customUrl, "https://example.com/search?q=%s");
    await userEvent.keyboard("{Enter}");
    expect(store.update).toHaveBeenLastCalledWith({
      browserCustomSearchUrl: "https://example.com/search?q=%s",
    });
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();

    await userEvent.click(suggestions);
    expect(store.update).toHaveBeenLastCalledWith({ browserRemoteSearchSuggestions: true });
    await expect.element(suggestions).toBeChecked();
    await expect.element(page.getByText(/what you type is sent to/)).toBeVisible();
  });
});
