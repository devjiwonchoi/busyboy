import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AnnotationPill } from "./AnnotationPill";

/** One saved (or just added) annotation. Its text range is resolved by the owner. */
export interface AnnotationEntry {
  readonly id: string;
  readonly comment: string;
}

/** The annotation whose pill is open; `isNew` until its first save. */
export type AnnotationEditing = { readonly id: string; readonly isNew: boolean } | null;

const PIN_SIZE = 24;
const PILL_GAP = 6;
const EDGE = 8;
const PILL_WIDTH = 352;
const HIGHLIGHT_NAME = "t3-annotation";

interface Layout {
  readonly pins: ReadonlyArray<{ id: string; number: number; x: number; y: number }>;
  readonly pill: { x: number; y: number; width: number } | null;
}
const EMPTY_LAYOUT: Layout = { pins: [], pill: null };

let sharedHighlight: Highlight | null = null;
function annotationHighlight(): Highlight | null {
  if (typeof Highlight === "undefined" || typeof CSS === "undefined" || !CSS.highlights) {
    return null;
  }
  if (sharedHighlight === null || CSS.highlights.get(HIGHLIGHT_NAME) !== sharedHighlight) {
    sharedHighlight = CSS.highlights.get(HIGHLIGHT_NAME) ?? new Highlight();
    CSS.highlights.set(HIGHLIGHT_NAME, sharedHighlight);
  }
  return sharedHighlight;
}

/** Centers an annotation's text in its nearest scrolling box, without moving the page. */
export function scrollAnnotationIntoView(range: Range) {
  let box = range.startContainer.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) {
    box = box.parentElement;
  }
  if (!box) return;
  const offset =
    range.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 2;
  box.scrollBy({ top: offset, behavior: "smooth" });
}

/** The visible part of the host, in host coordinates: clipped by the window and the keyboard. */
function visibleBox(hostRect: DOMRect) {
  const view = window.visualViewport;
  const top = view?.offsetTop ?? 0;
  const left = view?.offsetLeft ?? 0;
  const height = view?.height ?? window.innerHeight;
  const width = view?.width ?? window.innerWidth;
  return {
    top: Math.max(hostRect.top, top) - hostRect.top,
    bottom: Math.min(hostRect.bottom, top + height) - hostRect.top,
    left: Math.max(hostRect.left, left) - hostRect.left,
    right: Math.min(hostRect.right, left + width) - hostRect.left,
  };
}

/**
 * Codex-style annotations over text inside `host` (a positioned, non-scrolling box): a
 * highlight on each annotated range, a numbered pin above it, and the comment pill for the
 * one being edited. The pill sits above its pin, below the text when there is no room, and
 * always inside the visible part of the host.
 */
export function AnnotationOverlay({
  host,
  annotations,
  resolveRange,
  editing,
  onEdit,
  onSave,
  onCancel,
  onDelete,
}: {
  host: HTMLElement | null;
  annotations: ReadonlyArray<AnnotationEntry>;
  /** The live range of an annotation's text inside `host`, or null while it is not rendered. */
  resolveRange: (id: string, host: HTMLElement) => Range | null;
  editing: AnnotationEditing;
  onEdit: (id: string) => void;
  onSave: (id: string, comment: string) => void;
  /** Esc or Cancel. A new annotation is dropped; a saved one keeps its comment. */
  onCancel: (id: string, isNew: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [layout, setLayout] = useState<Layout>(EMPTY_LAYOUT);
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ annotations, resolveRange, editing });
  const scheduleRef = useRef<() => void>(() => {});

  const editingEntry =
    editing === null ? null : (annotations.find((entry) => entry.id === editing.id) ?? null);
  const draftText =
    editing !== null && draft?.id === editing.id ? draft.text : (editingEntry?.comment ?? "");
  const save = () => {
    if (editing === null) return;
    onSave(editing.id, draftText.trim());
    setDraft(null);
  };
  const saveRef = useRef(save);

  useEffect(() => {
    if (!host) return;
    let frame: number | null = null;
    let owned: Range[] = [];
    const measure = () => {
      frame = null;
      const { annotations, resolveRange, editing } = latest.current;
      const highlight = annotationHighlight();
      for (const range of owned) highlight?.delete(range);
      owned = [];
      const hostRect = host.getBoundingClientRect();
      const box = visibleBox(hostRect);
      const pins: Array<{ id: string; number: number; x: number; y: number }> = [];
      let pill: Layout["pill"] = null;
      annotations.forEach((entry, index) => {
        const range = resolveRange(entry.id, host);
        if (!range) return;
        const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0);
        const first = rects[0];
        const last = rects.at(-1);
        if (!first || !last) return;
        highlight?.add(range);
        owned.push(range);
        const x = Math.max(box.left + 2, first.right - hostRect.left - PIN_SIZE);
        const y = first.top - hostRect.top - PIN_SIZE - 2;
        if (y + PIN_SIZE >= box.top && y <= box.bottom) {
          pins.push({ id: entry.id, number: index + 1, x, y });
        }
        if (editing?.id !== entry.id) return;
        const width = Math.max(0, Math.min(PILL_WIDTH, box.right - box.left - 2 * EDGE));
        const height = pillRef.current?.offsetHeight ?? 44;
        const pillX = Math.max(
          box.left + EDGE,
          Math.min(x + PIN_SIZE / 2 - width / 2, box.right - width - EDGE),
        );
        let pillY = y - height - PILL_GAP;
        if (pillY < box.top + EDGE) pillY = last.bottom - hostRect.top + PILL_GAP;
        pillY = Math.max(box.top + EDGE, Math.min(pillY, box.bottom - height - EDGE));
        pill = { x: pillX, y: pillY, width };
      });
      const next: Layout = { pins, pill };
      setLayout((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };
    scheduleRef.current = schedule;
    const observer = new MutationObserver((records) => {
      const layer = layerRef.current;
      if (records.every((record) => layer?.contains(record.target))) return;
      schedule();
    });
    observer.observe(host, { childList: true, subtree: true, characterData: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(host);
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    schedule();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
      const highlight = annotationHighlight();
      for (const range of owned) highlight?.delete(range);
      scheduleRef.current = () => {};
    };
  }, [host]);

  // Re-measure whenever the annotations or the open pill change (and once the pill has a size).
  useLayoutEffect(() => {
    latest.current = { annotations, resolveRange, editing };
    saveRef.current = save;
    scheduleRef.current();
  });

  // A press anywhere outside the open pill saves it, like Codex.
  const editingId = editing?.id ?? null;
  useEffect(() => {
    if (editingId === null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (pillRef.current?.contains(event.target as Node)) return;
      saveRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [editingId]);

  if (!host) return null;
  return createPortal(
    <div
      ref={layerRef}
      data-annotation-layer
      className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
    >
      {layout.pins.map((pin) => (
        <button
          key={pin.id}
          type="button"
          data-annotation-pin={pin.number}
          aria-label={`Annotation ${pin.number}`}
          className="pointer-events-auto absolute flex size-6 items-center justify-center rounded-full rounded-bl-none bg-blue-500 font-semibold text-white text-xs shadow-md ring-2 ring-white outline-none focus-visible:ring-foreground dark:ring-white/90"
          style={{ left: pin.x, top: pin.y }}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onEdit(pin.id)}
        >
          {pin.number}
        </button>
      ))}
      {editing !== null && editingEntry !== null ? (
        <div
          ref={pillRef}
          className="pointer-events-auto absolute"
          style={
            layout.pill
              ? { left: layout.pill.x, top: layout.pill.y, width: layout.pill.width }
              : { visibility: "hidden", width: PILL_WIDTH }
          }
        >
          <AnnotationPill
            key={editing.id}
            placed={layout.pill !== null}
            isNew={editing.isNew}
            draft={draftText}
            onDraftChange={(text) => setDraft({ id: editing.id, text })}
            onSave={save}
            onCancel={() => {
              setDraft(null);
              onCancel(editing.id, editing.isNew);
            }}
            onDelete={() => {
              setDraft(null);
              onDelete(editing.id);
            }}
          />
        </div>
      ) : null}
    </div>,
    host,
  );
}
