import type { PasswordSaveOffer } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const bridge = vi.hoisted(() => {
  let emit: ((offer: PasswordSaveOffer) => void) | null = null;
  let withdraw: ((tabId: string) => void) | null = null;
  return {
    emit: (offer: PasswordSaveOffer) => emit?.(offer),
    withdraw: (tabId: string) => withdraw?.(tabId),
    onPasswordSaveOfferWithdrawn: vi.fn((listener: (tabId: string) => void) => {
      withdraw = listener;
      return () => {
        withdraw = null;
      };
    }),
    onPasswordSaveOffer: vi.fn((listener: (offer: PasswordSaveOffer) => void) => {
      emit = listener;
      return () => {
        emit = null;
      };
    }),
    respondToPasswordSaveOffer: vi.fn().mockResolvedValue(undefined),
    getSavedPasswordStatus: vi.fn().mockResolvedValue({ count: 1, chromeSync: null }),
  };
});

vi.mock(import("../preview/previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: bridge as never,
}));

import { PasswordSaveOfferBar } from "./PasswordSaveOfferBar";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  bridge.respondToPasswordSaveOffer.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const offer = (overrides: Partial<PasswordSaveOffer> = {}): PasswordSaveOffer => ({
  offerId: "offer-1",
  tabId: "tab-1",
  origin: "https://github.com",
  username: "octo",
  isUpdate: false,
  ...overrides,
});

const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent === label || candidate.getAttribute("aria-label") === label,
  );

describe("PasswordSaveOfferBar", () => {
  it("shows only its own tab's offer and saves under the edited username", async () => {
    await act(async () => root.render(<PasswordSaveOfferBar tabId="tab-1" />));
    expect(container.textContent).toBe("");

    await act(async () => bridge.emit(offer({ tabId: "tab-2" })));
    expect(container.textContent).toBe("");

    await act(async () => bridge.emit(offer()));
    expect(container.textContent).toContain("Save password for github.com?");

    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "octocat",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Save")!.click());

    expect(bridge.respondToPasswordSaveOffer).toHaveBeenCalledWith({
      offerId: "offer-1",
      decision: "save",
      username: "octocat",
    });
    expect(container.textContent).toBe("");
  });

  it("offers an update and can be told never to ask for the site", async () => {
    await act(async () => root.render(<PasswordSaveOfferBar tabId="tab-1" />));
    await act(async () => bridge.emit(offer({ offerId: "offer-2", isUpdate: true })));
    expect(container.textContent).toContain("Update the saved password for github.com?");

    await act(async () => button("Never for this site")!.click());
    expect(bridge.respondToPasswordSaveOffer).toHaveBeenCalledWith({
      offerId: "offer-2",
      decision: "never",
      username: "octo",
    });
  });

  it("hides an offer from a mistyped sign-in once the right password signs in", async () => {
    await act(async () => root.render(<PasswordSaveOfferBar tabId="tab-1" />));
    await act(async () => bridge.emit(offer({ isUpdate: true })));
    expect(container.textContent).toContain("github.com");

    await act(async () => bridge.withdraw("tab-1"));
    expect(container.textContent).toBe("");
    expect(bridge.respondToPasswordSaveOffer).not.toHaveBeenCalled();
  });
});
