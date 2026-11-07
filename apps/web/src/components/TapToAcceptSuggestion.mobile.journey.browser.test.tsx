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

import { revealAndFocusWithinTap } from "./chat/revealAndFocusWithinTap";
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
      className="min-h-24"
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

/**
 * The phone composer as ChatComposer lays it out while unfocused: a one-line
 * "Expand composer" row, with the editor mounted but hidden until it expands.
 */
function CollapsedComposer() {
  const [expanded, setExpanded] = useState(false);
  const [value, setValue] = useState("");
  const [editorRef] = useState(() => createRef<ComposerPromptEditorHandle>());
  return (
    <div>
      {expanded ? null : (
        <button
          type="button"
          aria-label="Expand composer"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() =>
            revealAndFocusWithinTap(
              () => setExpanded(true),
              () => editorRef.current?.focusAtEnd(),
            )
          }
        >
          {`${SUGGESTION}`}
        </button>
      )}
      <div style={expanded ? undefined : { display: "none" }}>
        <ComposerPromptEditor
          editorRef={editorRef}
          ariaLabel="Message"
          value={value}
          cursor={value.length}
          contextRecords={new Map()}
          skills={[]}
          disabled={false}
          placeholder={value ? "" : `${SUGGESTION}  (tap)`}
          onPlaceholderActivate={value ? undefined : () => setValue(SUGGESTION)}
          onChange={(next) => setValue(next)}
          onPaste={() => {}}
        />
      </div>
    </div>
  );
}

function editorElement() {
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element;
}

/** Width of `text` in the input's font, as laid out from the input's left padding. */
function textWidth(input: HTMLInputElement, text: string) {
  const context = document.createElement("canvas").getContext("2d")!;
  context.font = getComputedStyle(input).font;
  return context.measureText(text).width;
}

/** A touch tap `x` pixels into the input's text. */
function tapInputAt(input: HTMLInputElement, x: number) {
  const rect = input.getBoundingClientRect();
  const clientX = rect.left + parseFloat(getComputedStyle(input).paddingLeft) + x;
  input.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      pointerType: "touch",
      clientX,
      clientY: rect.top + rect.height / 2,
    }),
  );
}

describe("tap to accept a suggestion at phone width", () => {
  it("focuses the collapsed composer with one tap, inside that tap", async () => {
    await act(async () => root.render(<CollapsedComposer />));
    // iOS Safari only focuses (and raises the keyboard) when focus() runs
    // inside the tap, so record focus as the tap's click finishes.
    let focusedDuringTap: Element | null = null;
    const recordFocus = () => {
      focusedDuringTap = document.activeElement;
    };
    window.addEventListener("click", recordFocus);

    await userEvent.click(page.getByRole("button", { name: "Expand composer" }));
    window.removeEventListener("click", recordFocus);

    expect(focusedDuringTap).toBe(editorElement());
    expect(document.activeElement).toBe(editorElement());
    expect(editorElement().textContent).toBe("");
  });

  it("only focuses an unfocused composer; the suggestion is not accepted", async () => {
    await act(async () => root.render(<SuggestingComposer tappable />));
    expect(document.activeElement).not.toBe(editorElement());

    await userEvent.click(page.getByRole("button", { name: `${SUGGESTION} (tap)` }));

    await expect.poll(() => document.activeElement).toBe(editorElement());
    expect(editorElement().textContent).toBe("");
    await expect.element(page.getByRole("button", { name: `${SUGGESTION} (tap)` })).toBeVisible();
  });

  it("fills the composer when the suggestion text is tapped while focused", async () => {
    await act(async () => root.render(<SuggestingComposer tappable />));
    await act(async () => editorElement().focus());

    await userEvent.click(page.getByRole("button", { name: `${SUGGESTION} (tap)` }));

    await expect.poll(() => editorElement().textContent).toBe(SUGGESTION);
    expect(document.activeElement).toBe(editorElement());
  });

  it("does not accept when a focused composer is tapped away from the suggestion", async () => {
    await act(async () => root.render(<SuggestingComposer tappable />));
    await act(async () => editorElement().focus());
    const box = editorElement().getBoundingClientRect();

    // Low in the input box, well below the one-line suggestion text.
    await userEvent.click(editorElement(), { position: { x: 300, y: box.height - 10 } });

    expect(editorElement().textContent).toBe("");
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

    // A tap on the typed "exa" leaves the completion pending.
    await act(async () => tapInputAt(input, textWidth(input, "e") / 2));
    expect(input.value).toBe("example.com/");
    expect(input.selectionStart).toBe(3);
    expect(input.selectionEnd).toBe("example.com/".length);

    // A tap on the completed "mple.com/" accepts it.
    await act(async () => tapInputAt(input, textWidth(input, "example")));

    await expect.poll(() => input.selectionStart).toBe("example.com/".length);
    expect(input.selectionEnd).toBe("example.com/".length);
    // Typing now extends the accepted text instead of replacing the completion.
    await userEvent.keyboard("x");
    expect(input.value).toBe("example.com/x");
  });
});
