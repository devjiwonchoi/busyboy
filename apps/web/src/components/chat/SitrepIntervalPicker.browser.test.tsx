import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  allowed: true,
}));

vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useUpdateTeamSettings: (() => state.updateSettings) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => state.allowed,
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { SitrepIntervalPicker } from "./SitrepIntervalPicker";

const projectRef = { environmentId: "env-1", projectId: "project-1" } as never;
let current: ProjectTeamAttentionSummary;
let root: Root;
let container: HTMLDivElement;

function summary(minutes: number, intervalPinnedAt?: string): ProjectTeamAttentionSummary {
  return {
    projectId: "project-1",
    pmThreadId: "pm-thread",
    openCount: 0,
    latestBatchId: null,
    latestSitrepId: null,
    unreadSitrepCount: 0,
    sitrepInProgress: false,
    settings: {
      maxConcurrentTasks: 6,
      sitrepIntervalMinutes: minutes,
      sitrepNotify: true,
      ...(intervalPinnedAt ? { intervalPinnedAt } : {}),
    },
  } as ProjectTeamAttentionSummary;
}

const renderPicker = () =>
  act(() => root.render(<SitrepIntervalPicker projectRef={projectRef} summary={current} />));

const trigger = () => container.querySelector<HTMLButtonElement>('[aria-label^="Sitrep "]')!;
const minutesInput = () =>
  document.querySelector<HTMLInputElement>('[aria-label="Sitrep interval in minutes"]')!;

async function saveInterval(value: string) {
  if (!minutesInput()) await act(async () => trigger().click());
  await userEvent.clear(minutesInput());
  await userEvent.type(minutesInput(), `${value}{Enter}`);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.allowed = true;
  current = summary(60);
  // The server pins a user-saved interval and pushes the new summary.
  state.updateSettings.mockReset().mockImplementation(async (_ref, patch) => {
    if (patch.sitrepIntervalMinutes !== undefined) {
      current = summary(patch.sitrepIntervalMinutes, "2026-11-05T00:00:00.000Z");
      await renderPicker();
    }
    return { _tag: "Success" };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("sitrep interval picker", () => {
  it("marks a server-chosen interval as auto and offers only the interval and notifications", async () => {
    await renderPicker();
    expect(trigger().textContent).toBe("Sitrep 1hauto");
    await act(async () => trigger().click());
    const popup = minutesInput().closest('[data-slot="popover-popup"]')!;
    expect(popup.textContent).toBe("Sitrep everyminutesSitrep notifications");
    expect(minutesInput().value).toBe("60");
    expect(popup.querySelector('[role="switch"]')).not.toBeNull();
  });

  it("saves a typed interval on Enter and shows it on the button", async () => {
    await renderPicker();
    await saveInterval("45");
    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith(projectRef, {
      sitrepIntervalMinutes: 45,
    });
    expect(trigger().textContent).toBe("Sitrep 45m");

    await saveInterval("90");
    expect(trigger().textContent).toBe("Sitrep 1h 30m");
  });

  it("saves a typed interval when a phone tap closes the picker without blurring the input", async () => {
    const outside = document.createElement("div");
    outside.style.cssText = "width: 200px; height: 200px";
    document.body.append(outside);
    await renderPicker();
    await act(async () => trigger().click());
    // The phone number pad has no Enter key.
    await userEvent.clear(minutesInput());
    await userEvent.type(minutesInput(), "30");
    // On iOS a tap on plain content closes the popover but leaves focus in the input.
    await act(async () => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
        const Event = type.startsWith("pointer") ? PointerEvent : MouseEvent;
        outside.dispatchEvent(
          new Event(type, { bubbles: true, button: 0, pointerType: "touch" } as never),
        );
      }
      outside.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await vi.waitFor(() => expect(minutesInput()).toBeNull());
    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith(projectRef, {
      sitrepIntervalMinutes: 30,
    });
    expect(trigger().textContent).toBe("Sitrep 30m");
    outside.remove();
  });

  it("closes on Escape and saves the typed interval once", async () => {
    await renderPicker();
    await act(async () => trigger().click());
    await userEvent.clear(minutesInput());
    await userEvent.type(minutesInput(), "25");
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(minutesInput()).toBeNull());
    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith(projectRef, {
      sitrepIntervalMinutes: 25,
    });
  });

  it("keeps what the user is typing when the server changes the interval meanwhile", async () => {
    await renderPicker();
    await act(async () => trigger().click());
    await userEvent.clear(minutesInput());
    await userEvent.type(minutesInput(), "45");
    current = summary(30);
    await renderPicker();
    expect(minutesInput().value).toBe("45");
    await userEvent.keyboard("{Enter}");
    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith(projectRef, {
      sitrepIntervalMinutes: 45,
    });
  });

  it("does not save an interval outside 5 to 1440 minutes", async () => {
    await renderPicker();
    await saveInterval("3");
    expect(minutesInput().getAttribute("aria-invalid")).toBe("true");
    await act(async () => minutesInput().blur());
    expect(state.updateSettings).not.toHaveBeenCalled();
    expect(trigger().textContent).toBe("Sitrep 1hauto");
  });

  it("does not pin the auto interval when the picker is opened and closed untouched", async () => {
    await renderPicker();
    await act(async () => trigger().click());
    await act(async () => minutesInput().focus());
    await act(async () => minutesInput().blur());
    await userEvent.keyboard("{Escape}");
    expect(minutesInput()).toBeNull();
    expect(state.updateSettings).not.toHaveBeenCalled();
    expect(trigger().textContent).toBe("Sitrep 1hauto");
  });

  it("toggles sitrep notifications without saving the interval", async () => {
    await renderPicker();
    await act(async () => trigger().click());
    await act(async () => minutesInput().focus());
    // Clicking the switch blurs the minutes input first.
    await act(async () => minutesInput().blur());
    await act(async () => document.querySelector<HTMLElement>('[role="switch"]')!.click());
    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith(projectRef, {
      sitrepNotify: false,
    });
    expect(state.updateSettings.mock.calls[0]![1]).not.toHaveProperty("sitrepIntervalMinutes");
  });
});

describe("sitrep send button", () => {
  const baseProps = {
    compact: false,
    canOperateThread: true,
    pendingAction: null,
    isRunning: false,
    canInterrupt: false,
    showPlanFollowUpPrompt: false,
    promptHasText: false,
    isSendBusy: false,
    sendDisabledReason: null,
    isConnecting: false,
    isEnvironmentUnavailable: false,
    isPreparingWorktree: false,
    onPreviousPendingQuestion: () => {},
    onInterrupt: () => {},
    onImplementPlanInNewThread: () => {},
  };
  const sitrepButton = () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Sitrep now"]');
  const sendButton = () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Submit message"]');

  it("turns the empty PM composer's send button into Sitrep until text is typed", async () => {
    const onSitrep = vi.fn();
    await act(() =>
      root.render(
        <ComposerPrimaryActions {...baseProps} hasSendableContent={false} onSitrep={onSitrep} />,
      ),
    );
    expect(sendButton()).toBeNull();
    await act(async () => sitrepButton()!.click());
    expect(onSitrep).toHaveBeenCalledOnce();

    await act(() =>
      root.render(
        <ComposerPrimaryActions
          {...baseProps}
          hasSendableContent={false}
          onSitrep={onSitrep}
          sitrepInProgress
        />,
      ),
    );
    expect(sitrepButton()!.disabled).toBe(true);

    await act(() =>
      root.render(
        <ComposerPrimaryActions
          {...baseProps}
          promptHasText
          hasSendableContent
          onSitrep={onSitrep}
        />,
      ),
    );
    expect(sitrepButton()).toBeNull();
    expect(sendButton()!.disabled).toBe(false);
  });

  it("lets Stop and Resume win over the Sitrep pill", async () => {
    await act(() =>
      root.render(
        <ComposerPrimaryActions
          {...baseProps}
          isRunning
          canInterrupt
          hasSendableContent={false}
          onSitrep={() => {}}
        />,
      ),
    );
    expect(sitrepButton()).toBeNull();
    expect(container.querySelector('[aria-label="Stop generation"]')).not.toBeNull();

    await act(() =>
      root.render(
        <ComposerPrimaryActions
          {...baseProps}
          canResume
          hasSendableContent={false}
          onSitrep={() => {}}
        />,
      ),
    );
    expect(sitrepButton()).toBeNull();
    expect(container.querySelector('[aria-label="Resume thread"]')).not.toBeNull();
  });

  it("leaves the send button alone on other threads", async () => {
    await act(() =>
      root.render(<ComposerPrimaryActions {...baseProps} hasSendableContent={false} />),
    );
    expect(sitrepButton()).toBeNull();
    expect(sendButton()!.disabled).toBe(true);
  });
});
