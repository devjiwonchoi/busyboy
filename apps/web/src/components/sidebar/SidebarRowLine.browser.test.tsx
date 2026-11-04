import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { resolveSidebarRowStatus, SidebarRowActionButton, SidebarRowLine } from "./SidebarRowLine";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderRow(input: {
  status: Parameters<typeof resolveSidebarRowStatus>[0]["status"];
  isUnread?: boolean;
  onPin?: () => void;
  onArchive?: () => void;
}) {
  const status = resolveSidebarRowStatus({
    status: input.status,
    isUnread: input.isUnread ?? false,
    goalActive: false,
  });
  await act(() =>
    root.render(
      <div role="button" tabIndex={0} aria-label="Fix login flow" className="group/sidebar-row">
        <SidebarRowLine
          title={<span className="min-w-0 flex-1 truncate">Fix login flow</span>}
          status={status}
          actions={
            <>
              <SidebarRowActionButton label="Pin thread" onClick={input.onPin ?? (() => {})}>
                pin
              </SidebarRowActionButton>
              <SidebarRowActionButton
                label="Archive thread"
                onClick={input.onArchive ?? (() => {})}
              >
                archive
              </SidebarRowActionButton>
            </>
          }
        />
      </div>,
    ),
  );
  return container.querySelector<HTMLElement>("[aria-label='Fix login flow']")!;
}

describe("SidebarRowLine", () => {
  it("shows the title then status as an icon with an accessible label, and nothing else", async () => {
    const row = await renderRow({ status: "working" });

    await expect.element(page.getByRole("status")).toHaveTextContent("Working");
    const slot = row.querySelector<HTMLElement>("[data-testid='sidebar-row-status']")!;
    expect(slot.dataset.status).toBe("working");
    expect(slot.querySelector("svg")).not.toBeNull();
    // The label is screen-reader only; the visible status is the icon.
    expect(slot.querySelector("[role='status']")!.className).toContain("sr-only");

    // Title, the hover actions, then the status icon at the far right.
    const title = row.querySelector("span.truncate")!;
    const actions = row.querySelector("[data-testid='sidebar-row-actions']")!;
    expect(title.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actions.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // No relative time, duration, branch, or model text — only title, actions, status.
    const visibleText = (row.textContent ?? "").replace("Working", "");
    expect(visibleText).toBe("Fix login flowpinarchive");
  });

  it("keeps an empty fixed-width slot when the thread has no status", async () => {
    const row = await renderRow({ status: "ready", isUnread: false });

    const slot = row.querySelector<HTMLElement>("[data-testid='sidebar-row-status']")!;
    expect(slot).not.toBeNull();
    expect(slot.childElementCount).toBe(0);
    expect(slot.className).toContain("size-4");
    expect(row.querySelector("[role='status']")).toBeNull();
  });

  it("labels an unread finished thread as done", async () => {
    await renderRow({ status: "ready", isUnread: true });
    await expect.element(page.getByRole("status")).toHaveTextContent("Done");
  });

  it("offers the row actions on hover", async () => {
    const onPin = vi.fn();
    const onArchive = vi.fn();
    const row = await renderRow({ status: "input", onPin, onArchive });

    await userEvent.hover(row);
    await userEvent.click(page.getByRole("button", { name: "Pin thread" }));
    await userEvent.click(page.getByRole("button", { name: "Archive thread" }));
    expect(onPin).toHaveBeenCalledOnce();
    expect(onArchive).toHaveBeenCalledOnce();
    await expect.element(page.getByRole("status")).toHaveTextContent("Input");
  });
});
