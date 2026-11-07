import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  EnvironmentId,
  ThreadId,
  type AssistantCitation,
} from "@t3tools/contracts";
import { act, useImperativeHandle, useRef, useState, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { longPressSelect, tap } from "../../test-touch-selection";

import { formatAssistantCitationForComposer } from "../../composer-logic";
import { useSideChatStore } from "../../sideChatStore";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import { useSideChatCitationInbox } from "./useSideChatCitationInbox";

const environmentId = EnvironmentId.make("environment");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("main-thread"));
const sideChatRef = scopeThreadRef(environmentId, ThreadId.make("side-thread"));
const reply = "Ship the release on Friday after the smoke tests pass.";

type CitingComposer = { citeAssistantText: (citation: AssistantCitation) => boolean };

/** Stands in for a chat composer: it shows what a citation inserts. */
function Composer({
  label,
  handleRef,
  ready = true,
}: {
  label: string;
  handleRef: RefObject<CitingComposer | null>;
  ready?: boolean;
}) {
  const [prompt, setPrompt] = useState("");
  useImperativeHandle(
    handleRef,
    () =>
      ready
        ? {
            citeAssistantText: (citation) => {
              setPrompt((current) => current + formatAssistantCitationForComposer(citation));
              return true;
            },
          }
        : (null as never),
    [ready],
  );
  return <textarea aria-label={label} readOnly value={prompt} />;
}

/** The side chat pane, whose composer is still starting until `ready`. */
function SideChat({ ready }: { ready: boolean }) {
  const composerRef = useRef<CitingComposer | null>(null);
  useSideChatCitationInbox(sideChatRef, composerRef as never);
  return (
    <section aria-label="Side chat">
      <Composer label="Side chat composer" handleRef={composerRef} ready={ready} />
    </section>
  );
}

/** A chat page: the assistant's reply, the main composer, and the side chat panel. */
function ChatPage({ sideChatAvailable }: { sideChatAvailable: boolean }) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [sideChatOpen, setSideChatOpen] = useState(false);
  const [sideChatReady, setSideChatReady] = useState(false);
  const mainComposerRef = useRef<CitingComposer | null>(null);
  return (
    <>
      <div ref={setViewport} data-assistant-citation-viewport="true">
        <p
          data-assistant-citation-source="assistant-message"
          data-assistant-citation-environment={environmentId}
          data-assistant-citation-thread={threadRef.threadId}
        >
          {reply}
        </p>
        <AssistantSelectionToolbar
          viewport={viewport}
          threadRef={threadRef}
          onCite={(citation) => mainComposerRef.current?.citeAssistantText(citation) ?? false}
          onAskInSideChat={
            sideChatAvailable
              ? (citation, sourceAnchor) => {
                  // Like ChatView: queue the quote, then open a side chat that starts up a
                  // moment later.
                  useSideChatStore.getState().queueCitation(sideChatRef, {
                    citation,
                    sourceAnchor,
                  });
                  setSideChatOpen(true);
                  window.setTimeout(() => setSideChatReady(true), 300);
                  return true;
                }
              : undefined
          }
        />
      </div>
      <Composer label="Main composer" handleRef={mainComposerRef} />
      {sideChatOpen ? <SideChat ready={sideChatReady} /> : null}
    </>
  );
}

let root: Root;

async function render(sideChatAvailable = true) {
  await act(() => root.render(<ChatPage sideChatAvailable={sideChatAvailable} />));
}

async function selectReply() {
  await userEvent.tripleClick(page.getByText(reply));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useSideChatStore.setState({ pendingCitationsByThreadKey: {} });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("selecting assistant text", () => {
  it("adds the quote to this chat's composer with Add to chat", async () => {
    await render();
    await selectReply();
    await userEvent.click(page.getByRole("button", { name: "Add to chat" }));

    const composer = page.getByRole("textbox", { name: "Main composer" });
    await expect.element(composer).toHaveValue(expect.stringContaining("t3-citation://v1/"));
    await expect.element(composer).toHaveValue(expect.stringContaining("Ship+the+release"));
    await expect.element(page.getByRole("toolbar")).not.toBeInTheDocument();
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
  });

  it("opens the side chat with the quote in its composer with Ask in side chat", async () => {
    await render();
    await selectReply();
    await userEvent.click(page.getByRole("button", { name: "Ask in side chat" }));

    const sideComposer = page.getByRole("textbox", { name: "Side chat composer" });
    await expect.element(sideComposer).toBeVisible();
    // The quote waits for the new side chat's composer, then lands there.
    await expect.element(sideComposer).toHaveValue(expect.stringContaining("t3-citation://v1/"));
    await expect.element(sideComposer).toHaveValue(expect.stringContaining("Ship+the+release"));
    await expect.element(page.getByRole("textbox", { name: "Main composer" })).toHaveValue("");
    expect(useSideChatStore.getState().pendingCitationsByThreadKey).toEqual({});
  });

  it("offers only Add to chat where a side chat cannot open", async () => {
    await render(false);
    await selectReply();

    await expect.element(page.getByRole("button", { name: "Add to chat" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Ask in side chat" }))
      .not.toBeInTheDocument();
  });
});

describe("selecting assistant text by touch on a phone", () => {
  beforeEach(async () => {
    await page.viewport(390, 844);
  });

  it("shows the actions below the selection and adds the quote with Add to chat", async () => {
    await render();
    await longPressSelect(page.getByText(reply).element(), "release", "Friday");

    const toolbar = await vi.waitFor(() => page.getByRole("toolbar").element());
    // Below the last selected line, clear of the end handle; the phone's own menu sits above.
    const selected = window.getSelection()!.getRangeAt(0).getClientRects();
    const lastLine = selected.item(selected.length - 1)!;
    const box = toolbar.getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(lastLine.bottom + 20);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);

    // The tap clears the selection before it lands; the action still goes through.
    await tap(page.getByRole("button", { name: "Add to chat" }).element());
    const composer = page.getByRole("textbox", { name: "Main composer" });
    await expect.element(composer).toHaveValue(expect.stringContaining("release+on+Friday"));
    await expect.element(page.getByRole("toolbar")).not.toBeInTheDocument();
  });

  it("asks in the side chat", async () => {
    await render();
    await longPressSelect(page.getByText(reply).element(), "smoke", "tests");
    await tap(
      await vi.waitFor(() => page.getByRole("button", { name: "Ask in side chat" }).element()),
    );

    const sideComposer = page.getByRole("textbox", { name: "Side chat composer" });
    await expect.element(sideComposer).toHaveValue(expect.stringContaining("smoke+tests"));
  });

  it("hides the actions on a tap elsewhere in the reply", async () => {
    await render();
    const text = page.getByText(reply).element();
    await longPressSelect(text, "Ship");
    await vi.waitFor(() => page.getByRole("toolbar").element());
    await tap(text);
    await expect.element(page.getByRole("toolbar")).not.toBeInTheDocument();
  });
});

describe("selecting too much text", () => {
  it("asks to shorten the selection instead of offering either action", async () => {
    const longReply = "word ".repeat(ASSISTANT_CITATION_MAX_TEXT_LENGTH / 4);
    const container = document.createElement("div");
    document.body.append(container);
    const longRoot = createRoot(container);
    function LongPage() {
      const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
      return (
        <div ref={setViewport} data-assistant-citation-viewport="true">
          <p
            data-assistant-citation-source="long-message"
            data-assistant-citation-environment={environmentId}
            data-assistant-citation-thread={threadRef.threadId}
          >
            {longReply}
          </p>
          <AssistantSelectionToolbar
            viewport={viewport}
            threadRef={threadRef}
            onCite={() => true}
            onAskInSideChat={() => true}
          />
        </div>
      );
    }
    await act(() => longRoot.render(<LongPage />));
    await userEvent.tripleClick(page.getByText(longReply.trim()));

    await expect.element(page.getByRole("button", { name: "Shorten selection" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Add to chat" })).not.toBeInTheDocument();
    await act(() => longRoot.unmount());
  });
});
