import {
  ADDRESS_BAR_REMOTE_SUGGESTIONS_MAX,
  type BrowserHistoryNavigationHint,
  type BrowserHistorySuggestion,
  type BrowserHistorySuggestResult,
} from "@t3tools/contracts";
import {
  inlineCompletionFor,
  type InlineCompletion,
  type InlineCompletionCandidate,
} from "@t3tools/shared/addressBarCompletion";
import {
  type AddressBarSearchOptions,
  classifyAddressBarInput,
  resolveSearchEngine,
  searchUrlFor,
} from "@t3tools/shared/preview";

/** The dropdown never shows more rows than this while typing. */
export const ADDRESS_BAR_MAX_ROWS = 8;
/** Frequent sites shown when the address bar is focused but nothing is typed yet. */
export const ADDRESS_BAR_FREQUENT_LIMIT = 6;
/** History matches requested per keystroke; extra rows cover de-duplication. */
export const ADDRESS_BAR_SUGGEST_LIMIT = ADDRESS_BAR_MAX_ROWS;
/**
 * With search suggestions on, history leaves this many rows free so the
 * engine's suggestions have room without pushing history rows around later.
 */
const REMOTE_RESERVED_ROWS = 2;

/** What accepting a row does. */
export type AddressBarAction =
  /** Navigate to what the user typed; the view resolves it with the chosen engine. */
  | { readonly type: "submit"; readonly text: string }
  | {
      readonly type: "navigate";
      readonly url: string;
      readonly transition: BrowserHistoryNavigationHint;
    };

export type AddressBarRow =
  | {
      /** "Go to <url>": the typed URL, or the inline completion. */
      readonly kind: "go";
      readonly id: string;
      readonly url: string;
      readonly display: string;
      readonly action: AddressBarAction;
    }
  | {
      readonly kind: "search";
      readonly id: string;
      readonly text: string;
      readonly engineName: string;
      readonly display: string;
      readonly action: AddressBarAction;
    }
  | {
      readonly kind: "history";
      readonly id: string;
      readonly url: string;
      readonly title: string | null;
      readonly display: string;
      readonly action: AddressBarAction;
    }
  | {
      readonly kind: "remote";
      readonly id: string;
      readonly text: string;
      readonly display: string;
      readonly action: AddressBarAction;
    };

/** Suggestion data as it arrives from the desktop bridge. */
export interface AddressBarSuggestionData {
  /** The input the history matches were fetched for. */
  readonly matchesFor: string;
  readonly matches: ReadonlyArray<BrowserHistorySuggestion>;
  readonly topOrigin: BrowserHistorySuggestResult["topOrigin"];
  /** The input the search suggestions were fetched for. */
  readonly remoteFor: string;
  readonly remote: ReadonlyArray<string>;
  readonly frequent: ReadonlyArray<BrowserHistorySuggestion>;
}

export const EMPTY_ADDRESS_BAR_SUGGESTION_DATA: AddressBarSuggestionData = {
  matchesFor: "",
  matches: [],
  topOrigin: null,
  remoteFor: "",
  remote: [],
  frequent: [],
};

export type AddressBarMode = "zero" | "typing";

/** Zero state until the user edits the text into something non-empty. */
export function addressBarMode(input: {
  readonly typed: string;
  readonly edited: boolean;
}): AddressBarMode {
  return input.edited && input.typed.trim().length > 0 ? "typing" : "zero";
}

/**
 * Where the highlight sits before the user presses an arrow key. While typing,
 * the first row (what you typed, or the completion) is the default action; in
 * the zero state nothing is highlighted and Enter keeps the current page.
 */
export function defaultSelectionIndex(mode: AddressBarMode): number {
  return mode === "typing" ? 0 : -1;
}

export function completionCandidate(
  data: Pick<AddressBarSuggestionData, "matches" | "topOrigin">,
): InlineCompletionCandidate | null {
  const top = data.matches[0];
  return top ? { url: top.url, origin: data.topOrigin } : null;
}

/**
 * The inline completion to show. Only history completes inline (never search
 * suggestions), and a deletion suppresses it until the next typed character.
 */
export function addressBarCompletion(input: {
  readonly typed: string;
  readonly data: Pick<AddressBarSuggestionData, "matches" | "topOrigin">;
  readonly caretAtEnd: boolean;
  readonly suppressed: boolean;
}): InlineCompletion | null {
  if (input.suppressed) return null;
  return inlineCompletionFor(input.typed, completionCandidate(input.data), {
    caretAtEnd: input.caretAtEnd,
  });
}

/**
 * Whether an edit should suppress inline completion: any deletion does, any
 * insertion (typing or paste) lifts it.
 */
export function suppressesCompletion(inputType: string | undefined): boolean {
  return inputType?.startsWith("delete") ?? false;
}

function searchTerms(text: string): ReadonlyArray<string> {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

/** URL or title contains every whitespace-separated term, ignoring case. */
export function historyMatchesTerms(match: BrowserHistorySuggestion, text: string): boolean {
  const haystack = `${match.url}\n${match.title ?? ""}`.toLowerCase();
  return searchTerms(text).every((term) => haystack.includes(term));
}

function historyRow(match: BrowserHistorySuggestion, idPrefix = "history"): AddressBarRow {
  return {
    kind: "history",
    id: `${idPrefix}:${match.url}`,
    url: match.url,
    title: match.title,
    display: match.url,
    action: { type: "navigate", url: match.url, transition: "suggestion" },
  };
}

export function buildZeroStateRows(
  frequent: ReadonlyArray<BrowserHistorySuggestion>,
  removedUrls: ReadonlySet<string> = new Set(),
): ReadonlyArray<AddressBarRow> {
  return frequent
    .filter((entry) => !removedUrls.has(entry.url))
    .slice(0, ADDRESS_BAR_FREQUENT_LIMIT)
    .map((entry) => historyRow(entry, "frequent"));
}

export interface AddressBarTypingRowsInput {
  readonly typed: string;
  readonly completion: InlineCompletion | null;
  readonly data: AddressBarSuggestionData;
  readonly remoteEnabled: boolean;
  readonly search: AddressBarSearchOptions;
  readonly removedUrls?: ReadonlySet<string> | undefined;
}

/**
 * Rows while typing, in order: what you typed (or the inline completion),
 * history matches, search suggestions, then a closing search row unless the
 * first row already searches.
 */
export function buildTypingRows(input: AddressBarTypingRowsInput): ReadonlyArray<AddressBarRow> {
  const text = input.typed.trim();
  if (text.length === 0) return [];
  const removed = input.removedUrls ?? new Set<string>();
  const engine = resolveSearchEngine(input.search);
  const searchRow: AddressBarRow = {
    kind: "search",
    id: "search",
    text,
    engineName: engine.name,
    display: text,
    action: { type: "navigate", url: searchUrlFor(text, input.search), transition: "typed" },
  };

  let typedTarget: ReturnType<typeof classifyAddressBarInput> | null = null;
  try {
    typedTarget = classifyAddressBarInput(text);
  } catch {
    // An unsupported scheme cannot be opened; searching for it still can.
  }

  const rows: AddressBarRow[] = [];
  if (input.completion) {
    rows.push({
      kind: "go",
      id: "completion",
      url: input.completion.url,
      display: input.typed + input.completion.suffix,
      action: { type: "navigate", url: input.completion.url, transition: "suggestion" },
    });
  } else if (typedTarget?.kind === "url") {
    rows.push({
      kind: "go",
      id: "typed",
      url: typedTarget.url,
      display: input.typed,
      action: { type: "submit", text },
    });
  } else {
    rows.push(searchRow);
  }

  const closesWithSearch = rows[0]!.kind !== "search";
  const middleRows = ADDRESS_BAR_MAX_ROWS - rows.length - (closesWithSearch ? 1 : 0);
  const historyLimit = input.remoteEnabled ? middleRows - REMOTE_RESERVED_ROWS : middleRows;

  const seenUrls = new Set(rows.flatMap((row) => (row.kind === "go" ? [row.url] : [])));
  // Matches for an older input stay on screen, narrowed to the new text, until
  // fresh ones arrive.
  const stale = input.data.matchesFor !== text;
  for (const match of input.data.matches) {
    if (rows.length - 1 >= historyLimit) break;
    if (seenUrls.has(match.url) || removed.has(match.url)) continue;
    if (stale && !historyMatchesTerms(match, text)) continue;
    seenUrls.add(match.url);
    rows.push(historyRow(match));
  }

  if (input.remoteEnabled) {
    const remoteLimit = Math.min(
      ADDRESS_BAR_REMOTE_SUGGESTIONS_MAX,
      ADDRESS_BAR_MAX_ROWS - rows.length - (closesWithSearch ? 1 : 0),
    );
    const lowerText = text.toLowerCase();
    const remoteStale = input.data.remoteFor !== text;
    const seenText = new Set([lowerText]);
    let added = 0;
    for (const suggestion of input.data.remote) {
      if (added >= remoteLimit) break;
      const trimmed = suggestion.trim();
      const lower = trimmed.toLowerCase();
      if (trimmed.length === 0 || seenText.has(lower)) continue;
      if (remoteStale && !lower.startsWith(lowerText)) continue;
      seenText.add(lower);
      added += 1;
      rows.push({
        kind: "remote",
        id: `remote:${lower}`,
        text: trimmed,
        display: trimmed,
        action: { type: "navigate", url: searchUrlFor(trimmed, input.search), transition: "typed" },
      });
    }
  }

  if (closesWithSearch) rows.push(searchRow);
  return rows;
}

/**
 * The next highlighted row for ↑/↓, wrapping. In the zero state the cycle
 * includes "nothing highlighted" (-1), which shows the current page URL.
 */
export function moveSelection(input: {
  readonly index: number;
  readonly delta: 1 | -1;
  readonly rowCount: number;
  readonly defaultIndex: number;
}): number {
  const { rowCount, defaultIndex } = input;
  if (rowCount === 0) return defaultIndex;
  const first = Math.min(defaultIndex, 0);
  const span = rowCount - first;
  const current = Math.min(Math.max(input.index, first), rowCount - 1);
  return ((((current - first + input.delta) % span) + span) % span) + first;
}

/** The text in the input: the highlighted row's URL or text, or what was typed. */
export function addressBarDisplayValue(input: {
  readonly typed: string;
  readonly completion: InlineCompletion | null;
  readonly rows: ReadonlyArray<AddressBarRow>;
  readonly selectedIndex: number;
  readonly defaultIndex: number;
}): string {
  const row = input.rows[input.selectedIndex];
  if (input.selectedIndex === input.defaultIndex || !row) {
    return input.typed + (input.completion?.suffix ?? "");
  }
  return row.display;
}

export type AddressBarEscapeAction =
  /** Put back what was typed after arrowing through rows. */
  | "restore-typed"
  /** Close the dropdown (and drop the inline completion). */
  | "close"
  /** Put back the current page URL. */
  | "revert"
  /** Nothing left to undo: leave the address bar. */
  | "blur";

export function addressBarEscapeAction(input: {
  readonly open: boolean;
  readonly selectionMoved: boolean;
  readonly edited: boolean;
}): AddressBarEscapeAction {
  if (input.open && input.selectionMoved) return "restore-typed";
  if (input.open) return "close";
  if (input.edited) return "revert";
  return "blur";
}

/** Shift+Delete, or Shift+Backspace (the Mac keyboard's Fn+Delete stand-in). */
export function isRemoveSuggestionShortcut(event: {
  readonly key: string;
  readonly shiftKey: boolean;
}): boolean {
  return event.shiftKey && (event.key === "Delete" || event.key === "Backspace");
}

/**
 * Whether new rows can replace the current ones without moving anything at or
 * above the keyboard selection. Late results (remote suggestions especially)
 * wait while they would shift the highlighted row.
 */
export function canReplaceRows(input: {
  readonly current: ReadonlyArray<AddressBarRow>;
  readonly next: ReadonlyArray<AddressBarRow>;
  readonly selectedIndex: number;
  readonly defaultIndex: number;
}): boolean {
  if (input.selectedIndex <= input.defaultIndex || input.selectedIndex < 0) return true;
  for (let index = 0; index <= input.selectedIndex; index += 1) {
    if (input.current[index]?.id !== input.next[index]?.id) return false;
  }
  return true;
}
