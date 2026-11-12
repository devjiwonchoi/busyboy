import { RegistryProvider } from "@effect/atom-react";
import type { LegendListRef } from "@legendapp/list/react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  MessageId,
  ProjectTaskEventId,
  ProjectTaskId,
  ThreadId,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useUpdateTeamSettings: (() => async () => {}) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import { AfkBanner } from "./Afk";
import { MessagesTimeline } from "./MessagesTimeline";

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const AT = "2026-11-07T10:00:00.000Z";
const projectRef = scopeProjectRef(ENVIRONMENT_ID, "project-1" as never);
const summary = makeProjectManagerSummaryFixture({
  settings: { ...makeProjectManagerSummaryFixture().settings, afk: { since: AT, until: null } },
  afkAnswers: Array.from({ length: 3 }, (_, index) => ({
    id: ProjectTaskEventId.make(`answer-${index}`),
    at: AT,
    threadId: ThreadId.make("lead-thread"),
    taskId: ProjectTaskId.make("task-1"),
    text: `Question ${index + 1}: Which approach? → Use the recommended option.`,
  })),
});
const entries: ComponentProps<typeof MessagesTimeline>["timelineEntries"] = Array.from(
  { length: 30 },
  (_, index) => ({
    id: `entry-${index}`,
    kind: "message",
    createdAt: AT,
    message: {
      id: MessageId.make(`message-${index}`),
      role: "user",
      text: `Message ${index + 1}. ${"Please review the release plan and check every task before continuing. ".repeat(12)}`,
      runId: null,
      createdAt: AT,
      updatedAt: AT,
      streaming: false,
    },
  }),
);

// Match ChatView: the timeline fills the container behind an absolute composer overlay.
// Its measured height reserves enough scrollable space to reveal the final message.
function OverlappingChat() {
  const overlay = useRef<HTMLDivElement>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const [overlayHeight, setOverlayHeight] = useState(0);
  useLayoutEffect(() => {
    const node = overlay.current!;
    const observer = new ResizeObserver(() =>
      setOverlayHeight(node.getBoundingClientRect().height),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div style={{ position: "relative", height: "100%" }}>
      <MessagesTimeline
        isWorking={false}
        activeTurnInProgress={false}
        listRef={listRef}
        latestRun={null}
        turnDiffSummaries={[]}
        runs={[]}
        routeThreadKey="env-1:pm-thread"
        onOpenTurnDiff={() => {}}
        onOpenThread={() => {}}
        onForkFromRun={async () => {}}
        onRollbackCheckpoint={() => {}}
        supportsConversationRollback={false}
        onRevertToTurnCount={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        activeThreadEnvironmentId={ENVIRONMENT_ID}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        anchorMessageId={null}
        onAnchorReady={() => {}}
        onAnchorSizeChanged={() => {}}
        contentInsetEndAdjustment={overlayHeight}
        liveFollowEnabled
        onIsAtEndChange={() => {}}
        onManualNavigation={() => {}}
        timelineEntries={entries}
      />
      <div
        ref={overlay}
        data-chat-composer-overlay
        style={{ position: "absolute", insetInline: 0, bottom: 0, padding: "0 16px 16px" }}
      >
        <AfkBanner projectRef={projectRef} summary={summary} />
        <div
          style={{
            height: 96,
            background: "var(--background)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 12,
          }}
        >
          <textarea
            aria-label="Message"
            placeholder="Message the project manager"
            style={{ width: "100%", resize: "none" }}
          />
        </div>
      </div>
    </div>
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height: 100dvh; width: 100%;";
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe.each([
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
])("AFK composer overlap ($name)", ({ name, width, height }) => {
  it("hides messages behind the banner and keeps the last message above it at the end", async () => {
    await page.viewport(width, height);
    const rootRoute = createRootRoute({ component: OverlappingChat });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        createRoute({
          getParentRoute: () => rootRoute,
          path: "/$environmentId/$threadId",
          component: () => null,
        }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/env-1/pm-thread"] }),
    });
    await act(async () =>
      root.render(
        <RegistryProvider>
          <RouterProvider router={router} />
        </RegistryProvider>,
      ),
    );
    const banner = page.getByRole("status", { name: "AFK" });
    await expect.element(banner).toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "Message" })).toBeVisible();

    // An opaque base under the warning gradient blocks text in every theme.
    // Canvas resolves modern CSS colors (including oklch/color-mix) to an alpha byte.
    const style = getComputedStyle(banner.element());
    const context = document.createElement("canvas").getContext("2d")!;
    context.fillStyle = style.backgroundColor;
    context.fillRect(0, 0, 1, 1);
    expect(context.getImageData(0, 0, 1, 1).data[3]).toBe(255);
    expect(style.backgroundImage).toContain("linear-gradient");

    // Expanding answers changes the overlay height; ResizeObserver must update the inset.
    await userEvent.click(banner.getByRole("button", { name: "3개 자동 응답" }));
    await expect.element(banner.getByRole("link", { name: /Question 3/ })).toBeVisible();
    const scrollNode = container.querySelector<HTMLElement>(".messages-timeline-scroll")!;
    await vi.waitFor(() => {
      scrollNode.scrollTop = scrollNode.scrollHeight;
      expect(scrollNode.scrollHeight).toBeGreaterThan(scrollNode.clientHeight);
      const last = container.querySelector('[data-message-id="message-29"]');
      expect(last).toBeTruthy();
      expect(last!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        banner.element().getBoundingClientRect().top,
      );
    });
    await page.screenshot({ path: `__screenshots__/afk-overlap-${name}.png` });

    // Moving back into the conversation places real message text under the opaque banner.
    const end = scrollNode.scrollTop;
    scrollNode.scrollTop = end - 180;
    await vi.waitFor(() => {
      expect(scrollNode.scrollTop).toBeLessThan(end - 100);
      const bounds = banner.element().getBoundingClientRect();
      const behind = [...container.querySelectorAll("[data-message-id]")].some((node) => {
        const row = node.getBoundingClientRect();
        return row.top < bounds.bottom && row.bottom > bounds.top;
      });
      expect(behind).toBe(true);
    });
    await page.screenshot({ path: `__screenshots__/afk-overlap-${name}-scrolled.png` });
  });
});
