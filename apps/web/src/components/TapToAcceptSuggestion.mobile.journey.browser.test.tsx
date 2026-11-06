import type { Editor } from "@tiptap/core";
import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

// History that completes "exa" to example.com. Results are cached per input,
// like the real hook's state, so renders see a stable object.
const suggestionCache = vi.hoisted(() => new Map<string, unknown>());
vi.mock(import("./preview/useAddressBarSuggestionData"), async (original) => ({
  ...(await original()),
  useAddressBarSuggestionData: ((input: { text: string }) => {
    let result = suggestionCache.get(input.text);
    if (!result) {
      result = {
        data: {
          matchesFor: input.text,
          matches: input.text ? [{ url: "https://example.com/", title: "Example" }] : [],
          topOrigin: null,
          remoteFor: "",
          remote: [],
          frequent: [],
        },
        removeUrl: () => {},
      };
      suggestionCache.set(input.text, result);
    }
    return result;
  }) as never,
}));

import { ComposerCommandMenu, type ComposerCommandItem } from "./chat/ComposerCommandMenu";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { PreviewChromeRow } from "./preview/PreviewChromeRow";

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await page.viewport(390, 844);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const SUGGESTION = "Run the tests and fix failures";

/** The composer as ChatComposer wires it: the suggestion shows as the placeholder. */
function SuggestingComposer(props: { tappable: boolean }) {
  const [value, setValue] = useState("");
  return (
    <ComposerPromptEditor
      editorRef={createRef<ComposerPromptEditorHandle>()}
      ariaLabel="Message"
      value={value}
      cursor={value.length}
      contextRecords={new Map()}
      skills={[]}
      disabled={false}
      placeholder={value ? "" : `${SUGGESTION}  (${props.tappable ? "tap" : "Tab"})`}
      onPlaceholderActivate={props.tappable && !value ? () => setValue(SUGGESTION) : undefined}
      onChange={(next) => setValue(next)}
      onPaste={() => {}}
    />
  );
}

function editorElement() {
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element;
}

describe("tap to accept a suggestion at phone width", () => {
  it("fills the composer when the suggestion text is tapped", async () => {
    await act(async () => root.render(<SuggestingComposer tappable />));

    await userEvent.click(page.getByRole("button", { name: `${SUGGESTION} (tap)` }));

    await expect.poll(() => editorElement().textContent).toBe(SUGGESTION);
    expect(document.activeElement).toBe(editorElement());
  });

  it("leaves the placeholder inert when tap-to-accept is off (desktop)", async () => {
    await page.viewport(1280, 800);
    await act(async () => root.render(<SuggestingComposer tappable={false} />));

    expect(page.getByRole("button", { name: /Run the tests/ }).query()).toBeNull();
    await userEvent.click(editorElement());
    expect(editorElement().textContent).toBe("");
  });

  it("picks a / menu item when it is tapped", async () => {
    const onSelect = vi.fn();
    const items: ComposerCommandItem[] = [
      { id: "plan", type: "slash-command", command: "plan", label: "/plan", description: "Plan" },
      {
        id: "default",
        type: "slash-command",
        command: "default",
        label: "/default",
        description: "Default",
      },
    ];
    await act(async () =>
      root.render(
        <ComposerCommandMenu
          listId="suggestions"
          items={items}
          resolvedTheme="light"
          isLoading={false}
          triggerKind="slash-command"
          activeItemId="plan"
          onHighlightedItemChange={() => {}}
          onSelect={onSelect}
        />,
      ),
    );

    await userEvent.click(page.getByText("/default"));

    expect(onSelect).toHaveBeenCalledWith(items[1]);
  });

  it("accepts the address bar's inline completion on a touch tap", async () => {
    const onSubmit = vi.fn();
    await act(async () =>
      root.render(
        <PreviewChromeRow
          url=""
          loading={false}
          canGoBack={false}
          canGoForward={false}
          refreshDisabled={false}
          onBack={() => {}}
          onForward={() => {}}
          onRefresh={() => {}}
          onSubmit={onSubmit}
          suggestionsProfileId="default"
        />,
      ),
    );
    const input = container.querySelector<HTMLInputElement>("[data-preview-url-input]")!;
    await userEvent.type(input, "exa");
    await expect.poll(() => input.value).toBe("example.com/");
    expect(input.selectionStart).toBe(3);

    await act(async () => {
      input.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }));
    });

    await expect.poll(() => input.selectionStart).toBe("example.com/".length);
    expect(input.selectionEnd).toBe("example.com/".length);
    // Typing now extends the accepted text instead of replacing the completion.
    await userEvent.keyboard("x");
    expect(input.value).toBe("example.com/x");
  });
});
