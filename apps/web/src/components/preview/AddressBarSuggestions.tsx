import type { BrowsingHistorySuggestion } from "@t3tools/contracts";
import { History } from "lucide-react";

import { cn } from "~/lib/utils";

export const ADDRESS_BAR_SUGGESTIONS_ID = "preview-address-suggestions";

export const addressBarSuggestionId = (index: number) => `${ADDRESS_BAR_SUGGESTIONS_ID}-${index}`;

const displayUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

export function AddressBarSuggestions({
  suggestions,
  activeIndex,
  onChoose,
}: {
  readonly suggestions: ReadonlyArray<BrowsingHistorySuggestion>;
  readonly activeIndex: number;
  readonly onChoose: (url: string) => void;
}) {
  return (
    <ul
      id={ADDRESS_BAR_SUGGESTIONS_ID}
      role="listbox"
      aria-label="Visited pages"
      className="absolute top-full right-0 left-0 z-50 mt-1 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
    >
      {suggestions.map((suggestion, index) => (
        <li
          key={suggestion.url}
          id={addressBarSuggestionId(index)}
          role="option"
          aria-selected={index === activeIndex}
          className={cn(
            "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm",
            index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
          )}
          // Mouse down, not click: choosing must happen before the input blurs
          // and closes the list.
          onMouseDown={(event) => {
            event.preventDefault();
            onChoose(suggestion.url);
          }}
        >
          <History className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">
            {suggestion.title === suggestion.url ? displayUrl(suggestion.url) : suggestion.title}
          </span>
          {suggestion.title === suggestion.url ? null : (
            <span className="min-w-0 shrink truncate text-muted-foreground text-xs">
              {displayUrl(suggestion.url)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
