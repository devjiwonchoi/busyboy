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
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  setNotificationBadge: vi.fn(),
}));

import { makeProjectManagerSummaryFixture } from "../test-fixtures";
import {
  buildMultiSelectThreadContextMenuItems,
  filterSidebarV2VisibleThreads,
  isProjectManagerTaskLead,
  groupSidebarThreadsByProject,
  orderSidebarProjectSections,
  selectSidebarProjectManagers,
} from "./Sidebar.logic";
import {
  SidebarProjectManagerBadges,
  SidebarProjectManagerHeading,
  SidebarSitrepButton,
} from "./SidebarProjectManager";
import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";
import { buildThreadActionMenuItems } from "./threadActionMenu.logic";

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

const summary = (patch: Parameters<typeof makeProjectManagerSummaryFixture>[0] = {}) =>
  makeProjectManagerSummaryFixture(patch);

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

const pmThreadRef = scopeThreadRef("env-1" as never, "pm-thread" as never);

async function renderHeading(
  overrides: Partial<Parameters<typeof SidebarProjectManagerHeading>[0]> = {},
) {
  const props = {
    projectName: "busyboy",
    summary: summary(),
    pmThreadRef,
    pmThreadWorking: false,
    isActive: false,
    expanded: true,
    onToggle: vi.fn(),
    onOpenThread: vi.fn(),
    onNewThread: vi.fn(),
    ...overrides,
  };
  await act(() => root.render(<SidebarProjectManagerHeading {...props} />));
  return props;
}

const rowToggle = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="sidebar-project-manager-toggle"]')!;
const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
  );

describe("project manager sidebar heading", () => {
  it("shows the PM avatar, project and PM name; from elsewhere the row opens the PM", async () => {
    const props = await renderHeading({
      summary: summary({ openCount: 2, unreadSitrepCount: 1, presence: { running: 1 } }),
    });
    const heading = container.querySelector('[data-testid="sidebar-project-manager-heading"]')!;
    expect(heading.querySelector('[role="img"][aria-label="Remy, needs you"]')).not.toBeNull();
    expect(heading.textContent).toContain("busyboy");
    expect(heading.textContent).toContain("Remy");
    expect(heading.querySelector('[aria-label="Needs you: 2"]')?.textContent).toBe("2");
    expect(heading.querySelector('[aria-label="Unread sitrep"]')).not.toBeNull();

    // Already unfolded: open the PM chat, leave the fold alone.
    await act(async () => rowToggle().click());
    expect(props.onOpenThread).toHaveBeenCalledExactlyOnceWith(pmThreadRef);
    expect(props.onToggle).not.toHaveBeenCalled();
    expect(button("Add to busyboy")).toBeDefined();
  });

  it("unfolds a folded section when it opens the PM chat", async () => {
    const props = await renderHeading({ expanded: false });
    await act(async () => rowToggle().click());
    expect(props.onOpenThread).toHaveBeenCalledExactlyOnceWith(pmThreadRef);
    expect(props.onToggle).toHaveBeenCalledOnce();
  });

  it("only folds and unfolds while the PM thread is open, and shows a working avatar", async () => {
    const props = await renderHeading({ isActive: true, pmThreadWorking: true });
    expect(container.querySelector('[aria-current="page"]')).toBe(rowToggle());
    expect(container.querySelector('[aria-label="Remy, working"]')).not.toBeNull();
    await act(async () => rowToggle().click());
    expect(props.onToggle).toHaveBeenCalledOnce();
    expect(props.onOpenThread).not.toHaveBeenCalled();
  });

  it("puts New thread behind the + menu, with no New task", async () => {
    const props = await renderHeading();
    await act(async () => button("Add to busyboy")!.click());
    const item = (name: string) =>
      [...document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]')].find(
        (candidate) => candidate.textContent === name,
      );
    await vi.waitFor(() => expect(item("New thread")).toBeDefined());
    await act(async () => item("New thread")!.click());
    expect(props.onNewThread).toHaveBeenCalledOnce();
    await act(async () => button("Add to busyboy")!.click());
    await vi.waitFor(() => expect(item("New thread")).toBeDefined());
    expect(item("New task")).toBeUndefined();
  });

  it("has no tasks fold: task leads are ordinary rows below the heading", async () => {
    await renderHeading();
    expect(container.textContent).not.toMatch(/\btasks?\b/);
    expect(container.querySelector("ul")).toBeNull();
    expect(container.querySelectorAll("button").length).toBe(3);
  });

  it("asks for a sitrep and opens the PM thread from the heading's Sitrep button", async () => {
    const props = await renderHeading();
    await act(async () => button("Sitrep")!.click());
    expect(state.requestSitrep).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env-1",
      projectId: "project-1",
    });
    expect(props.onOpenThread).toHaveBeenCalledExactlyOnceWith(pmThreadRef);
  });

  it("shows only the open count and unread dot as badges", async () => {
    await act(() => root.render(<SidebarProjectManagerBadges summary={summary()} />));
    expect(container.textContent).toBe("");
    await act(() =>
      root.render(
        <SidebarProjectManagerBadges summary={summary({ openCount: 3, unreadSitrepCount: 1 })} />,
      ),
    );
    expect(container.querySelector('[aria-label="Needs you: 3"]')?.textContent).toBe("3");
    expect(container.querySelector('[aria-label="Unread sitrep"]')).not.toBeNull();
  });

  it("does not bubble the Sitrep click to the heading", async () => {
    const onThreadActivate = vi.fn();
    const rowClick = vi.fn();
    await act(() =>
      root.render(
        <div onClick={rowClick}>
          <SidebarSitrepButton
            threadRef={pmThreadRef}
            summary={summary()}
            onThreadActivate={onThreadActivate}
          />
        </div>,
      ),
    );
    await act(async () => button("Sitrep")!.click());
    expect(onThreadActivate).toHaveBeenCalledExactlyOnceWith(pmThreadRef);
    expect(rowClick).not.toHaveBeenCalled();
  });
});

describe("project manager sidebar sections", () => {
  const shell = (id: string, patch: Record<string, unknown> = {}) => ({
    id,
    environmentId: "env-1",
    projectId: "project-1",
    archivedAt: null as string | null,
    createdAt: "2026-09-13T09:00:00.000Z",
    lineage: {
      rootThreadId: id,
      parentThreadId: null as string | null,
      relationshipToParent: null as string | null,
    },
    ...patch,
  });

  it("keeps a disabled or second manager in a section as an ordinary row", () => {
    const entries = [
      { environmentId: "env-1", summary: summary() },
      // The same repo in another environment, grouped into the same section.
      {
        environmentId: "env-2",
        summary: summary({ pmThreadId: "pm-thread-2" as never }),
      },
      {
        environmentId: "env-1",
        summary: summary({
          projectId: "project-2" as never,
          pmThreadId: "pm-off" as never,
          enabled: false,
        }),
      },
    ];
    const managers = selectSidebarProjectManagers(entries, (env, project) =>
      project === "project-1" ? "repo:project-1" : `${env}:${project}`,
    );
    const headingKeys = new Set(
      [...managers.values()].map((entry) => `${entry.environmentId}:${entry.summary.pmThreadId}`),
    );
    const threads = [
      shell("pm-thread"),
      shell("pm-thread-2", { environmentId: "env-2" }),
      shell("pm-off", { projectId: "project-2" }),
      shell("user-thread"),
    ];
    const visible = filterSidebarV2VisibleThreads(
      threads as never[],
      null,
      (thread: { environmentId: string; id: string }) =>
        headingKeys.has(`${thread.environmentId}:${thread.id}`),
    ) as { id: string }[];
    expect([...managers.keys()]).toEqual(["repo:project-1"]);
    expect(visible.map((thread) => thread.id)).toEqual(["pm-thread-2", "pm-off", "user-thread"]);
  });

  it("never lists the PM thread as a row", () => {
    const threads = [shell("pm-thread"), shell("user-thread")];
    const visible = filterSidebarV2VisibleThreads(
      threads as never[],
      null,
      (thread: { id: string }) => thread.id === "pm-thread",
    ) as { id: string }[];
    expect(visible.map((thread) => thread.id)).toEqual(["user-thread"]);
  });

  it("gives a heading only to enabled managers", () => {
    const entries = [
      { environmentId: "env-1", summary: summary() },
      {
        environmentId: "env-1",
        summary: summary({ projectId: "project-2" as never, enabled: false }),
      },
    ];
    const managers = selectSidebarProjectManagers(entries, (env, project) => `${env}:${project}`);
    expect([...managers.keys()]).toEqual(["env-1:project-1"]);
  });

  it("lists the PM's unarchived task leads as ordinary rows, but no other subagents", () => {
    const subagent = (id: string, parentThreadId: string, patch: Record<string, unknown> = {}) =>
      shell(id, {
        lineage: { rootThreadId: parentThreadId, parentThreadId, relationshipToParent: "subagent" },
        ...patch,
      });
    const threads = [
      shell("pm-thread"),
      subagent("lead", "pm-thread"),
      subagent("lead-archived", "pm-thread", { archivedAt: "2026-09-13T12:00:00Z" }),
      subagent("lead-other-env", "pm-thread", { environmentId: "env-2" }),
      subagent("helper", "user-thread"),
      subagent("grandchild", "lead"),
      shell("user-thread"),
    ];
    const isPmThread = (environmentId: string, threadId: string) =>
      environmentId === "env-1" && threadId === "pm-thread";
    const visible = filterSidebarV2VisibleThreads(
      threads as never[],
      null,
      (thread: { environmentId: string; id: string }) =>
        isPmThread(thread.environmentId, thread.id),
      (thread: Parameters<typeof isProjectManagerTaskLead>[0]) =>
        isProjectManagerTaskLead(thread, isPmThread),
    ) as { id: string }[];
    expect(visible.map((thread) => thread.id)).toEqual(["lead", "user-thread"]);
  });

  it("orders projects by their threads, then the rest in fallback order", () => {
    const grouped = groupSidebarThreadsByProject(
      [
        { id: "a-thread", project: "a" },
        { id: "b-thread", project: "b" },
        { id: "a-older", project: "a" },
      ],
      (thread) => thread.project,
    );
    expect(grouped.get("a")?.map((thread) => thread.id)).toEqual(["a-thread", "a-older"]);
    expect(orderSidebarProjectSections(grouped, ["c", "b", "a"])).toEqual(["a", "b", "c"]);
  });

  it("offers no archive or delete for a PM thread", () => {
    const base = {
      canOperate: true,
      branch: null,
      projectFilter: null,
      isPinned: false,
      isRegeneratingTitle: false,
      isRunning: false,
      supports: { pinning: true, titleRegeneration: true },
    };
    const ids = (items: ReadonlyArray<{ id: string }>) => items.map((item) => item.id);
    expect(ids(buildThreadActionMenuItems(base))).toEqual(
      expect.arrayContaining(["archive", "delete"]),
    );
    const pmItems = ids(buildThreadActionMenuItems({ ...base, isProjectManager: true }));
    expect(pmItems).not.toContain("archive");
    expect(pmItems).not.toContain("delete");
    const bulk = buildMultiSelectThreadContextMenuItems({
      count: 2,
      hasRunningThread: false,
      hasProjectManagerThread: true,
    });
    expect(bulk.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(bulk.find((item) => item.id === "delete")?.disabled).toBe(true);
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
    expect(state.notification).toHaveBeenCalledExactlyOnceWith("Remy (Busy) · Needs you: 2", {
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
    expect(state.notification).toHaveBeenCalledExactlyOnceWith("Remy (Busy) · Sitrep", {
      body: "Busy",
      tag: "env-1:pm-thread:sitrep",
      silent: true,
    });
    expect(state.sound).not.toHaveBeenCalled();
  });

  it("still alerts Needs-you but skips sitreps while the project manager is off", async () => {
    setTeam(summary({ enabled: false }));
    await render();
    setTeam(summary({ enabled: false, openCount: 1, latestBatchId: "batch-1" as never }));
    await render();
    setTeam(
      summary({
        enabled: false,
        openCount: 1,
        latestBatchId: "batch-1" as never,
        latestSitrepId: "sitrep-1" as never,
      }),
    );
    await render();
    expect(state.notification).toHaveBeenCalledExactlyOnceWith("Remy (Busy) · Needs you: 1", {
      body: "Busy",
      tag: "env-1:pm-thread:attention",
      silent: true,
    });
  });

  it("skips the sitrep notification when sitrep notifications are off", async () => {
    const quiet = {
      maxConcurrentTasks: 6,
      sitrepIntervalMinutes: 60,
      sitrepNotify: false,
      enabled: true,
    };
    setTeam(summary({ settings: quiet }));
    await render();
    setTeam(summary({ settings: quiet, latestSitrepId: "sitrep-1" as never }));
    await render();
    expect(state.notification).not.toHaveBeenCalled();
  });
});
