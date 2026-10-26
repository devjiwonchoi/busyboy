import { describe, expect, it, vi } from "vite-plus/test";

import { makeComputerUseOverlayController, overlayHtml } from "./ComputerUseOverlay.ts";

function setup() {
  const view = { show: vi.fn(), hide: vi.fn(), dispose: vi.fn() };
  const requestStop = vi.fn();
  const stopWatcher = vi.fn();
  let pressEscape = () => {};
  let finishStarting: (stop: () => void) => void = () => {};
  const startEscWatcher = vi.fn(
    (onEscape: () => void) =>
      new Promise<() => void>((resolve) => {
        pressEscape = onEscape;
        finishStarting = resolve;
      }),
  );
  const controller = makeComputerUseOverlayController({
    view,
    startEscWatcher,
    requestStop,
    onWatcherFailure: vi.fn(),
  });
  return {
    controller,
    view,
    requestStop,
    stopWatcher,
    startEscWatcher,
    pressEscape: () => pressEscape(),
    watcherReady: async () => {
      finishStarting(stopWatcher);
      await Promise.resolve();
    },
  };
}

describe("ComputerUseOverlay", () => {
  it("shows the overlay and listens for Escape while an agent acts", async () => {
    const test = setup();

    test.controller.update({ acting: true, appName: "TextEdit" });
    await test.watcherReady();
    test.pressEscape();

    expect(test.view.show).toHaveBeenCalledWith("TextEdit");
    expect(test.requestStop).toHaveBeenCalledTimes(1);
  });

  it("hides the overlay and stops listening when the agent is done", async () => {
    const test = setup();
    test.controller.update({ acting: true, appName: "TextEdit" });
    await test.watcherReady();

    test.controller.update({ acting: false });

    expect(test.view.hide).toHaveBeenCalled();
    expect(test.stopWatcher).toHaveBeenCalledTimes(1);
  });

  it("starts one watcher however often the status repeats", async () => {
    const test = setup();
    test.controller.update({ acting: true, appName: "TextEdit" });
    test.controller.update({ acting: true, appName: "Notes" });
    await test.watcherReady();
    test.controller.update({ acting: true, appName: "Notes" });

    expect(test.startEscWatcher).toHaveBeenCalledTimes(1);
    expect(test.view.show).toHaveBeenLastCalledWith("Notes");
  });

  it("stops a watcher that finishes starting after the agent is done", async () => {
    const test = setup();
    test.controller.update({ acting: true, appName: "TextEdit" });
    test.controller.update({ acting: false });

    await test.watcherReady();

    expect(test.stopWatcher).toHaveBeenCalledTimes(1);
  });

  it("names the app safely", () => {
    expect(overlayHtml('<img src=x onerror="1">')).toContain(
      "&#60;img src=x onerror=&#34;1&#34;&#62;",
    );
  });
});
