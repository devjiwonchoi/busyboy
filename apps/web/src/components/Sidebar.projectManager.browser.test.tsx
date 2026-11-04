import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T09:00:00.000Z");

const state = vi.hoisted(() => ({
  team: { byProjectId: new Map(), byPmThreadId: new Map() },
  completedAt: null as string | null,
  requestSitrep: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => ({
    status: "live",
    snapshot: Option.some({
      projects: [{ id: "project-1", title: "Busy" }],
      threads: [pmThreadShell()],
    }),
  })) as never,
}));
vi.mock(import("../state/projectTeam"), async (original) => ({
  ...(await original()),
  useEnvironmentProjectTeamAttention: (() => state.team) as never,
  useRequestSitrep: (() => state.requestSitrep) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useParams: (() => ({ environmentId: "env-1", threadId: "other-thread" })) as never,
}));
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((select: (settings: Pick<ClientSettings, "notificationMode">) => unknown) =>
    select({ notificationMode: "notifications-and-sound" })) as never,
  getClientSettings: (() => ({ notificationMode: "notifications-and-sound" })) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => ["env-1"]) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  setNotificationBadge: vi.fn(),
}));

import { groupSidebarThreadsByProject, orderSidebarProjectSections } from "./Sidebar.logic";
import { SidebarProjectManagerBadges, SidebarSitrepButton } from "./SidebarProjectManager";
import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

function pmThreadShell() {
  return {
    id: "pm-thread",
    projectId: "project-1",
    title: "Busy PM",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: "pm-thread", parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: "run-1",
    activeRunId: null,
    status: state.completedAt ? "completed" : "running",
    lastErrorClass: null,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: state.completedAt ? DateTime.makeUnsafe(state.completedAt) : undefined,
    archivedAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function summary(patch: Partial<ProjectTeamAttentionSummary> = {}): ProjectTeamAttentionSummary {
  return {
    projectId: "project-1",
    pmThreadId: "pm-thread",
    openCount: 0,
    latestBatchId: null,
    latestSitrepId: null,
    unreadSitrepCount: 0,
    sitrepInProgress: false,
    settings: { maxConcurrentTasks: 6, sitrepIntervalMinutes: 60, sitrepNotify: true },
    ...patch,
  } as ProjectTeamAttentionSummary;
}

function setTeam(next: ProjectTeamAttentionSummary) {
  state.team = {
    byProjectId: new Map([[next.projectId, next]]),
    byPmThreadId: new Map([[next.pmThreadId, next]]),
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  state.completedAt = null;
  setTeam(summary());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("project manager sidebar row", () => {
  it("pins the PM thread at the top of its project and keeps new threads below it", () => {
    const threads = [
      { id: "new-thread", project: "a" },
      { id: "other-project", project: "b" },
      { id: "pm-thread", project: "a" },
      { id: "older-thread", project: "a" },
    ];
    const grouped = groupSidebarThreadsByProject(
      threads,
      (thread) => thread.project,
      (thread) => thread.id === "pm-thread",
    );
    expect(grouped.get("a")?.map((thread) => thread.id)).toEqual([
      "pm-thread",
      "new-thread",
      "older-thread",
    ]);
    expect(grouped.get("b")?.map((thread) => thread.id)).toEqual(["other-project"]);
  });

  it("orders projects by their non-PM threads so a busy PM never moves its project", () => {
    const threads = [
      { id: "pm-c", project: "c" },
      { id: "pm-b", project: "b" },
      { id: "a-thread", project: "a" },
      { id: "b-thread", project: "b" },
    ];
    const isPm = (thread: { id: string }) => thread.id.startsWith("pm-");
    const grouped = groupSidebarThreadsByProject(threads, (thread) => thread.project, isPm);
    expect(grouped.get("b")?.map((thread) => thread.id)).toEqual(["pm-b", "b-thread"]);
    // The PM-only project keeps its fallback position.
    expect(orderSidebarProjectSections(grouped, isPm, ["c", "d", "a", "b"])).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("shows the PM badge, Needs-you count, and unread sitrep dot", async () => {
    await act(() => root.render(<SidebarProjectManagerBadges summary={summary()} />));
    expect(container.textContent).toBe("PM");
    expect(container.querySelector('[aria-label^="Needs you"]')).toBeNull();
    expect(container.querySelector('[aria-label="Unread sitrep"]')).toBeNull();

    await act(() =>
      root.render(
        <SidebarProjectManagerBadges summary={summary({ openCount: 3, unreadSitrepCount: 1 })} />,
      ),
    );
    expect(container.querySelector('[aria-label="Needs you: 3"]')?.textContent).toBe("3");
    expect(container.querySelector('[aria-label="Unread sitrep"]')).not.toBeNull();
  });

  it("asks for a sitrep and opens the PM thread from the row's Sitrep button", async () => {
    const threadRef = scopeThreadRef("env-1" as never, "pm-thread" as never);
    const onThreadActivate = vi.fn();
    const rowClick = vi.fn();
    await act(() =>
      root.render(
        <div onClick={rowClick}>
          <SidebarSitrepButton
            threadRef={threadRef}
            summary={summary()}
            onThreadActivate={onThreadActivate}
          />
        </div>,
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Sitrep"]')!.click(),
    );
    expect(state.requestSitrep).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-1",
      projectId: "project-1",
    });
    expect(onThreadActivate).toHaveBeenCalledExactlyOnceWith(threadRef);
    expect(rowClick).not.toHaveBeenCalled();
  });
});

describe("project manager notifications", () => {
  const render = () => act(() => root.render(<ThreadNotificationCoordinator />));

  it("keeps PM turn completions silent", async () => {
    await render();
    state.completedAt = "2026-09-13T10:00:00.000Z";
    await render();
    expect(state.notification).not.toHaveBeenCalled();
    expect(state.sound).not.toHaveBeenCalled();
  });

  it("alerts once with sound for a new Needs-you batch and opens the PM thread", async () => {
    setTeam(summary({ openCount: 1, latestBatchId: "batch-1" as never }));
    await render();
    expect(state.notification).not.toHaveBeenCalled();

    setTeam(summary({ openCount: 2, latestBatchId: "batch-2" as never }));
    await render();
    await render();
    expect(state.notification).toHaveBeenCalledExactlyOnceWith("Needs you: 2", {
      body: "Busy",
      tag: "env-1:pm-thread:attention",
      silent: true,
    });
    expect(state.sound).toHaveBeenCalledOnce();
    state.notification.mock.results[0]!.value.dispatchEvent(new Event("click"));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "pm-thread" },
    });
  });

  it("shows one silent notification for a new sitrep", async () => {
    await render();
    setTeam(summary({ latestSitrepId: "sitrep-1" as never, unreadSitrepCount: 1 }));
    await render();
    expect(state.notification).toHaveBeenCalledExactlyOnceWith("Busy PM · Sitrep", {
      body: "Busy",
      tag: "env-1:pm-thread:sitrep",
      silent: true,
    });
    expect(state.sound).not.toHaveBeenCalled();
  });

  it("skips the sitrep notification when sitrep notifications are off", async () => {
    const quiet = { maxConcurrentTasks: 6, sitrepIntervalMinutes: 60, sitrepNotify: false };
    setTeam(summary({ settings: quiet }));
    await render();
    setTeam(summary({ settings: quiet, latestSitrepId: "sitrep-1" as never }));
    await render();
    expect(state.notification).not.toHaveBeenCalled();
  });
});
