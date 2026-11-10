import { act } from "react";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent, page } from "vite-plus/test/browser";
import { useDirectorInbox } from "../state/director";
import { makeProjectManagerSummaryFixture } from "../test-fixtures";
import {
  EnvironmentId,
  ProjectAttentionItemId,
  ProjectTaskId,
  ProjectAttentionBatchId,
} from "@t3tools/contracts";
import { PendingActionsPill } from "./chat/PendingActionsButton";
import { WaitingAlerts, WaitingTitle } from "./WaitingAlerts";
import "../index.css";

const server = vi.hoisted(() => ({
  stream: null as Atom.Writable<AsyncResult.AsyncResult<unknown, unknown>> | null,
  focused: false,
  mode: "notifications-and-sound" as const,
  badge: vi.fn(),
  attention: vi.fn(async () => {}),
  sound: vi.fn(async () => {}),
}));
vi.mock(import("@t3tools/client-runtime/state/project-team"), async (original) => {
  const actual = await original();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  server.stream = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(AsyncResult.initial(true));
  return {
    ...actual,
    createProjectTeamEnvironmentAtoms: ((runtime: never) => ({
      ...actual.createProjectTeamEnvironmentAtoms(runtime),
      attention: () => server.stream,
    })) as never,
  };
});
vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  useEnvironmentIds: () => [EnvironmentId.make("local")],
}));
vi.mock("../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../hooks/useSettings")>()),
  useClientSettings: (select: (settings: { notificationMode: string }) => unknown) =>
    select({ notificationMode: server.mode }),
  getClientSettings: () => ({ notificationMode: server.mode }),
}));
vi.mock("../threadNotifications", async (original) => ({
  ...(await original<typeof import("../threadNotifications")>()),
  playNotificationSound: server.sound,
}));

function publish(count: number) {
  const summary = makeProjectManagerSummaryFixture();
  const card = {
    taskNumber: 1,
    taskTitle: "Review work",
    plan: null,
    item: {
      id: ProjectAttentionItemId.make("card"),
      projectId: summary.projectId,
      taskId: ProjectTaskId.make("task"),
      kind: "decision" as const,
      question: "Ready to continue?",
      options: ["Continue"],
      answer: null,
      answeredAt: null,
      askerThreadId: summary.pmThreadId,
      batchId: ProjectAttentionBatchId.make("batch"),
      createdAt: "2026-11-10T00:00:00Z",
      supersededAt: null,
      answeredBy: null,
      specVersion: null,
      summary: null,
      verification: null,
    },
  };
  const attentionSummary = {
    ...summary,
    decisionCards: Array.from({ length: count }, (_, index) => ({
      ...card,
      item: {
        ...card.item,
        id: ProjectAttentionItemId.make(`card-${index}`),
        answeredAt: null,
        supersededAt: null,
      },
    })),
    waitingThreads: [],
  };
  registry.set(
    server.stream!,
    AsyncResult.success({
      byProjectId: new Map([[summary.projectId, attentionSummary]]),
      byPmThreadId: new Map([[summary.pmThreadId, attentionSummary]]),
    }),
  );
}
function Journey() {
  const { total } = useDirectorInbox();
  return (
    <>
      <WaitingTitle title="BusyBoy" />
      <WaitingAlerts />
      <PendingActionsPill count={total}>
        {() => (
          <button data-answer-card onClick={() => publish(0)}>
            Answer card
          </button>
        )}
      </PendingActionsPill>
    </>
  );
}
let root: Root;
let container: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;
function renderJourney() {
  root.render(
    <RegistryContext.Provider value={registry}>
      <Journey />
    </RegistryContext.Provider>,
  );
}
beforeEach(async () => {
  await page.viewport(1280, 900);
  registry = AtomRegistry.make();
  server.focused = false;
  vi.clearAllMocks();
  vi.spyOn(document, "hasFocus").mockImplementation(() => server.focused);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("desktopBridge", {
    setNotificationBadge: server.badge.mockResolvedValue(undefined),
    requestAttention: server.attention,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  registry.dispose();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("shows a new waiting card, pulses once, then restores title and badge when answered", async () => {
  await act(async () => {
    publish(0);
    renderJourney();
  });
  await act(async () => publish(1));
  expect(document.title).toBe("(1) BusyBoy");
  expect(server.badge).toHaveBeenLastCalledWith({ count: 1, image: null });
  const pill = container.querySelector<HTMLElement>("[data-pending-actions-button]")!;
  expect(pill.dataset.waitingPulse).toBe("true");
  await page.screenshot({ path: "__screenshots__/waiting-alerts-desktop.png" });
  await vi.waitFor(() => expect(pill.dataset.waitingPulse).toBeUndefined(), { timeout: 2000 });
  await userEvent.click(pill);
  await userEvent.click(document.querySelector("[data-answer-card]")!);
  await vi.waitFor(() => expect(document.title).toBe("BusyBoy"));
  expect(server.badge).toHaveBeenLastCalledWith({ count: 0, image: null });
});
it.each([false, true])(
  "coalesces two cards and requests attention only when unfocused (focused=%s)",
  async (focused) => {
    server.focused = focused;
    await act(async () => {
      publish(0);
      renderJourney();
    });
    await act(async () => publish(2));
    await new Promise((resolve) => setTimeout(resolve, 3200));
    expect(server.attention).toHaveBeenCalledTimes(focused ? 0 : 1);
    expect(server.sound).toHaveBeenCalledTimes(focused ? 0 : 1);
  },
);

it("baselines cards delivered after loading without alerting, then alerts for a new card", async () => {
  await act(async () => renderJourney());
  await act(async () => publish(2));
  await new Promise((resolve) => setTimeout(resolve, 3200));
  expect(server.attention).toHaveBeenCalledTimes(0);
  expect(server.sound).toHaveBeenCalledTimes(0);
  expect(document.title).toBe("(2) BusyBoy");
  expect(server.badge).toHaveBeenLastCalledWith({ count: 2, image: null });
  await act(async () => publish(3));
  await new Promise((resolve) => setTimeout(resolve, 3200));
  expect(server.attention).toHaveBeenCalledTimes(1);
  expect(server.sound).toHaveBeenCalledTimes(1);
});
