import { ComputerUseApprovalError, EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import type { ComputerUseApprovalItem } from "@t3tools/client-runtime/computer-use-approval";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({ answer: vi.fn() }));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => state.answer) as never,
}));

import { ComputerUseApprovalCard } from "./ComputerUseApprovalCard";

const environmentId = EnvironmentId.make("local");
const item = {
  id: TurnItemId.make("turn-item:computer-use-approval:1"),
  threadId: ThreadId.make("thread-1"),
  type: "computer_use_approval",
  appName: "TextEdit",
  bundleId: "com.apple.TextEdit",
  approvalStatus: "pending",
} as ComputerUseApprovalItem;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.answer.mockReset().mockResolvedValue(Exit.succeed(undefined));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (card: ComputerUseApprovalItem, visibility: "local" | "inherited" = "local") =>
  act(async () =>
    root.render(
      <ComputerUseApprovalCard environmentId={environmentId} item={card} visibility={visibility} />,
    ),
  );

it("asks before the agent uses an app and sends the chosen answer", async () => {
  await render(item);

  await expect.element(page.getByText("Allow the agent to use TextEdit?")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Allow in this thread" }));

  expect(state.answer).toHaveBeenCalledWith({
    environmentId,
    input: { threadId: item.threadId, turnItemId: item.id, decision: "allow_thread" },
  });
});

it("shows the server's reason when the answer is refused", async () => {
  state.answer.mockResolvedValue(
    Exit.failCause(Cause.fail(new ComputerUseApprovalError({ reason: "agent_stopped" }))),
  );
  await render(item);

  await userEvent.click(page.getByRole("button", { name: "Always allow" }));

  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("The agent that asked has stopped.");
});

it("shows the outcome once answered, and no buttons", async () => {
  await render({ ...item, approvalStatus: "allowed_always" });

  await expect.element(page.getByText("Use TextEdit · Always allowed")).toBeVisible();
  expect(container.querySelector("button")).toBeNull();
});

it("can only be answered in the thread that asked", async () => {
  await render(item, "inherited");

  await expect
    .element(page.getByText("Use TextEdit · Waiting for an answer in the original thread"))
    .toBeVisible();
  expect(container.querySelector("button")).toBeNull();
});
