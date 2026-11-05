import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

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

    // Title first; the status icon and the hover actions share the trailing slot.
    const title = row.querySelector("span.truncate")!;
    const trailing = row.querySelector("[data-testid='sidebar-row-trailing']")!;
    expect(title.compareDocumentPosition(trailing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(trailing.contains(slot)).toBe(true);
    expect(trailing.contains(row.querySelector("[data-testid='sidebar-row-actions']"))).toBe(true);

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

  it("keeps the action buttons in the same place on hover, with or without a status", async () => {
    const statuses = {
      "Busy thread": resolveSidebarRowStatus({
        status: "working",
        isUnread: false,
        goalActive: false,
      }),
      "Idle thread": resolveSidebarRowStatus({
        status: "ready",
        isUnread: false,
        goalActive: false,
      }),
    };
    await act(() =>
      root.render(
        <ul className="w-60">
          {Object.entries(statuses).map(([name, status]) => (
            <li key={name}>
              <div role="button" tabIndex={0} aria-label={name} className="group/sidebar-row">
                <SidebarRowLine
                  title={<span className="min-w-0 flex-1 truncate">{name}</span>}
                  status={status}
                  actions={
                    <>
                      <SidebarRowActionButton label={`Pin ${name}`} onClick={() => {}}>
                        <svg className="size-3.5" />
                      </SidebarRowActionButton>
                      <SidebarRowActionButton label={`Archive ${name}`} onClick={() => {}}>
                        <svg className="size-3.5" />
                      </SidebarRowActionButton>
                    </>
                  }
                />
              </div>
            </li>
          ))}
        </ul>,
      ),
    );

    const measure = async (name: string) => {
      const row = page.getByRole("button", { name, exact: true });
      const title = row.element().querySelector("span.truncate")!;
      const restingTitleWidth = title.getBoundingClientRect().width;
      await userEvent.hover(row);
      const actions = row.element().querySelector("[data-testid='sidebar-row-actions']")!;
      await vi.waitFor(() => expect(getComputedStyle(actions).opacity).toBe("1"));
      const box = (label: string) => {
        const rect = page.getByRole("button", { name: label }).element().getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      };
      return {
        pin: box(`Pin ${name}`),
        archive: box(`Archive ${name}`),
        restingTitleWidth,
        hoveredTitleWidth: title.getBoundingClientRect().width,
      };
    };

    const busy = await measure("Busy thread");
    const idle = await measure("Idle thread");

    expect(busy.pin).toEqual(idle.pin);
    expect(busy.archive).toEqual(idle.archive);
    // The actions take the status icon's place at the row's right edge.
    const rowRight = page.getByRole("button", { name: "Busy thread", exact: true }).element();
    const statusRight = rowRight
      .querySelector("[data-testid='sidebar-row-status']")!
      .getBoundingClientRect().right;
    expect(busy.archive.right).toBe(statusRight);
    // Hovering swaps layers in a fixed slot, so the title never reflows.
    expect(busy.hoveredTitleWidth).toBe(busy.restingTitleWidth);
    expect(idle.hoveredTitleWidth).toBe(idle.restingTitleWidth);
  });
});
