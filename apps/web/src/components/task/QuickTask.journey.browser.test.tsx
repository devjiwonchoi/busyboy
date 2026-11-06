import "~/index.css";

import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  createTask: vi.fn(),
  startUpload: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_RESOLVED_KEYBINDINGS } = await import("@t3tools/shared/keybindings");
  return {
    ...(await original()),
    primaryServerKeybindingsAtom: Atom.make(DEFAULT_RESOLVED_KEYBINDINGS) as never,
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [
    { id: "busyboy", environmentId: "env-1", title: "busyboy" },
    { id: "website", environmentId: "env-1", title: "website" },
  ]) as never,
  // The open thread belongs to "website".
  useQuietThreadShell: ((ref: unknown) =>
    ref === null ? null : { environmentId: "env-1", projectId: "website" }) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => ["env-1"]) as never,
}));
vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useProjectManagerEntries: (() => [
    { environmentId: "env-1", summary: { projectId: "busyboy" } },
    { environmentId: "env-1", summary: { projectId: "website" } },
  ]) as never,
  useCreateTask: (() => state.createTask) as never,
}));
// Uploads go through the server's signed upload URLs; here every file uploads at once.
vi.mock(import("../../lib/attachmentUploadQueue"), () => ({
  startAttachmentUpload: state.startUpload as never,
  awaitAttachmentUploads: (async () => undefined) as never,
  releaseAttachmentUpload: (() => undefined) as never,
  getUploadedAttachments: ((input: { images: { type: string; name: string }[] }) =>
    input.images.map((image, index) => ({
      ...image,
      id: `pending-${index}`,
    }))) as never,
  useAttachmentUploadStore: ((select: (s: { uploadsByImageId: object }) => unknown) =>
    select({ uploadsByImageId: {} })) as never,
}));

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";

import { PanelLayoutControls } from "../chat/PanelLayoutControls";
import { QuickTaskHost } from "./QuickTaskHost";
import { closeQuickTask } from "./quickTaskStore";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  closeQuickTask();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.createTask.mockResolvedValue(
    AsyncResult.success({
      task: { id: "task-9", projectId: "website", title: "Checkout button overlaps" },
      key: "WE-9",
      versions: [],
      sessions: [],
      children: [],
      openAttention: [],
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** A chat screen: the real header controls, a stand-in thread, and the app-wide host. */
async function renderChatScreen() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <header className="flex justify-end">
          <PanelLayoutControls
            showNewTaskControl
            terminalAvailable
            terminalOpen={false}
            terminalShortcutLabel={null}
            threadPanelOpen={false}
            threadPanelPresentation="inline"
            threadPanelShortcutLabel={null}
            rightPanelAvailable
            rightPanelOpen={false}
            rightPanelShortcutLabel={null}
            onToggleTerminal={vi.fn()}
            onToggleThreadPanel={vi.fn()}
            onToggleRightPanel={vi.fn()}
          />
        </header>
        <Outlet />
        <QuickTaskHost />
      </>
    ),
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$environmentId/$threadId",
    component: () => <main>thread</main>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([threadRoute]),
    history: createMemoryHistory({ initialEntries: ["/env-1/thread-1"] }),
  });
  await act(async () => root.render(<RouterProvider router={router} />));
  return router;
}

async function pngFile(name: string): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 4;
  canvas.getContext("2d")!.fillRect(0, 0, 4, 4);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
  return new File([blob], name, { type: "image/png" });
}

describe("quick task", () => {
  it("Cmd+N opens it on the current project; a pasted screenshot rides along", async () => {
    await page.viewport(1280, 800);
    const router = await renderChatScreen();

    await userEvent.keyboard("{Meta>}n{/Meta}");
    const context = page.getByRole("textbox", { name: "Task context" });
    await expect.element(context).toBeVisible();
    // The open thread's project is preselected.
    await expect
      .element(page.getByRole("combobox", { name: "Project" }))
      .toHaveTextContent("website");

    await userEvent.fill(context, "Checkout button overlaps\nSee the screenshot.");
    const clipboard = new DataTransfer();
    clipboard.items.add(await pngFile("screenshot.png"));
    await act(async () => {
      context
        .element()
        .dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true }));
    });
    await expect.element(page.getByRole("listitem").getByText("screenshot.png")).toBeVisible();
    expect(state.startUpload).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "env-1" }),
    );

    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    await vi.waitFor(() => expect(state.createTask).toHaveBeenCalledOnce());
    expect(state.createTask).toHaveBeenCalledWith("env-1", {
      projectId: "website",
      title: "Checkout button overlaps",
      context: "Checkout button overlaps\nSee the screenshot.",
      startPlanning: true,
      attachments: [
        expect.objectContaining({ type: "image", id: "pending-0", name: "screenshot.png" }),
      ],
    });
    await expect.element(context).not.toBeInTheDocument();
    // The user stays on the thread.
    expect(router.state.location.pathname).toBe("/env-1/thread-1");
  });

  it("asks for a description instead of creating an empty task", async () => {
    await page.viewport(1280, 800);
    await renderChatScreen();
    await userEvent.keyboard("{Meta>}n{/Meta}");
    await userEvent.click(page.getByRole("button", { name: /Create task/ }));
    await expect.element(page.getByText("Describe the task first.")).toBeVisible();
    expect(state.createTask).not.toHaveBeenCalled();
  });

  it("gives phones a + button that opens the same sheet", async () => {
    await page.viewport(390, 844);
    await renderChatScreen();

    const add = page.getByRole("button", { name: "New task" });
    await expect.element(add).toBeVisible();
    await userEvent.click(add);
    await expect.element(page.getByRole("textbox", { name: "Task context" })).toBeVisible();

    // From md up the header leaves it to Cmd+N.
    await userEvent.click(page.getByRole("button", { name: "Close" }));
    await expect
      .element(page.getByRole("textbox", { name: "Task context" }))
      .not.toBeInTheDocument();
    await page.viewport(1280, 800);
    await vi.waitFor(() =>
      expect(
        getComputedStyle(container.querySelector('button[aria-label="New task"]')!).display,
      ).toBe("none"),
    );
  });
});
