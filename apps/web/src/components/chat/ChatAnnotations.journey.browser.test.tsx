import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { longPressSelect, tap } from "../../test-touch-selection";

import { useComposerDraftStore } from "../../composerDraftStore";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import { useChatAnnotations, withComposerAnnotations } from "./useChatAnnotations";

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => () => Promise.resolve()) as never,
}));

const environmentId = EnvironmentId.make("environment");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("main-thread"));
const first = "BusyBoy keeps remote access behind a pairing token on this Mac.";
const second = "Ship the release on Friday after the smoke tests pass.";

/**
 * A chat page as ChatView builds it: the timeline box hosts the pins, the selection toolbar's
 * Add to chat adds an annotation, and the composer shows the chip and sends the quotes ahead
 * of the prompt.
 */
function ChatPage({ onSend }: { onSend: (text: string) => void }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const annotations = useChatAnnotations(threadRef);
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}>
      <div ref={setHost} style={{ position: "relative", minHeight: 0, flex: 1 }}>
        {annotations.overlay(host)}
        <div
          ref={setViewport}
          data-assistant-citation-viewport="true"
          style={{
            position: "absolute",
            inset: 0,
            overflowY: "auto",
            padding: "160px 16px 0",
            fontSize: 14,
          }}
        >
          {[first, second].map((text, index) => (
            <p
              key={text}
              style={{ marginBottom: 96 }}
              data-assistant-citation-source={`message-${index + 1}`}
              data-assistant-citation-environment={environmentId}
              data-assistant-citation-thread={threadRef.threadId}
            >
              {text}
            </p>
          ))}
          <div style={{ height: "150vh" }} />
          <AssistantSelectionToolbar
            viewport={viewport}
            threadRef={threadRef}
            onCite={(citation) => annotations.add(citation)}
          />
        </div>
      </div>
      <form
        data-composer
        style={{ padding: 12, borderTop: "1px solid" }}
        onSubmit={(event) => {
          event.preventDefault();
          const store = useComposerDraftStore.getState();
          onSend(
            withComposerAnnotations(
              "What do you think?",
              store.getComposerDraft(threadRef)?.annotations ?? [],
            ),
          );
          store.clearComposerContent(threadRef);
        }}
      >
        {annotations.chip}
        <button type="submit">Send</button>
      </form>
    </div>
  );
}

let root: Root;
let sent: string[];

function pin(number: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-annotation-pin="${number}"]`);
}
function pill(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-annotation-pill]");
}
function chip(): string | undefined {
  return document.querySelector("[data-annotations-chip]")?.textContent?.trim();
}

async function annotate(text: string) {
  await userEvent.tripleClick(page.getByText(text));
  await userEvent.click(page.getByRole("button", { name: "Add to chat" }));
  await vi.waitFor(() => expect(pill()?.dataset.annotationPill).toBe("new"));
  const input = pill()!.querySelector("textarea")!;
  await vi.waitFor(() => expect(document.activeElement).toBe(input));
  expect(input.placeholder).toBe("Add an optional comment…");
}

/** Codex places the pill above the pin, the pin above the text, all on screen. */
function expectPlacement(number: number, text: string) {
  const pinBox = pin(number)!.getBoundingClientRect();
  const pillBox = pill()!.getBoundingClientRect();
  const textBox = page.getByText(text).element().getBoundingClientRect();
  expect(pinBox.bottom).toBeLessThanOrEqual(textBox.top + 1);
  expect(pillBox.bottom).toBeLessThanOrEqual(pinBox.top);
  expect(pillBox.top).toBeGreaterThanOrEqual(0);
  expect(pillBox.left).toBeGreaterThanOrEqual(0);
  expect(pillBox.right).toBeLessThanOrEqual(window.innerWidth);
}

describe.each([
  { name: "desktop", width: 1100, height: 800 },
  { name: "phone", width: 390, height: 844 },
])("annotating chat text on $name", ({ width, height }) => {
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    await page.viewport(width, height);
    sent = [];
    useComposerDraftStore.getState().clearComposerContent(threadRef);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(() => root.render(<ChatPage onSend={(text) => sent.push(text)} />));
  });

  afterEach(async () => {
    await act(() => root.unmount());
    window.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("pins, comments, edits, deletes and sends annotations", async () => {
    // Add to chat: pin 1 with its pill above it, a blue highlight, nothing in the prompt.
    await annotate(first);
    await vi.waitFor(() => expect(pin(1)?.textContent).toBe("1"));
    await vi.waitFor(() => expectPlacement(1, first));
    expect(CSS.highlights.get("t3-annotation")?.size).toBe(1);
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
    await userEvent.keyboard("Is the token one-time?");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(pill()).toBeNull());
    expect(chip()).toBe("1 annotation");

    // A second one, saved with ✓ and no comment.
    await annotate(second);
    await vi.waitFor(() => expect(pin(2)?.textContent).toBe("2"));
    await userEvent.click(page.getByRole("button", { name: "Save annotation" }));
    await vi.waitFor(() => expect(chip()).toBe("2 annotations"));

    // A third, cancelled with Esc: gone, numbering unchanged.
    await annotate(second);
    await vi.waitFor(() => expect(pin(3)).not.toBeNull());
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(pin(3)).toBeNull());
    expect(chip()).toBe("2 annotations");

    // Pin 1 reopens for editing; Cancel keeps the saved comment.
    await userEvent.click(pin(1)!);
    await vi.waitFor(() => expect(pill()?.dataset.annotationPill).toBe("edit"));
    expectPlacement(1, first);
    expect(pill()!.querySelector("textarea")!.value).toBe("Is the token one-time?");
    await userEvent.keyboard(" Draft");
    await userEvent.click(page.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(pill()).toBeNull());

    // Deleting pin 1 renumbers the other one to 1.
    await userEvent.click(pin(1)!);
    await vi.waitFor(() => expect(pill()?.dataset.annotationPill).toBe("edit"));
    expect(pill()!.querySelector("textarea")!.value).toBe("Is the token one-time?");
    await userEvent.click(page.getByRole("button", { name: "Delete annotation" }));
    await vi.waitFor(() => expect(chip()).toBe("1 annotation"));
    expect(pin(2)).toBeNull();
    expect(pin(1)).not.toBeNull();

    // The chip lists it and reopens it to add a comment.
    await userEvent.click(page.getByRole("button", { name: "1 annotation" }));
    const entry = page.getByRole("button", { name: new RegExp(second.slice(0, 20)) });
    await userEvent.click(entry);
    await vi.waitFor(() => expect(pill()?.dataset.annotationPill).toBe("edit"));
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(pill()!.querySelector("textarea")),
    );
    await userEvent.keyboard("Friday is a holiday.");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(pill()).toBeNull());

    // Send: the quote and its comment go ahead of the prompt; pins and chip clear.
    await userEvent.click(page.getByRole("button", { name: "Send" }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("t3-citation://v1/");
    expect(sent[0]).toContain("Ship+the+release");
    expect(sent[0]).toContain("Friday+is+a+holiday");
    expect(sent[0]).not.toContain("one-time");
    expect(sent[0]!.endsWith("What do you think?")).toBe(true);
    await vi.waitFor(() => expect(pin(1)).toBeNull());
    expect(chip()).toBeUndefined();
    expect(CSS.highlights.get("t3-annotation")?.size ?? 0).toBe(0);
  });

  it.runIf(width < 768)("annotates a touch selection", async () => {
    await longPressSelect(page.getByText(second).element(), "release", "Friday");
    const add = await vi.waitFor(() => page.getByRole("button", { name: "Add to chat" }).element());
    await tap(add);

    await vi.waitFor(() => expect(pill()?.dataset.annotationPill).toBe("new"));
    await vi.waitFor(() => expect(pin(1)?.textContent).toBe("1"));
    await userEvent.keyboard("Which Friday?");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(chip()).toBe("1 annotation"));

    await userEvent.click(page.getByRole("button", { name: "Send" }));
    expect(sent[0]).toContain("release+on+Friday");
    expect(sent[0]).toContain("Which+Friday");
  });

  it("keeps the pill inside the screen when the text is at the top", async () => {
    const viewport = document.querySelector<HTMLElement>("[data-assistant-citation-viewport]")!;
    viewport.scrollTop = 150;
    await annotate(first);
    await vi.waitFor(() => {
      const box = pill()!.getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(window.innerWidth);
      expect(box.left).toBeGreaterThanOrEqual(0);
    });
    // No room above: it drops below the text instead of covering it.
    const textBox = page.getByText(first).element().getBoundingClientRect();
    expect(pill()!.getBoundingClientRect().top).toBeGreaterThanOrEqual(textBox.bottom);
    await userEvent.keyboard("{Escape}");
  });
});
