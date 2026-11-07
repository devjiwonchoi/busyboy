import type { AssistantCitation } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { create } from "zustand";

import {
  type ComposerAnnotation,
  type ComposerThreadTarget,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { formatAssistantCitationForComposer } from "~/composer-logic";
import { assistantCitationNavigation } from "~/lib/assistantCitationNavigation";
import {
  findAssistantCitationSourceAnchor,
  resolveAssistantCitationRange,
} from "~/lib/assistantTextSelection";
import { randomUUID } from "~/lib/utils";
import {
  AnnotationOverlay,
  type AnnotationEditing,
  scrollAnnotationIntoView,
} from "../annotations/AnnotationOverlay";
import { AnnotationsChip } from "../annotations/AnnotationsChip";

const EMPTY: ReadonlyArray<ComposerAnnotation> = [];

/** The one annotation pill open anywhere; shared by the timeline's pins and the composer chip. */
const useAnnotationEditingStore = create<{
  editing: AnnotationEditing;
  setEditing: (editing: AnnotationEditing) => void;
}>((set) => ({ editing: null, setEditing: (editing) => set({ editing }) }));

/** The quotes and comments a message carries, ahead of what the user typed. */
export function withComposerAnnotations(
  prompt: string,
  annotations: ReadonlyArray<ComposerAnnotation>,
): string {
  if (annotations.length === 0) return prompt;
  const quotes = annotations
    .map((entry) => formatAssistantCitationForComposer(entry.citation, entry.citation.comment))
    .join("");
  return prompt.trim().length === 0 ? quotes.trimEnd() : `${quotes}${prompt}`;
}

function sourceFor(host: HTMLElement, citation: AssistantCitation): HTMLElement | null {
  return host.querySelector<HTMLElement>(
    `[data-assistant-citation-source="${CSS.escape(citation.messageId)}"]`,
  );
}

/**
 * "Add to chat" as Codex annotations: each quote is a numbered pin on the message text with a
 * comment pill, kept in the composer draft and sent ahead of the prompt.
 */
export function useChatAnnotations(target: ComposerThreadTarget) {
  const annotations = useComposerDraftStore(
    (store) => store.getComposerDraft(target)?.annotations ?? EMPTY,
  );
  const navigate = useNavigate();
  const rawEditing = useAnnotationEditingStore((store) => store.editing);
  const setEditing = useAnnotationEditingStore((store) => store.setEditing);
  const editing =
    rawEditing !== null && annotations.some((entry) => entry.id === rawEditing.id)
      ? rawEditing
      : null;

  const write = (next: ReadonlyArray<ComposerAnnotation>) =>
    useComposerDraftStore.getState().setAnnotations(target, next);
  const current = () =>
    useComposerDraftStore.getState().getComposerDraft(target)?.annotations ?? EMPTY;
  const remove = (id: string) => {
    write(current().filter((entry) => entry.id !== id));
    if (rawEditing?.id === id) setEditing(null);
  };
  const resolveRange = (id: string, host: HTMLElement) => {
    const entry = annotations.find((annotation) => annotation.id === id);
    const source = entry ? sourceFor(host, entry.citation) : null;
    return entry && source ? resolveAssistantCitationRange(source, entry.citation) : null;
  };

  const add = (citation: AssistantCitation): boolean => {
    const id = randomUUID();
    const { comment: _comment, ...quote } = citation;
    write([...current(), { id, citation: quote }]);
    setEditing({ id, isNew: true });
    return true;
  };

  const open = (id: string) => {
    const entry = annotations.find((annotation) => annotation.id === id);
    if (!entry) return;
    const range = findAssistantCitationSourceAnchor(document, entry.citation)?.range;
    if (range) {
      scrollAnnotationIntoView(range);
    } else {
      // Off screen in the virtualized list: let citation navigation bring it into view.
      void navigate(assistantCitationNavigation(entry.citation));
    }
    setEditing({ id, isNew: false });
  };

  const overlay = (viewport: HTMLElement | null) => {
    return (
      <AnnotationOverlay
        host={viewport}
        annotations={annotations.map((entry) => ({
          id: entry.id,
          comment: entry.citation.comment ?? "",
        }))}
        resolveRange={resolveRange}
        editing={editing}
        onEdit={(id) => setEditing({ id, isNew: false })}
        onSave={(id, comment) => {
          write(
            current().map((entry) => {
              if (entry.id !== id) return entry;
              const { comment: _previous, ...quote } = entry.citation;
              return { id, citation: comment ? { ...quote, comment } : quote };
            }),
          );
          setEditing(null);
        }}
        onCancel={(id, isNew) => (isNew ? remove(id) : setEditing(null))}
        onDelete={remove}
      />
    );
  };

  const chip = (
    <AnnotationsChip
      annotations={annotations
        .filter((entry) => !(editing?.isNew && editing.id === entry.id))
        .map((entry) => ({
          id: entry.id,
          quote: entry.citation.text,
          comment: entry.citation.comment ?? "",
        }))}
      noun="annotation"
      onOpen={open}
      onRemove={remove}
    />
  );

  return { annotations, add, overlay, chip };
}
