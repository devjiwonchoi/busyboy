import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({ requestSitrep: vi.fn() }));

vi.mock(import("../state/projectTeam"), async (original) => ({
  ...(await original()),
  useRequestSitrep: (() => state.requestSitrep) as never,
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

import { makeProjectManagerSummaryFixture } from "../test-fixtures";
import { CollapsedComposerAction } from "./chat/CollapsedComposerAction";
import { SidebarProjectManagerHeading } from "./SidebarProjectManager";

const pmThreadRef = scopeThreadRef("env-1" as never, "pm-thread" as never);

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await page.viewport(390, 844);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** Opacity as painted, including ancestors (the hover-only group fades a wrapper). */
function effectiveOpacity(element: Element): number {
  let opacity = 1;
  for (let node: Element | null = element; node; node = node.parentElement) {
    opacity *= Number(getComputedStyle(node).opacity);
  }
  return opacity;
}

/** Stand-in for the PM chat's collapsed mobile composer row around the real action button. */
function CollapsedPmComposer(props: { sitrepInProgress: boolean; onSend: () => void }) {
  const [prompt, setPrompt] = useState("");
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2">
      <input
        aria-label="Prompt"
        value={prompt}
        onChange={(event) => setPrompt(event.currentTarget.value)}
        className="min-w-0 flex-1"
      />
      <CollapsedComposerAction
        sitrep={{
          inProgress: props.sitrepInProgress,
          disabled: false,
          onRequest: state.requestSitrep,
        }}
        hasSendableContent={prompt.trim().length > 0}
        showResume={false}
        disabled={prompt.trim().length === 0}
        label="Send message"
        onPrimary={props.onSend}
      />
    </div>
  );
}

describe("Sitrep on a phone-sized screen", () => {
  it("shows Sitrep in the collapsed PM composer while the prompt is empty", async () => {
    const onSend = vi.fn();
    await act(() => root.render(<CollapsedPmComposer sitrepInProgress={false} onSend={onSend} />));

    const sitrep = page.getByRole("button", { name: "Sitrep now" });
    await expect.element(sitrep).toBeVisible();
    await userEvent.click(sitrep);
    expect(state.requestSitrep).toHaveBeenCalledOnce();

    // Typing a message brings the send arrow back.
    await userEvent.fill(page.getByRole("textbox", { name: "Prompt" }), "status?");
    await expect.element(page.getByRole("button", { name: "Sitrep now" })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("disables the collapsed composer's Sitrep while one is in progress", async () => {
    await act(() => root.render(<CollapsedPmComposer sitrepInProgress onSend={vi.fn()} />));
    await expect.element(page.getByRole("button", { name: "Sitrep in progress" })).toBeDisabled();
  });

  it("shows the sidebar PM heading's Sitrep button without hovering", async () => {
    const onOpenThread = vi.fn();
    await act(() =>
      root.render(
        <div className="w-72">
          <SidebarProjectManagerHeading
            projectName="busyboy"
            summary={makeProjectManagerSummaryFixture({})}
            pmThreadRef={pmThreadRef}
            pmThreadWorking={false}
            isActive={false}
            expanded
            onToggle={vi.fn()}
            onOpenThread={onOpenThread}
            onNewThread={vi.fn()}
          />
        </div>,
      ),
    );

    // New thread stays a hover-only control; Sitrep is always shown.
    const newThread = page.getByRole("button", { name: "New thread in busyboy" });
    expect(effectiveOpacity(newThread.element())).toBe(0);
    const sitrep = page.getByRole("button", { name: "Sitrep" });
    await expect.element(sitrep).toBeVisible();
    expect(effectiveOpacity(sitrep.element())).toBe(1);

    await userEvent.click(sitrep);
    expect(state.requestSitrep).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-1",
      projectId: "project-1",
    });
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith(pmThreadRef);
  });
});
