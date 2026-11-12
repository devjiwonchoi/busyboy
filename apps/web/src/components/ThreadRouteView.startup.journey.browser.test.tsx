import "~/index.css";

import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

// The app starts on the PM chat. The thread is already known, but which thread is the
// PM only arrives with the PM data a moment later. From the first frame to the last, the
// chat must never draw the PM as an ordinary thread.

const ENVIRONMENT_ID = "env-1" as EnvironmentId;
const PM_THREAD_ID = "pm-thread" as ThreadId;
const PM_REF = scopeThreadRef(ENVIRONMENT_ID, PM_THREAD_ID);

const stream = vi.hoisted(() => ({
  attention: null as Atom.Writable<AsyncResult.AsyncResult<unknown, unknown>> | null,
}));

// The PM data stream, driven by the test instead of a server.
vi.mock(import("@t3tools/client-runtime/state/project-team"), async (original) => {
  const actual = await original();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  stream.attention = Atom.make<AsyncResult.AsyncResult<unknown, unknown>>(
    AsyncResult.initial(true),
  );
  return {
    ...actual,
    createProjectTeamEnvironmentAtoms: ((runtime: never) => ({
      ...actual.createProjectTeamEnvironmentAtoms(runtime),
      attention: () => stream.attention,
    })) as never,
  };
});
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => () => Promise.resolve()) as never,
}));
// The thread list is already in and live.
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useThreadRefs: (() => [PM_REF]) as never,
  useEnvironmentThreadRefs: (() => [PM_REF]) as never,
  useQuietThreadShell: ((ref: unknown) =>
    ref === null
      ? null
      : {
          environmentId: ENVIRONMENT_ID,
          id: PM_THREAD_ID,
          deletedAt: null,
          latestRun: null,
          latestUserMessageAt: null,
          itemCount: 1,
          runtime: null,
        }) as never,
}));
vi.mock(import("../state/shell"), async (original) => ({
  ...(await original()),
  useEnvironmentShellStatus: (() => "live") as never,
}));

/** Every frame the chat committed, in order. */
const frames: string[] = [];

// ChatView picks the PM layout from the same hook; the probe records which one it drew.
vi.mock(import("./ChatView"), async () => {
  const { useIsProjectManagerThread } = await import("../state/projectTeam");
  function ChatViewProbe(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
    const isPm = useIsProjectManagerThread(scopeThreadRef(props.environmentId, props.threadId));
    const view = isPm ? "pm" : "ordinary-thread";
    useLayoutEffect(() => {
      frames.push(view);
    });
    return <section data-view={view}>{isPm ? "Otto · PM" : "Thread"}</section>;
  }
  return { default: ChatViewProbe as never };
});

import { PROJECT_TEAM_ATTENTION_GRACE_MS } from "../state/projectTeam";
import { ThreadRouteView } from "./ThreadRouteView";
import { SidebarProvider } from "./ui/sidebar";

const pmSummary = { projectId: "project-1", pmThreadId: PM_THREAD_ID };

let registry: AtomRegistry.AtomRegistry;
let root: Root;
let container: HTMLDivElement;

const pmDataArrives = () =>
  act(async () =>
    registry.set(
      stream.attention!,
      AsyncResult.success({
        byProjectId: new Map([[pmSummary.projectId, pmSummary]]),
        byPmThreadId: new Map([[PM_THREAD_ID, pmSummary]]),
      }),
    ),
  );

const openApp = () =>
  act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <SidebarProvider>
          <ThreadRouteView target={{ kind: "server", threadRef: PM_REF }} />
        </SidebarProvider>
      </RegistryContext.Provider>,
    ),
  );

const chat = () => container.querySelector<HTMLElement>("section[data-view]");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames.length = 0;
  registry = AtomRegistry.make();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  registry.dispose();
  container.remove();
  vi.unstubAllGlobals();
  await page.viewport(1280, 800);
});

describe.each([
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
])("opening the app on the PM chat ($name)", ({ width, height }) => {
  beforeEach(async () => {
    await page.viewport(width, height);
  });

  it("stays blank until the PM data arrives, then shows the PM chat first", async () => {
    await openApp();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(chat()).toBeNull();

    await pmDataArrives();

    await vi.waitFor(() => expect(chat()?.dataset.view).toBe("pm"));
    expect(frames).not.toContain("ordinary-thread");
    expect(frames[0]).toBe("pm");
  });

  it("opens right away when the PM data fails", async () => {
    await openApp();
    expect(chat()).toBeNull();

    await act(async () =>
      registry.set(stream.attention!, AsyncResult.failure(Cause.fail("offline"))),
    );

    await vi.waitFor(() => expect(chat()).not.toBeNull());
  });

  it("opens after a few seconds when the PM data never comes", async () => {
    await openApp();
    await new Promise((resolve) => setTimeout(resolve, PROJECT_TEAM_ATTENTION_GRACE_MS - 1000));
    expect(chat()).toBeNull();

    await vi.waitFor(() => expect(chat()).not.toBeNull(), { timeout: 3000 });
  });
});
