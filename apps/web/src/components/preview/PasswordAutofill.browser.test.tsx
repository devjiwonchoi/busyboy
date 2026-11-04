import type { BrowserPasswordAutofillEvent } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { usePasswordAutofillStore } from "~/browser/passwordAutofillStore";

import { PreviewPasswordOverlays } from "./PasswordFillList";
import { PasswordPromptKeyButton } from "./PasswordSavePrompt";

const TAB = "tab-1";

function installBridge() {
  const autofill = {
    onEvent: () => () => {},
    choose: vi.fn(async () => {}),
    dismissFillList: vi.fn(async () => {}),
    respondToPrompt: vi.fn(async () => {}),
    peek: vi.fn(async () => ({ password: "correct-horse" })),
    reopenPrompt: vi.fn(async () => {}),
  };
  (window as { desktopBridge?: unknown }).desktopBridge = { browserPasswords: { autofill } };
  return autofill;
}

const emit = (event: BrowserPasswordAutofillEvent) =>
  act(() => usePasswordAutofillStore.getState().apply(event));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  container.style.position = "relative";
  container.style.width = "800px";
  container.style.height = "600px";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  usePasswordAutofillStore.setState({ fillLists: {}, prompts: {} });
  delete (window as { desktopBridge?: unknown }).desktopBridge;
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () =>
    root.render(
      <>
        <PasswordPromptKeyButton tabId={TAB} />
        <PreviewPasswordOverlays tabId={TAB} zoomFactor={1} />
      </>,
    ),
  );
}

describe("in-page password autofill", () => {
  it("lists saved logins under the field and asks main to fill the chosen one", async () => {
    const autofill = installBridge();
    await render();
    await emit({
      type: "fillList",
      tabId: TAB,
      requestId: "req-1",
      rect: { x: 10, y: 20, width: 200, height: 24 },
      rows: [
        { loginId: 1, username: "alice" },
        { loginId: 2, username: "bob" },
      ],
      frameOrigin: "http://localhost:4001",
      selectedIndex: 1,
    });

    const list = page.getByRole("listbox", { name: /Saved passwords for localhost:4001/ });
    await expect.element(list).toBeVisible();
    await expect.element(page.getByText("For localhost:4001")).toBeVisible();
    await expect
      .element(list.getByRole("option", { name: "bob" }))
      .toHaveAttribute("aria-selected", "true");

    await userEvent.click(list.getByRole("option", { name: "alice" }));
    expect(autofill.choose).toHaveBeenCalledWith({ tabId: TAB, requestId: "req-1", loginId: 1 });

    await emit({ type: "fillListClosed", tabId: TAB });
    expect(page.getByRole("listbox").elements()).toHaveLength(0);
  });

  it("offers to save after sign-in, peeks without a check, and saves the edited username", async () => {
    const autofill = installBridge();
    await render();
    await emit({
      type: "savePrompt",
      tabId: TAB,
      promptId: "p-1",
      mode: "save",
      origin: "http://127.0.0.1:4000",
      frameOrigin: null,
      username: "alice",
      collapsed: false,
    });

    const dialog = page.getByRole("dialog", { name: "Save password?" });
    await expect.element(dialog.getByText("127.0.0.1:4000")).toBeVisible();
    await expect.element(dialog.getByText("••••••••")).toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Show password" }));
    await expect.element(dialog.getByText("correct-horse")).toBeVisible();
    expect(autofill.peek).toHaveBeenCalledWith({ tabId: TAB, promptId: "p-1" });

    await userEvent.fill(dialog.getByRole("textbox", { name: "Username" }), "alice@example.com");
    await userEvent.click(dialog.getByRole("button", { name: "Save", exact: true }));
    expect(autofill.respondToPrompt).toHaveBeenCalledWith({
      tabId: TAB,
      promptId: "p-1",
      action: "save",
      username: "alice@example.com",
    });
  });

  it("offers an update without 'Never', and 'Never for this site' on new logins", async () => {
    const autofill = installBridge();
    await render();
    await emit({
      type: "savePrompt",
      tabId: TAB,
      promptId: "p-2",
      mode: "update",
      origin: "http://127.0.0.1:4000",
      frameOrigin: null,
      username: "alice",
      collapsed: false,
    });
    const update = page.getByRole("dialog", { name: "Update saved password?" });
    await expect.element(update.getByRole("button", { name: "Update" })).toBeVisible();
    expect(update.getByRole("button", { name: "Never for this site" }).elements()).toHaveLength(0);

    await emit({
      type: "savePrompt",
      tabId: TAB,
      promptId: "p-3",
      mode: "save",
      origin: "http://localhost:4001",
      frameOrigin: "http://localhost:4001",
      username: "carol",
      collapsed: false,
    });
    const save = page.getByRole("dialog", { name: "Save password?" });
    await expect.element(save.getByText(/signed in from a frame on this page/)).toBeVisible();
    await userEvent.click(save.getByRole("button", { name: "Never for this site" }));
    expect(autofill.respondToPrompt).toHaveBeenLastCalledWith({
      tabId: TAB,
      promptId: "p-3",
      action: "never",
    });
  });

  it("folds into the key icon and reopens from it", async () => {
    const autofill = installBridge();
    await render();
    await emit({
      type: "savePrompt",
      tabId: TAB,
      promptId: "p-4",
      mode: "save",
      origin: "http://127.0.0.1:4000",
      frameOrigin: null,
      username: "alice",
      collapsed: true,
    });
    expect(page.getByRole("dialog").elements()).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "Saved password prompt" }));
    expect(autofill.reopenPrompt).toHaveBeenCalledWith({ tabId: TAB });
  });
});
