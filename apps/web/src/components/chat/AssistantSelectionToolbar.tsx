import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
  type SelectionInput,
} from "~/lib/selectionActions";
import { Button } from "../ui/button";

export function AssistantSelectionToolbar({
  viewport,
  threadRef,
  onCite,
  onAskInSideChat,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef;
  /** "Add to chat": quotes the selection in this thread's composer. */
  onCite: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
  /** "Ask in side chat": omitted where a side chat cannot open. */
  onAskInSideChat?:
    | ((citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean)
    | undefined;
}) {
  const [selection, setSelection] = useState<{
    citation: AssistantCitation;
    position: SelectionActionPoint;
    sourceAnchor: AssistantCitationSourceAnchor;
  } | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    const rect = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8))}px`;
  }, [selection]);

  useEffect(() => {
    if (!viewport) return;
    const clear = () => setSelection(null);
    const update = (pointer: SelectionActionPoint | null, input: SelectionInput) => {
      const nativeSelection = window.getSelection();
      const captured = captureAssistantTextSelection(viewport, nativeSelection);
      const messageId = captured?.source.dataset.assistantCitationSource;
      if (!captured || !messageId) {
        clear();
        return;
      }
      const rect = captured.range.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      if (rect.bottom < viewportRect.top || rect.top > viewportRect.bottom || rect.width === 0) {
        clear();
        return;
      }
      const rects = captured.range.getClientRects();
      const pointerOnText =
        pointer !== null &&
        Array.from(rects).some(
          (line) =>
            pointer.x >= line.left - 8 &&
            pointer.x <= line.right + 8 &&
            pointer.y >= line.top - 8 &&
            pointer.y <= line.bottom + 8,
        );
      setSelection({
        sourceAnchor: { source: captured.source, range: captured.range, viewport },
        citation: {
          version: 1,
          ...threadRef,
          messageId: MessageId.make(messageId),
          ...captured.selector,
        },
        position: resolveSelectionActionPosition({
          bounds: viewportRect,
          selectionRect: rects.item(rects.length - 1) ?? rect,
          pointer: pointerOnText ? pointer : null,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          input,
        }),
      });
    };
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => toolbarRef.current,
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    const focusActions = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        toolbar.contains(event.target as Node)
      ) {
        return;
      }
      const firstAction = toolbar.querySelector<HTMLButtonElement>("button:not(:disabled)");
      if (!firstAction) return;
      event.preventDefault();
      event.stopPropagation();
      firstAction.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", focusActions, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [threadRef, viewport]);

  if (!selection) return null;
  const tooLong = selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const act = (
    handler: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean,
  ) => {
    if (tooLong || !handler(selection.citation, selection.sourceAnchor)) return false;
    window.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Selection actions"
      className="surface-glass fixed z-50 flex max-w-[calc(100vw-1rem)] items-center rounded-lg border border-border/60 p-0.5 text-foreground shadow-sm"
      style={{ left: selection.position.x, top: selection.position.y }}
      onPointerDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      {tooLong ? (
        <Button type="button" size="xs" variant="ghost" disabled>
          Shorten selection
        </Button>
      ) : (
        <>
          <Button type="button" size="xs" variant="ghost" onClick={() => act(onCite)}>
            Add to chat
          </Button>
          {onAskInSideChat ? (
            <>
              <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />
              <Button type="button" size="xs" variant="ghost" onClick={() => act(onAskInSideChat)}>
                Ask in side chat
              </Button>
            </>
          ) : null}
        </>
      )}
    </div>,
    document.body,
  );
}
