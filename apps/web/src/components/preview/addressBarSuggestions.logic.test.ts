import { describe, expect, it } from "vite-plus/test";

import {
  type AddressBarSuggestionData,
  addressBarCompletion,
  addressBarDisplayValue,
  addressBarEscapeAction,
  addressBarMode,
  buildTypingRows,
  buildZeroStateRows,
  canReplaceRows,
  defaultSelectionIndex,
  EMPTY_ADDRESS_BAR_SUGGESTION_DATA,
  isRemoveSuggestionShortcut,
  moveSelection,
  suppressesCompletion,
} from "./addressBarSuggestions.logic";

const DDG = { engine: "duckduckgo" } as const;

function data(overrides: Partial<AddressBarSuggestionData>): AddressBarSuggestionData {
  return { ...EMPTY_ADDRESS_BAR_SUGGESTION_DATA, ...overrides };
}

function rowsFor(
  typed: string,
  overrides: Partial<AddressBarSuggestionData> = {},
  options: { remoteEnabled?: boolean; caretAtEnd?: boolean; suppressed?: boolean } = {},
) {
  const suggestionData = data({ matchesFor: typed.trim(), ...overrides });
  const completion = addressBarCompletion({
    typed,
    data: suggestionData,
    caretAtEnd: options.caretAtEnd ?? true,
    suppressed: options.suppressed ?? false,
  });
  return {
    completion,
    rows: buildTypingRows({
      typed,
      completion,
      data: suggestionData,
      remoteEnabled: options.remoteEnabled ?? false,
      search: DDG,
    }),
  };
}

const GITHUB = { url: "https://github.com/t3tools/busyboy", title: "BusyBoy" };

describe("address bar mode", () => {
  it("stays in the zero state until the text is edited into something", () => {
    expect(addressBarMode({ typed: "https://example.com/", edited: false })).toBe("zero");
    expect(addressBarMode({ typed: "  ", edited: true })).toBe("zero");
    expect(addressBarMode({ typed: "ex", edited: true })).toBe("typing");
    expect(defaultSelectionIndex("zero")).toBe(-1);
    expect(defaultSelectionIndex("typing")).toBe(0);
  });
});

describe("buildTypingRows", () => {
  it("leads with Go to for URL-like input and ends with a search row", () => {
    const { rows } = rowsFor("example.com/docs", {
      matches: [{ url: "https://example.org/docs", title: "Docs" }],
    });
    expect(rows.map((row) => row.kind)).toEqual(["go", "history", "search"]);
    expect(rows[0]).toMatchObject({
      url: "https://example.com/docs",
      action: { type: "submit", text: "example.com/docs" },
    });
    expect(rows[2]).toMatchObject({
      engineName: "DuckDuckGo",
      action: {
        type: "navigate",
        url: "https://duckduckgo.com/?q=example.com%2Fdocs",
        transition: "typed",
      },
    });
  });

  it("leads with the search row for plain text and does not repeat it", () => {
    const { rows } = rowsFor("cat videos", {}, {});
    expect(rows.map((row) => row.kind)).toEqual(["search"]);
    expect(rows[0]).toMatchObject({ text: "cat videos", engineName: "DuckDuckGo" });
  });

  it("labels the search row with the chosen engine", () => {
    const rows = buildTypingRows({
      typed: "cats",
      completion: null,
      data: EMPTY_ADDRESS_BAR_SUGGESTION_DATA,
      remoteEnabled: false,
      search: { engine: "brave" },
    });
    expect(rows[0]).toMatchObject({
      engineName: "Brave",
      action: { url: "https://search.brave.com/search?q=cats" },
    });
  });

  it("searches for input with a scheme that cannot be opened", () => {
    const { rows } = rowsFor("mailto:me");
    expect(rows.map((row) => row.kind)).toEqual(["search"]);
  });

  it("puts history before search suggestions and caps rows at 8", () => {
    const matches = Array.from({ length: 10 }, (_, index) => ({
      url: `https://example.com/docs-${index}`,
      title: `docs ${index}`,
    }));
    const { rows } = rowsFor(
      "docs",
      { matches, remoteFor: "docs", remote: ["docs a", "docs b", "docs c", "docs d", "docs e"] },
      { remoteEnabled: true },
    );
    expect(rows).toHaveLength(8);
    expect(rows.map((row) => row.kind)).toEqual([
      "search",
      "history",
      "history",
      "history",
      "history",
      "history",
      "remote",
      "remote",
    ]);
  });

  it("allows at most four search suggestions and drops one equal to the text", () => {
    const { rows } = rowsFor(
      "example.com",
      { remoteFor: "example.com", remote: ["Example.com", "a", "b", "c", "d", "e"] },
      { remoteEnabled: true },
    );
    expect(rows.filter((row) => row.kind === "remote").map((row) => row.display)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(rows.at(-1)?.kind).toBe("search");
  });

  it("ignores search suggestions while they are off", () => {
    const { rows } = rowsFor("docs", { remoteFor: "docs", remote: ["docs a"] });
    expect(rows.some((row) => row.kind === "remote")).toBe(false);
  });

  it("narrows stale history and suggestions to the new text until fresh ones arrive", () => {
    const { rows } = rowsFor(
      "git hub",
      {
        matchesFor: "gi",
        matches: [GITHUB, { url: "https://gitlab.com/", title: "GitLab" }],
        remoteFor: "gi",
        remote: ["git hub desktop", "gif"],
      },
      { remoteEnabled: true },
    );
    expect(rows.filter((row) => row.kind === "history").map((row) => row.display)).toEqual([
      GITHUB.url,
    ]);
    expect(rows.filter((row) => row.kind === "remote").map((row) => row.display)).toEqual([
      "git hub desktop",
    ]);
  });

  it("navigates history rows as accepted suggestions and skips removed ones", () => {
    const rows = buildTypingRows({
      typed: "busy",
      completion: null,
      data: data({
        matchesFor: "busy",
        matches: [GITHUB, { url: "https://busy.example/", title: null }],
      }),
      remoteEnabled: false,
      search: DDG,
      removedUrls: new Set(["https://busy.example/"]),
    });
    const history = rows.filter((row) => row.kind === "history");
    expect(history).toHaveLength(1);
    expect(history[0]!.action).toEqual({
      type: "navigate",
      url: GITHUB.url,
      transition: "suggestion",
    });
  });
});

describe("inline completion", () => {
  const github = { matches: [GITHUB], topOrigin: { url: "https://github.com/", visitCount: 5 } };

  it("completes to a well-visited origin and makes it the first row", () => {
    const { completion, rows } = rowsFor("git", github);
    expect(completion).toEqual({ url: "https://github.com/", suffix: "hub.com/" });
    expect(rows[0]).toMatchObject({
      kind: "go",
      display: "github.com/",
      action: { type: "navigate", url: "https://github.com/", transition: "suggestion" },
    });
    expect(rows.at(-1)).toMatchObject({ kind: "search", text: "git" });
  });

  it("completes to the full URL when the origin is rarely visited", () => {
    const { completion } = rowsFor("git", {
      matches: [GITHUB],
      topOrigin: { url: "https://github.com/", visitCount: 1 },
    });
    expect(completion?.url).toBe(GITHUB.url);
  });

  it("is suppressed after a deletion and returns with the next character", () => {
    expect(rowsFor("git", github, { suppressed: true }).completion).toBeNull();
    expect(suppressesCompletion("deleteContentBackward")).toBe(true);
    expect(suppressesCompletion("deleteContentForward")).toBe(true);
    expect(suppressesCompletion("insertText")).toBe(false);
    expect(suppressesCompletion("insertFromPaste")).toBe(false);
    expect(rowsFor("gith", github).completion?.suffix).toBe("ub.com/");
  });

  it("never completes with the caret in the middle or from one character", () => {
    expect(rowsFor("git", github, { caretAtEnd: false }).completion).toBeNull();
    expect(rowsFor("g", github).completion).toBeNull();
  });

  it("never completes into a search suggestion", () => {
    const { completion } = rowsFor(
      "git",
      { remoteFor: "git", remote: ["github copilot"] },
      { remoteEnabled: true },
    );
    expect(completion).toBeNull();
  });

  it("shows the completed text in the input until a row is highlighted", () => {
    const { completion, rows } = rowsFor("git", github);
    const display = (selectedIndex: number) =>
      addressBarDisplayValue({ typed: "git", completion, rows, selectedIndex, defaultIndex: 0 });
    expect(display(0)).toBe("github.com/");
    expect(display(1)).toBe(GITHUB.url);
    expect(display(2)).toBe("git");
  });
});

describe("zero state", () => {
  it("lists up to six frequent sites as removable history rows", () => {
    const frequent = Array.from({ length: 8 }, (_, index) => ({
      url: `https://site-${index}.example/`,
      title: null,
    }));
    const rows = buildZeroStateRows(frequent, new Set(["https://site-0.example/"]));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ kind: "history", url: "https://site-1.example/" });
  });
});

describe("moveSelection", () => {
  it("wraps through the rows while typing", () => {
    const move = (index: number, delta: 1 | -1) =>
      moveSelection({ index, delta, rowCount: 3, defaultIndex: 0 });
    expect(move(0, 1)).toBe(1);
    expect(move(2, 1)).toBe(0);
    expect(move(0, -1)).toBe(2);
  });

  it("includes the unhighlighted current page in the zero state", () => {
    const move = (index: number, delta: 1 | -1) =>
      moveSelection({ index, delta, rowCount: 2, defaultIndex: -1 });
    expect(move(-1, 1)).toBe(0);
    expect(move(1, 1)).toBe(-1);
    expect(move(-1, -1)).toBe(1);
  });
});

describe("escape", () => {
  it("restores the typed text, then closes, then reverts, then leaves", () => {
    expect(addressBarEscapeAction({ open: true, selectionMoved: true, edited: true })).toBe(
      "restore-typed",
    );
    expect(addressBarEscapeAction({ open: true, selectionMoved: false, edited: true })).toBe(
      "close",
    );
    expect(addressBarEscapeAction({ open: false, selectionMoved: false, edited: true })).toBe(
      "revert",
    );
    expect(addressBarEscapeAction({ open: false, selectionMoved: false, edited: false })).toBe(
      "blur",
    );
  });
});

describe("removing a suggestion", () => {
  it("uses Shift+Delete or Shift+Backspace", () => {
    expect(isRemoveSuggestionShortcut({ key: "Delete", shiftKey: true })).toBe(true);
    expect(isRemoveSuggestionShortcut({ key: "Backspace", shiftKey: true })).toBe(true);
    expect(isRemoveSuggestionShortcut({ key: "Backspace", shiftKey: false })).toBe(false);
    expect(isRemoveSuggestionShortcut({ key: "Delete", shiftKey: false })).toBe(false);
  });
});

describe("canReplaceRows", () => {
  const before = rowsFor(
    "docs",
    { matches: [{ url: "https://example.com/docs", title: null }] },
    {
      remoteEnabled: true,
    },
  ).rows;
  const after = rowsFor(
    "docs",
    {
      matches: [{ url: "https://example.com/docs", title: null }],
      remoteFor: "docs",
      remote: ["docs a"],
    },
    { remoteEnabled: true },
  ).rows;

  it("merges late search suggestions below a highlighted history row", () => {
    expect(before.map((row) => row.kind)).toEqual(["search", "history"]);
    expect(
      canReplaceRows({ current: before, next: after, selectedIndex: 1, defaultIndex: 0 }),
    ).toBe(true);
  });

  it("holds results that would move the highlighted row", () => {
    const reordered = [after[0]!, after[2]!, after[1]!];
    expect(
      canReplaceRows({ current: after, next: reordered, selectedIndex: 1, defaultIndex: 0 }),
    ).toBe(false);
  });

  it("always applies while nothing is highlighted", () => {
    expect(canReplaceRows({ current: after, next: [], selectedIndex: 0, defaultIndex: 0 })).toBe(
      true,
    );
  });
});
