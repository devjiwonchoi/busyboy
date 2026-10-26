import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { PreviewChromeRow } from "./PreviewChromeRow";

const SUGGESTIONS = [
  { url: "https://github.com/devjiwonchoi/busyboy", title: "busyboy", typed: true },
  { url: "https://docs.github.com/en", title: "GitHub Docs", typed: false },
];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = async (suggestions: ReadonlyArray<unknown> = SUGGESTIONS) => {
  const onSubmit = vi.fn();
  const suggestHistory = vi.fn().mockResolvedValue(suggestions);
  await act(async () =>
    root.render(
      <PreviewChromeRow
        url=""
        loading={false}
        canGoBack={false}
        canGoForward={false}
        refreshDisabled
        onBack={() => {}}
        onForward={() => {}}
        onRefresh={() => {}}
        onSubmit={onSubmit}
        suggestHistory={suggestHistory}
      />,
    ),
  );
  const input = container.querySelector<HTMLInputElement>("[data-preview-url-input]")!;
  return { input, onSubmit, suggestHistory };
};

const options = () => [...document.querySelectorAll('[role="option"]')];

describe("PreviewChromeRow address suggestions", () => {
  it("completes the top host inline and submits it on Enter", async () => {
    const { input, onSubmit } = await render();
    await userEvent.click(input);
    await userEvent.keyboard("git");

    await vi.waitFor(() => expect(input.value).toBe("github.com"));
    expect(input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0)).toBe("hub.com");
    expect(options()).toHaveLength(2);

    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("github.com");
  });

  it("moves through suggestions with the arrow keys and opens the chosen one", async () => {
    const { input, onSubmit } = await render();
    await userEvent.click(input);
    await userEvent.keyboard("git");
    await vi.waitFor(() => expect(options()).toHaveLength(2));

    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[1]?.id);

    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("https://docs.github.com/en");
  });

  it("does not complete again after Backspace, and Escape closes the list first", async () => {
    const { input } = await render();
    await userEvent.click(input);
    await userEvent.keyboard("git");
    await vi.waitFor(() => expect(input.value).toBe("github.com"));

    await userEvent.keyboard("{Backspace}");
    await vi.waitFor(() => expect(options()).toHaveLength(2));
    expect(input.value).toBe("git");

    await userEvent.keyboard("{Escape}");
    expect(options()).toHaveLength(0);
    expect(document.activeElement).toBe(input);
  });

  it("goes to the last suggestion on ArrowUp from the input", async () => {
    const { input, onSubmit } = await render();
    await userEvent.click(input);
    await userEvent.keyboard("git");
    await vi.waitFor(() => expect(options()).toHaveLength(2));

    await userEvent.keyboard("{ArrowUp}");
    expect(options()[1]?.getAttribute("aria-selected")).toBe("true");

    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("https://docs.github.com/en");
  });

  it("goes to exactly the host typed out in full, not a longer one from history", async () => {
    const { input, onSubmit } = await render([
      { url: "https://github.com.evil.io/login", title: "Sign in", typed: true },
    ]);
    await userEvent.click(input);
    await userEvent.keyboard("github.com");
    await vi.waitFor(() => expect(options()).toHaveLength(1));
    expect(input.value).toBe("github.com");

    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("github.com");
  });

  it("does not complete a host the user never typed or chose", async () => {
    const { input, onSubmit } = await render([
      { url: "https://gitlab-phish.io/", title: "GitLab", typed: false },
    ]);
    await userEvent.click(input);
    await userEvent.keyboard("git");
    await vi.waitFor(() => expect(options()).toHaveLength(1));
    expect(input.value).toBe("git");

    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("git");
  });

  it("chooses a suggestion with the mouse", async () => {
    const { input, onSubmit } = await render();
    await userEvent.click(input);
    await userEvent.keyboard("docs");
    await vi.waitFor(() => expect(options()).toHaveLength(2));

    await userEvent.click(options()[0]!);
    expect(onSubmit).toHaveBeenCalledWith("https://github.com/devjiwonchoi/busyboy");
  });
});
