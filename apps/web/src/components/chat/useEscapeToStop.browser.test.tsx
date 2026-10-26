import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ESCAPE_TO_STOP_WINDOW_MS, useEscapeToStop } from "./useEscapeToStop";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Harness(props: { canStop: boolean; threadKey: string; onStop: () => void }) {
  const showHint = useEscapeToStop({
    canStop: props.canStop,
    threadKey: props.threadKey,
    ignoreEscape: () => false,
    onStop: props.onStop,
  });
  return showHint ? <span role="status">Esc</span> : null;
}

const render = (props: { canStop: boolean; threadKey: string; onStop: () => void }) =>
  act(() => root.render(<Harness {...props} />));

const pressEscape = (target: EventTarget) =>
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });

const hint = () => document.querySelector('[role="status"]');

describe("useEscapeToStop", () => {
  it("shows the hint on the first Escape and stops on the second", async () => {
    const onStop = vi.fn();
    await render({ canStop: true, threadKey: "a", onStop });

    await pressEscape(window);
    expect(hint()?.textContent).toBe("Esc");
    expect(onStop).not.toHaveBeenCalled();

    await pressEscape(window);
    expect(onStop).toHaveBeenCalledOnce();
    expect(hint()).toBeNull();
  });

  it("lets the first Escape lapse after the window", async () => {
    vi.useFakeTimers();
    const onStop = vi.fn();
    await render({ canStop: true, threadKey: "a", onStop });

    await pressEscape(window);
    await act(() => vi.advanceTimersByTime(ESCAPE_TO_STOP_WINDOW_MS));
    expect(hint()).toBeNull();

    await pressEscape(window);
    expect(onStop).not.toHaveBeenCalled();
    expect(hint()).not.toBeNull();
  });

  it("drops a pending first Escape when the thread changes", async () => {
    const onStop = vi.fn();
    await render({ canStop: true, threadKey: "a", onStop });
    await pressEscape(window);

    await render({ canStop: true, threadKey: "b", onStop });
    expect(hint()).toBeNull();
    await pressEscape(window);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("ignores Escape when nothing is running or another control handled it", async () => {
    const onStop = vi.fn();
    await render({ canStop: false, threadKey: "a", onStop });
    await pressEscape(window);
    expect(hint()).toBeNull();

    await render({ canStop: true, threadKey: "a", onStop });
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    await pressEscape(menu);
    menu.remove();

    const editor = document.createElement("div");
    editor.addEventListener("keydown", (event) => event.preventDefault());
    document.body.append(editor);
    await pressEscape(editor);
    editor.remove();

    expect(hint()).toBeNull();
    expect(onStop).not.toHaveBeenCalled();
  });
});
