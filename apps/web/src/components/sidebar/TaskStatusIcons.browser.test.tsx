import type { ProjectTaskStatus } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import {
  describeTaskStatus,
  SidebarRowActionButton,
  SidebarRowLine,
  StatusGlyph,
} from "./SidebarRowLine";

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

// Icon (lucide class) and color for every status the user sees.
const EXPECTED: Record<ProjectTaskStatus, { icon: string; color: string }> = {
  todo: { icon: "lucide-circle", color: "text-muted-foreground" },
  planning: { icon: "lucide-circle-ellipsis", color: "text-orange-600" },
  waiting_for_approval: { icon: "lucide-clipboard-check", color: "text-warning-foreground" },
  in_progress: { icon: "lucide-circle-dashed", color: "text-info" },
  in_review: { icon: "lucide-git-pull-request-arrow", color: "text-violet-600" },
  ready: { icon: "lucide-git-merge", color: "text-success" },
  ask_question: { icon: "lucide-message-circle-question-mark", color: "text-indigo-600" },
  fatal: { icon: "lucide-octagon-alert", color: "text-error" },
  done: { icon: "lucide-circle-check", color: "text-muted-foreground/70" },
};

const popupText = () => document.querySelector("[data-slot='tooltip-popup']")?.textContent ?? null;

const noPr = { stage: "running", prUrl: null } as const;

describe("task status icons", () => {
  it("gives each status its own icon, and Planning and In Progress different colors", async () => {
    const statuses = Object.keys(EXPECTED) as ProjectTaskStatus[];
    await act(() =>
      root.render(
        <ul>
          {statuses.map((status) => (
            <li key={status} data-status={status}>
              <StatusGlyph icon={describeTaskStatus(status, noPr).icon} />
            </li>
          ))}
        </ul>,
      ),
    );
    for (const status of statuses) {
      const svg = container.querySelector(`[data-status='${status}'] svg`)!;
      expect(svg.classList, status).toContain(EXPECTED[status].icon);
      expect(describeTaskStatus(status, noPr).className.split(" "), status).toContain(
        EXPECTED[status].color,
      );
    }
    // In Progress spins like a working thread.
    expect(container.querySelector("[data-status='in_progress'] svg")!.classList).toContain(
      "animate-spin",
    );
    expect(describeTaskStatus("planning", noPr).className).not.toBe(
      describeTaskStatus("in_progress", noPr).className,
    );
  });

  it("names the status on hover and on long-press, without clicking the row", async () => {
    const onOpen = vi.fn();
    const status = describeTaskStatus("in_review", {
      stage: "in_review",
      prUrl: "https://github.com/o/r/pull/81",
    });
    await act(() =>
      root.render(
        <button type="button" className="group/sidebar-row w-60" onClick={onOpen}>
          <SidebarRowLine title={<span>Fix login flow</span>} status={status} />
        </button>,
      ),
    );
    const icon = page.getByTestId("status-glyph-trigger");

    await userEvent.hover(icon);
    await vi.waitFor(() => expect(popupText()).toBe("In Review · PR #81"));
    await userEvent.unhover(icon);
    await vi.waitFor(() => expect(popupText()).toBeNull());

    const target = icon.element() as HTMLElement;
    const touch = { pointerType: "touch", bubbles: true, isPrimary: true, pointerId: 7 };
    target.dispatchEvent(new PointerEvent("pointerdown", touch));
    await new Promise((resolve) => setTimeout(resolve, 600));
    target.dispatchEvent(new PointerEvent("pointerup", touch));
    target.click();
    await vi.waitFor(() => expect(popupText()).toBe("In Review · PR #81"));
    expect(onOpen).not.toHaveBeenCalled();

    // A plain tap still opens the row.
    target.dispatchEvent(new PointerEvent("pointerdown", touch));
    target.dispatchEvent(new PointerEvent("pointerup", touch));
    target.click();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("keeps a task lead row's status icon and label reachable while its actions show", async () => {
    const status = describeTaskStatus("in_progress", noPr);
    await act(() =>
      root.render(
        <div role="button" tabIndex={0} aria-label="Lead row" className="group/sidebar-row w-60">
          <SidebarRowLine
            title={<span>Fix login flow</span>}
            status={status}
            actions={
              <SidebarRowActionButton label="Archive thread" onClick={() => {}}>
                <svg className="size-3.5" />
              </SidebarRowActionButton>
            }
          />
        </div>,
      ),
    );
    const row = page.getByRole("button", { name: "Lead row" });
    const restingIcon = container.querySelector(
      "[data-testid='sidebar-row-status'] [data-testid='status-glyph-trigger']",
    )!;
    const restingRight = restingIcon.getBoundingClientRect().right;

    await userEvent.hover(row);
    const actions = container.querySelector<HTMLElement>("[data-testid='sidebar-row-actions']")!;
    await vi.waitFor(() => expect(getComputedStyle(actions).opacity).toBe("1"));
    const hoverIcon = actions.querySelector<HTMLElement>("[data-testid='status-glyph-trigger']")!;
    // Same spot as at rest (the wrapper: the icon spins), so it doesn't jump when the actions appear.
    expect(hoverIcon.getBoundingClientRect().right).toBe(restingRight);

    await userEvent.hover(hoverIcon);
    await vi.waitFor(() => expect(popupText()).toBe("In Progress"));
  });
});
