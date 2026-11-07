import { RegistryContext } from "@effect/atom-react";
import type { AuthSessionState, DesktopUpdateState, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;

const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  toast: vi.fn(),
  sessionAtom: null as unknown,
  configAtom: null as unknown,
  desktopStateAtom: null as unknown,
  updateStateAtom: null as unknown,
}));

vi.mock(import("~/hooks/useThreadRouteTarget"), async (original) => ({
  ...(await original()),
  useThreadRouteTarget: (() => null) as never,
}));
vi.mock(import("./useUpdateEverything"), async (original) => ({
  ...(await original()),
  useUpdateEverything: (() => ({
    hasUpdates: false,
    summary: "",
    lines: [],
    restarts: [],
    skipped: [],
    run: async () => {},
  })) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironment: (() => ({
    environmentId: "env-mac" as EnvironmentId,
    label: "Mac",
  })) as never,
}));
vi.mock(import("~/state/session"), async (original) => {
  const actual = await original();
  const { appAtomRegistry } = await import("~/rpc/atomRegistry");
  const { Atom: A } = await import("effect/reactivity");
  testState.sessionAtom = A.make<unknown>(null).pipe(A.keepAlive);
  const grants = () => {
    const result = appAtomRegistry.get(testState.sessionAtom as Atom.Atom<SessionResult>);
    return result._tag === "Success" && result.value.authenticated
      ? (result.value.scopes as ReadonlyArray<string>)
      : [];
  };
  return {
    ...actual,
    environmentSession: {
      ...actual.environmentSession,
      sessionStateAtom: (() => testState.sessionAtom) as never,
    },
    useEnvironmentScope: ((_id: unknown, scope: string) => grants().includes(scope)) as never,
  };
});
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  testState.configAtom = A.make<unknown>(null).pipe(A.keepAlive);
  testState.desktopStateAtom = A.make<unknown>(R.success(null)).pipe(A.keepAlive);
  testState.updateStateAtom = A.make<unknown>({ status: "idle" }).pipe(A.keepAlive);
  return {
    ...actual,
    primaryServerConfigAtom: testState.configAtom as never,
    serverEnvironment: {
      ...actual.serverEnvironment,
      desktopUpdateState: (() => testState.desktopStateAtom) as never,
      updateStateAtom: (() => testState.updateStateAtom) as never,
    },
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => testState.updateServer) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: testState.toast } };
});

import {
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "~/confirmDialog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

const sessionAuth = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "t3_session",
} as const;

function session(scopes: ReadonlyArray<string>): SessionResult {
  return AsyncResult.success({
    authenticated: true,
    scopes,
    auth: sessionAuth,
  } as unknown as AuthSessionState);
}

function desktopState(overrides: Partial<DesktopUpdateState>): DesktopUpdateState {
  return {
    enabled: true,
    status: "idle",
    channel: "latest",
    currentVersion: "0.0.13",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
    omittedReleaseCount: 0,
    ...overrides,
  };
}

const READY = desktopState({
  status: "downloaded",
  availableVersion: "0.0.14",
  downloadedVersion: "0.0.14",
});

let root: Root;
let container: HTMLDivElement;

function setup({
  scopes = ["environment:maintain"],
  state = READY,
  desktopAppUpdate = true,
}: {
  readonly scopes?: ReadonlyArray<string>;
  readonly state?: DesktopUpdateState | null;
  readonly desktopAppUpdate?: boolean;
} = {}) {
  const set = (atom: unknown, value: unknown) =>
    appAtomRegistry.set(atom as Atom.Writable<unknown>, value);
  set(testState.sessionAtom, session(scopes));
  set(testState.configAtom, {
    environment: { capabilities: desktopAppUpdate ? { desktopAppUpdate: true } : {} },
  });
  set(testState.desktopStateAtom, AsyncResult.success(state));
  set(testState.updateStateAtom, { status: "idle" });
}

async function render() {
  await act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <ul className="flex w-[320px]">
          <SidebarUpdatePill />
        </ul>
      </RegistryContext.Provider>,
    ),
  );
}

function restartButton() {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "재시작해서 업데이트",
  );
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await page.viewport(390, 844);
  testState.updateServer.mockReset();
  testState.toast.mockReset();
  resetConfirmDialogForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetConfirmDialogForTests();
  vi.unstubAllGlobals();
});

describe("phone desktop update", () => {
  it("installs the ready desktop update only after the user confirms", async () => {
    setup();
    registerConfirmDialogHost();
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.14", method: "desktop-app" }),
    );
    await render();

    expect(container.textContent).toContain("데스크톱 앱 0.0.14 준비됨");
    await act(async () => restartButton()!.click());
    expect(readConfirmDialogState()).toEqual(
      expect.objectContaining({
        status: "confirming",
        message: expect.stringContaining("0.0.14로 업데이트할까요?"),
      }),
    );
    expect(testState.updateServer).not.toHaveBeenCalled();

    await act(async () => respondToConfirmDialog(true));
    await vi.waitFor(() => expect(testState.updateServer).toHaveBeenCalledTimes(1));
    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-mac",
      input: { targetVersion: "0.0.14" },
    });
    await vi.waitFor(() =>
      expect(testState.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "success",
          description: "Desktop app relaunched on 0.0.14.",
        }),
      ),
    );
  });

  it("does nothing when the user cancels the confirm dialog", async () => {
    setup();
    registerConfirmDialogHost();
    await render();

    await act(async () => restartButton()!.click());
    await act(async () => respondToConfirmDialog(false));

    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it("shows the install error when the desktop app fails to install", async () => {
    setup();
    registerConfirmDialogHost();
    testState.updateServer.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("The update signature did not verify."))),
    );
    await render();

    await act(async () => restartButton()!.click());
    await act(async () => respondToConfirmDialog(true));

    await vi.waitFor(() =>
      expect(testState.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          description: "The update signature did not verify.",
        }),
      ),
    );
    expect(restartButton()!.disabled).toBe(false);
  });

  it("shows download progress and up-to-date state without a restart button", async () => {
    setup({ state: desktopState({ status: "downloading", downloadPercent: 42.7 }) });
    await render();
    expect(container.textContent).toContain("데스크톱 앱 업데이트 다운로드 중 42%");
    expect(restartButton()).toBeUndefined();

    await act(async () => root.unmount());
    root = createRoot(container);
    setup({ state: desktopState({ status: "up-to-date" }) });
    await render();
    expect(container.textContent).toContain("데스크톱 앱 최신 (0.0.13)");
    expect(restartButton()).toBeUndefined();
  });

  it.each([
    { name: "without environment:maintain", scopes: ["orchestration:operate"] },
    { name: "when the server is not run by the desktop app", desktopAppUpdate: false },
  ])("hides the restart button $name", async ({ scopes, desktopAppUpdate }) => {
    setup({
      ...(scopes ? { scopes } : {}),
      ...(desktopAppUpdate === undefined ? {} : { desktopAppUpdate }),
    });
    await render();
    expect(restartButton()).toBeUndefined();
    expect(container.querySelector("[data-testid=phone-desktop-update]")).toBeNull();
  });

  it("hides a version that already failed to apply on the Mac", async () => {
    setup({ state: { ...READY, notAppliedVersion: "0.0.14" } });
    await render();
    expect(restartButton()).toBeUndefined();
  });
});
