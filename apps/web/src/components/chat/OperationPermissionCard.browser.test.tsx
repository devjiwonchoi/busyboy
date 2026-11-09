import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  answers: [] as Array<unknown>,
  finish: null as (() => void) | null,
  hold: false,
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => async (input: { input: unknown }) => {
    state.answers.push(input.input);
    if (state.hold) {
      await new Promise<void>((resolve) => {
        state.finish = resolve;
      });
    }
    return { _tag: "Success", value: undefined };
  }) as never,
}));

import { OperationPermissionCard, type OperationPermissionItem } from "./OperationPermissionCard";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

const card = (overrides: Partial<OperationPermissionItem>): OperationPermissionItem =>
  ({
    id: TurnItemId.make("turn-item:permission:1"),
    threadId,
    runId: "run-1",
    nodeId: "node-root",
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "waiting",
    title: "Operation permission",
    startedAt: "2026-11-09T00:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-11-09T00:00:00.000Z",
    type: "operation_permission",
    operation: "thread.send",
    summary: "진행 상황을 정리해 주세요.",
    reason: "대상 스레드는 full-access 권한으로 실행됩니다.",
    targetDescription: "BusyBoy PM · full-access",
    fingerprint: "request-fingerprint",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    permissionStatus: "pending",
    ...overrides,
  }) as OperationPermissionItem;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.answers.length = 0;
  state.finish = null;
  state.hold = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  state.finish?.();
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (item: OperationPermissionItem, visibility: "local" | "inherited" = "local") =>
  act(async () =>
    root.render(
      <OperationPermissionCard environmentId={environmentId} item={item} visibility={visibility} />,
    ),
  );

describe("operation permission card", () => {
  it("waits for a direct choice and sends an approval once", async () => {
    await render(card({}));
    await expect
      .element(page.getByText("BusyBoy PM · full-access", { exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByText("대상 스레드는 full-access 권한으로 실행됩니다."))
      .toBeVisible();
    expect(state.answers).toEqual([]);

    await userEvent.click(page.getByRole("button", { name: "이번 한 번 허용" }));
    await vi.waitFor(() =>
      expect(state.answers).toEqual([
        { threadId, turnItemId: "turn-item:permission:1", decision: "allow" },
      ]),
    );
    await expect.element(page.getByText(/승인됨 · 실행 준비 중/)).toBeVisible();
    expect(container.querySelector("button")).toBeNull();
  });

  it("sends a denial without granting permission", async () => {
    await render(card({}));
    await userEvent.click(page.getByRole("button", { name: "거절", exact: true }));
    await vi.waitFor(() =>
      expect(state.answers).toEqual([
        { threadId, turnItemId: "turn-item:permission:1", decision: "deny" },
      ]),
    );
    await expect.element(page.getByText(/거절됨 · 실행하지 않음/)).toBeVisible();
  });

  it("ignores repeated clicks while the response is in flight", async () => {
    state.hold = true;
    await render(card({}));
    const allow = container.querySelector("button");
    if (allow === null) {
      throw new Error("Approval button was not rendered.");
    }
    await act(async () => {
      allow.click();
      allow.click();
    });
    expect(state.answers).toHaveLength(1);
    await expect.element(page.getByRole("button", { name: "이번 한 번 허용" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "거절", exact: true })).toBeDisabled();
    await act(async () => state.finish?.());
  });

  it("removes approval controls when a pending request expires", async () => {
    await render(card({ expiresAt: new Date(Date.now() + 1_000).toISOString() }));
    await expect.element(page.getByRole("button", { name: "이번 한 번 허용" })).toBeVisible();
    await expect.element(page.getByText(/만료됨 · 실행하지 않음/)).toBeVisible();
    expect(container.querySelector("button")).toBeNull();
    expect(state.answers).toEqual([]);
  });

  it.each([
    ["approved", "승인됨 · 실행 준비 중"],
    ["declined", "거절됨 · 실행하지 않음"],
    ["cancelled", "취소됨 · 실행하지 않음"],
    ["expired", "만료됨 · 실행하지 않음"],
    ["consumed", "승인 사용됨 · 실행 중"],
    ["succeeded", "실행 완료"],
    ["failed", "실행 실패"],
  ] as const)("shows %s without allowing another answer", async (permissionStatus, label) => {
    await render(card({ permissionStatus }));
    await expect.element(page.getByText(label, { exact: false })).toBeVisible();
    expect(container.querySelector("button")).toBeNull();
    expect(state.answers).toEqual([]);
  });

  it("does not offer approval for a request inherited from another thread", async () => {
    await render(card({}), "inherited");
    await expect.element(page.getByText(/원래 스레드에서 사용자 승인을 기다립니다/)).toBeVisible();
    expect(container.querySelector("button")).toBeNull();
    expect(state.answers).toEqual([]);
  });
});
