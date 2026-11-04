import type { ComputerUseAppRequestChoice } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  COMPUTER_USE_APP_REQUEST_NOTE,
  ComputerUseAppRequestPrompt,
} from "./ComputerUseAppRequestCard";

let root: Root;
let container: HTMLDivElement;
const onChoose = vi.fn((_choice: ComputerUseAppRequestChoice) => undefined);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onChoose.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function render(app: { appName: string; bundleId: string; allowAlways: boolean }) {
  await act(async () =>
    root.render(
      <ComputerUseAppRequestPrompt
        item={{ type: "computer_use_app_request", ...app }}
        disabled={false}
        error={null}
        onChoose={onChoose}
      />,
    ),
  );
}

const buttons = () => [...container.querySelectorAll("button")];
const button = (label: string) => buttons().find((entry) => entry.textContent?.trim() === label)!;

describe("ComputerUseAppRequestPrompt", () => {
  it("names the app and its bundle ID, warns, and sends each choice", async () => {
    await render({ appName: "TextEdit", bundleId: "com.apple.TextEdit", allowAlways: true });
    expect(container.textContent).toContain("Let the agent use TextEdit?");
    expect(container.textContent).toContain("com.apple.TextEdit");
    expect(container.textContent).toContain(COMPUTER_USE_APP_REQUEST_NOTE);
    expect(buttons().map((entry) => entry.textContent?.trim())).toEqual([
      "Deny",
      "Always allow",
      "Allow for this thread",
      "Allow once",
    ]);

    const expected: Array<[string, ComputerUseAppRequestChoice]> = [
      ["Allow once", "allow_once"],
      ["Allow for this thread", "allow_thread"],
      ["Always allow", "always"],
      ["Deny", "deny"],
    ];
    for (const [label, choice] of expected) {
      onChoose.mockClear();
      await act(async () => button(label).click());
      expect(onChoose).toHaveBeenCalledExactlyOnceWith(choice);
    }
  });

  it("never offers Always allow for System Settings", async () => {
    await render({
      appName: "System Settings",
      bundleId: "com.apple.systempreferences",
      allowAlways: true,
    });
    expect(buttons().map((entry) => entry.textContent?.trim())).toEqual([
      "Deny",
      "Allow for this thread",
      "Allow once",
    ]);
    await render({
      appName: "System Settings",
      bundleId: "com.apple.Settings",
      allowAlways: false,
    });
    expect(buttons().map((entry) => entry.textContent?.trim())).not.toContain("Always allow");
  });
});
