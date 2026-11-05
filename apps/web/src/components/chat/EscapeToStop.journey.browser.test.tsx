import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ESCAPE_TO_STOP_WINDOW_MS, useEscapeToStop } from "./useEscapeToStop";
import { useRunStop } from "./useRunStop";

// The thread view's stop wiring (ChatView): the real round button, the real
// Escape listener and the real stop hook, against a simulated server turn.
type Turn = "idle" | "starting" | "running";

const server = {
  interrupt: vi.fn(),
  startRun: () => {},
};

function ThreadView() {
  const [prompt, setPrompt] = useState("");
  const [turn, setTurn] = useState<Turn>("idle");
  server.startRun = () => setTurn("running");
  const runStop = useRunStop({
    threadKey: "thread-1",
    canInterrupt: turn === "running",
    isStarting: turn === "starting",
    interrupt: () => {
      server.interrupt();
      setTurn("idle");
    },
  });
  const escapeArmed = useEscapeToStop({
    canStop: runStop.canStop && !runStop.stopPending,
    threadKey: "thread-1",
    ignoreEscape: () => false,
    onStop: runStop.requestStop,
  });
  return (
    <div>
      <div data-testid="timeline" tabIndex={-1}>
        Timeline
      </div>
      <textarea
        aria-label="Composer"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <ComposerPrimaryActions
        compact={false}
        canOperateThread
        pendingAction={null}
        isRunning={turn === "running"}
        canInterrupt={runStop.canStop}
        stopPending={runStop.stopPending}
        escapeArmed={escapeArmed}
        showPlanFollowUpPrompt={false}
        promptHasText={prompt.length > 0}
        isSendBusy={turn === "starting"}
        sendDisabledReason={null}
        isConnecting={false}
        isEnvironmentUnavailable={false}
        isPreparingWorktree={false}
        hasSendableContent={prompt.trim().length > 0}
        onSubmitMessage={() => {
          setPrompt("");
          setTurn("starting");
        }}
        onPreviousPendingQuestion={() => {}}
        onInterrupt={runStop.requestStop}
        onImplementPlanInNewThread={() => {}}
      />
    </div>
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  server.interrupt.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<ThreadView />));
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const stopButton = () =>
  container.querySelector<HTMLButtonElement>('button[aria-keyshortcuts="Escape"]');

const pressEscape = () =>
  act(async () => {
    await userEvent.keyboard("{Escape}");
  });

async function startTurn() {
  await userEvent.click(container.querySelector("textarea")!);
  await userEvent.keyboard("Fix the bug");
  await act(async () => {
    await userEvent.click(container.querySelector('[aria-label="Submit message"]')!);
  });
}

describe("Esc stops a run", () => {
  it("stops a turn that is still starting: Esc arms, Esc again stops once the run exists", async () => {
    await startTurn();

    // Right after send the round button is already the stop button and reads "Esc".
    expect(stopButton()?.textContent).toBe("Esc");
    expect(stopButton()?.getAttribute("aria-label")).toBe("Stop generation");

    await pressEscape();
    expect(stopButton()?.getAttribute("aria-label")).toBe("Press Esc again to stop");
    expect(stopButton()?.dataset.escapeArmed).toBe("true");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Press Esc again to stop");

    await pressEscape();
    // The server has no run yet, so the stop is held.
    expect(stopButton()?.getAttribute("aria-label")).toBe("Stopping");
    expect(server.interrupt).not.toHaveBeenCalled();

    await act(() => server.startRun());
    expect(server.interrupt).toHaveBeenCalledOnce();
    expect(stopButton()).toBeNull();
    expect(container.querySelector('[aria-label="Submit message"]')).not.toBeNull();
  });

  it("stops a running turn with two presses while focus is in the timeline", async () => {
    await startTurn();
    await act(() => server.startRun());
    container.querySelector<HTMLElement>('[data-testid="timeline"]')!.focus();

    await pressEscape();
    expect(server.interrupt).not.toHaveBeenCalled();
    await pressEscape();
    expect(server.interrupt).toHaveBeenCalledOnce();
  });

  it("does not stop when a single press times out", async () => {
    await startTurn();
    await act(() => server.startRun());
    vi.useFakeTimers();

    await act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    expect(stopButton()?.dataset.escapeArmed).toBe("true");

    await act(() => vi.advanceTimersByTime(ESCAPE_TO_STOP_WINDOW_MS));
    expect(stopButton()?.dataset.escapeArmed).toBeUndefined();
    expect(stopButton()?.getAttribute("aria-label")).toBe("Stop generation");
    expect(server.interrupt).not.toHaveBeenCalled();

    // The next press arms again instead of stopping.
    await act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    expect(server.interrupt).not.toHaveBeenCalled();
    expect(stopButton()?.dataset.escapeArmed).toBe("true");
  });

  it("stops at once when the button is clicked", async () => {
    await startTurn();
    await act(() => server.startRun());

    await act(async () => {
      await userEvent.click(stopButton()!);
    });
    expect(server.interrupt).toHaveBeenCalledOnce();
  });
});
