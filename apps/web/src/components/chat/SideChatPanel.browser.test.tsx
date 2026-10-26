import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  shell: null as { title: string; deletedAt: string | null } | null,
}));

vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: (() => state.shell) as never,
}));

import { SideChatPanel } from "./SideChatPanel";

const environmentId = EnvironmentId.make("environment");
let root: Root;
let onNewSideChat: ReturnType<typeof vi.fn<() => void>>;

async function render() {
  await act(() =>
    root.render(
      <SideChatPanel
        environmentId={environmentId}
        threadId="side-thread"
        onNewSideChat={onNewSideChat}
        renderChat={(threadId) => <p>Chat for {threadId}</p>}
      />,
    ),
  );
}

beforeEach(() => {
  state.shell = { title: "Plan the release (side chat)", deletedAt: null };
  onNewSideChat = vi.fn<() => void>();
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

describe("side chat panel", () => {
  it("shows only the side chat's conversation", async () => {
    await render();
    await expect.element(page.getByText("Chat for side-thread")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "New side chat" }))
      .not.toBeInTheDocument();
  });

  it("offers a new side chat once the old one is deleted", async () => {
    state.shell = { title: "Plan the release (side chat)", deletedAt: "2026-10-27T00:00:00.000Z" };
    await render();
    await expect.element(page.getByText("Side chat unavailable")).toBeVisible();
    await expect.element(page.getByText("Chat for side-thread")).not.toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "New side chat" }));
    expect(onNewSideChat).toHaveBeenCalledOnce();
  });
});
