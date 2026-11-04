import { Globe, Search, X } from "lucide-react";
import { type CSSProperties, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useCachedFaviconForUrl } from "~/browserFaviconStore";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";

import type { AddressBarRow } from "./addressBarSuggestions.logic";
import { FaviconImage } from "./PreviewFaviconIcon";

export function addressBarOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`;
}

function useAnchorStyle(anchor: HTMLElement | null): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const measure = () => {
      const rect = anchor.getBoundingClientRect();
      setStyle({ left: rect.left, top: rect.bottom + 4, width: rect.width });
    };
    measure();
    window.addEventListener("resize", measure);
    const stopObserving = observeResize(anchor, measure);
    return () => {
      window.removeEventListener("resize", measure);
      stopObserving();
    };
  }, [anchor]);
  return style;
}

/**
 * The address bar's suggestion dropdown. Focus stays in the address bar: the
 * list is a listbox the input points at with `aria-activedescendant`. It is
 * portaled above the page so the in-app browser's webview never covers it.
 */
export function AddressBarSuggestionList(props: {
  readonly id: string;
  readonly anchor: HTMLElement | null;
  readonly rows: ReadonlyArray<AddressBarRow>;
  readonly selectedIndex: number;
  readonly onAccept: (row: AddressBarRow) => void;
  readonly onRemove: (row: AddressBarRow) => void;
}) {
  const style = useAnchorStyle(props.anchor);
  if (!style || props.rows.length === 0) return null;
  return createPortal(
    <div
      id={props.id}
      role="listbox"
      aria-label="Address bar suggestions"
      style={style}
      // Keep focus (and the caret) in the address bar while clicking a row.
      onMouseDown={(event) => event.preventDefault()}
      className="dropdown-glass fixed z-[130] flex flex-col overflow-hidden rounded-lg p-1 shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] [-webkit-app-region:no-drag] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]"
      data-address-bar-suggestions
    >
      {props.rows.map((row, index) => (
        <SuggestionOption
          key={row.id}
          id={addressBarOptionId(props.id, index)}
          row={row}
          selected={index === props.selectedIndex}
          onAccept={() => props.onAccept(row)}
          onRemove={() => props.onRemove(row)}
        />
      ))}
    </div>,
    document.body,
  );
}

function SuggestionOption(props: {
  readonly id: string;
  readonly row: AddressBarRow;
  readonly selected: boolean;
  readonly onAccept: () => void;
  readonly onRemove: () => void;
}) {
  const { row } = props;
  return (
    <div
      id={props.id}
      role="option"
      aria-selected={props.selected}
      onClick={props.onAccept}
      data-kind={row.kind}
      className={cn(
        "group/option flex min-h-7 cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1 text-sm text-foreground hover:bg-accent/60",
        props.selected && "bg-accent text-accent-foreground hover:bg-accent",
      )}
    >
      <SuggestionContent row={row} />
      {row.kind === "history" ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Remove ${row.url} from history`}
          title="Remove from history"
          onClick={(event) => {
            event.stopPropagation();
            props.onRemove();
          }}
          className="ms-auto flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-foreground/10 hover:text-foreground group-hover/option:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

const ROW_ICON_CLASS = "size-4 shrink-0 text-muted-foreground";

function SuggestionContent({ row }: { readonly row: AddressBarRow }) {
  switch (row.kind) {
    case "go":
      return (
        <>
          <RowFavicon url={row.url} />
          <span className="min-w-0 truncate">
            <span className="text-muted-foreground">Go to </span>
            {row.url}
          </span>
        </>
      );
    case "search":
      return (
        <>
          <Search className={ROW_ICON_CLASS} aria-hidden />
          <span className="min-w-0 truncate">
            Search {row.engineName} for “{row.text}”
          </span>
        </>
      );
    case "remote":
      return (
        <>
          <Search className={ROW_ICON_CLASS} aria-hidden />
          <span className="min-w-0 truncate">{row.text}</span>
        </>
      );
    case "history":
      return (
        <>
          <RowFavicon url={row.url} />
          <span className="flex min-w-0 items-baseline gap-2">
            {row.title ? <span className="min-w-0 shrink truncate">{row.title}</span> : null}
            <span
              className={cn(
                "min-w-0 truncate",
                row.title ? "shrink-[2] text-xs text-muted-foreground" : null,
              )}
            >
              {row.url}
            </span>
          </span>
        </>
      );
  }
}

/** Favicons come only from what the browser already cached; nothing is fetched. */
function RowFavicon({ url }: { readonly url: string }) {
  const favicon = useCachedFaviconForUrl(url);
  return (
    <FaviconImage
      sources={[favicon]}
      fallback={<Globe className={ROW_ICON_CLASS} aria-hidden />}
      className="size-4 shrink-0 rounded-sm object-contain"
    />
  );
}
