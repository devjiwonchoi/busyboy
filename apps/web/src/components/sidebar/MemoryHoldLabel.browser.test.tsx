import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { resolveSidebarRowStatus, SidebarRowLine } from "./SidebarRowLine";
import { MemoryHoldLabel } from "./SidebarTaskRows";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  container.style.width = "280px";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function Row(props: { title: string; memoryHold: "waiting" | "paused" | null }) {
  return (
    <div role="button" tabIndex={0} aria-label={props.title} className="group/sidebar-row">
      <SidebarRowLine
        title={<span className="min-w-0 flex-1 truncate">{props.title}</span>}
        status={resolveSidebarRowStatus({ status: "working", isUnread: false, goalActive: false })}
        indicators={<MemoryHoldLabel task={{ memoryHold: props.memoryHold }} />}
      />
    </div>
  );
}

describe("memory wait on sidebar task rows", () => {
  it("shows a small 메모리 대기 only on tasks held for memory", async () => {
    await act(() =>
      root.render(
        <div data-testid="rows" className="bg-background p-2">
          <Row title="목표 그래프" memoryHold={null} />
          <Row title="로그인 리다이렉트 수정" memoryHold="paused" />
          <Row title="알림 묶기" memoryHold="waiting" />
        </div>,
      ),
    );

    const labels = container.querySelectorAll("[data-memory-hold]");
    expect([...labels].map((label) => label.getAttribute("data-memory-hold"))).toEqual([
      "paused",
      "waiting",
    ]);
    expect(labels[0]?.textContent).toBe("메모리 대기");
    expect(
      container.querySelector("[aria-label='목표 그래프'] [data-memory-hold]"),
    ).toBeNull();

    await page.getByTestId("rows").screenshot({
      path: "./__screenshots__/memory-hold-sidebar-rows.png",
    });
  });
});
