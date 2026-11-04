import * as Schema from "effect/Schema";
import { EnvironmentId } from "./baseSchemas.ts";
import { BrowserProfileId } from "./browserProfile.ts";

export const BROWSER_HISTORY_MAX_URL_LENGTH = 2048;
export const BROWSER_HISTORY_MAX_TITLE_LENGTH = 512;
export const BROWSER_HISTORY_RETENTION_DAYS = 90;
export const BROWSER_HISTORY_SEARCH_MAX_LIMIT = 200;
export const BROWSER_HISTORY_RECENT_MAX_LIMIT = 50;
export const BROWSER_HISTORY_LEGACY_IMPORT_MAX_ENTRIES = 2_000;

/** How the user (or an agent) reached a page. Mirrors the usual browser transition kinds. */
export const BrowserHistoryTransition = Schema.Literals([
  "typed",
  "link",
  "reload",
  "back_forward",
  "redirect",
  "suggestion",
  "agent",
  "other",
]);
export type BrowserHistoryTransition = typeof BrowserHistoryTransition.Type;

/** Hints the renderer may attach to a navigation it starts. Main infers everything else. */
export const BrowserHistoryNavigationHint = Schema.Literals(["typed", "suggestion", "link"]);
export type BrowserHistoryNavigationHint = typeof BrowserHistoryNavigationHint.Type;

export const BrowserHistorySource = Schema.Literals(["user", "agent"]);
export type BrowserHistorySource = typeof BrowserHistorySource.Type;

export const BrowserHistorySourceFilter = Schema.Literals(["all", "user", "agent"]);
export type BrowserHistorySourceFilter = typeof BrowserHistorySourceFilter.Type;

export const BrowserHistoryClearRange = Schema.Literals([
  "hour",
  "day",
  "week",
  "four_weeks",
  "all",
]);
export type BrowserHistoryClearRange = typeof BrowserHistoryClearRange.Type;

/**
 * There is no downloads list in the in-app browser yet, so "downloads" is not
 * offered. Saved passwords are never cleared from here.
 */
export const BrowserHistoryClearDataType = Schema.Literals([
  "history",
  "cookies_site_data",
  "cache",
]);
export type BrowserHistoryClearDataType = typeof BrowserHistoryClearDataType.Type;

const Url = Schema.String.check(Schema.isMaxLength(BROWSER_HISTORY_MAX_URL_LENGTH));
const Timestamp = Schema.Number.check(Schema.isFinite());
const Limit = (max: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: max }));

export const BrowserHistoryVisit = Schema.Struct({
  id: Schema.Int,
  url: Schema.String,
  title: Schema.NullOr(Schema.String),
  visitedAt: Schema.Number,
  transition: BrowserHistoryTransition,
  source: BrowserHistorySource,
  threadId: Schema.NullOr(Schema.String),
});
export type BrowserHistoryVisit = typeof BrowserHistoryVisit.Type;

export const BrowserHistoryCursor = Schema.Struct({
  visitedAt: Timestamp,
  id: Schema.Int,
});
export type BrowserHistoryCursor = typeof BrowserHistoryCursor.Type;

export const BrowserHistorySearchInput = Schema.Struct({
  profileId: BrowserProfileId,
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  source: Schema.optional(BrowserHistorySourceFilter),
  /** Return visits strictly older than this cursor (newest-first pagination). */
  before: Schema.optional(BrowserHistoryCursor),
  limit: Limit(BROWSER_HISTORY_SEARCH_MAX_LIMIT),
});
export type BrowserHistorySearchInput = typeof BrowserHistorySearchInput.Type;

export const BrowserHistorySearchResult = Schema.Struct({
  visits: Schema.Array(BrowserHistoryVisit),
  /** Pass back as `before` to fetch the next page; null at the end. */
  nextCursor: Schema.NullOr(BrowserHistoryCursor),
});
export type BrowserHistorySearchResult = typeof BrowserHistorySearchResult.Type;

export const BrowserHistoryRecentInput = Schema.Struct({
  profileId: BrowserProfileId,
  limit: Limit(BROWSER_HISTORY_RECENT_MAX_LIMIT),
});
export type BrowserHistoryRecentInput = typeof BrowserHistoryRecentInput.Type;

export const BrowserHistoryRecentEntry = Schema.Struct({
  url: Schema.String,
  title: Schema.NullOr(Schema.String),
  lastVisitedAt: Schema.Number,
});
export type BrowserHistoryRecentEntry = typeof BrowserHistoryRecentEntry.Type;

export const BrowserHistoryRemoveInput = Schema.Struct({
  profileId: BrowserProfileId,
  visitIds: Schema.optional(Schema.Array(Schema.Int).check(Schema.isMaxLength(1_000))),
  /** Removing a URL removes every visit to it. */
  urls: Schema.optional(Schema.Array(Url).check(Schema.isMaxLength(1_000))),
});
export type BrowserHistoryRemoveInput = typeof BrowserHistoryRemoveInput.Type;

export const BrowserHistoryClearInput = Schema.Struct({
  profileId: BrowserProfileId,
  range: BrowserHistoryClearRange,
  dataTypes: Schema.Array(BrowserHistoryClearDataType).check(Schema.isMinLength(1)),
  /**
   * Cookies and cache live in one partition per environment, so clearing them
   * needs every environment the profile was used in.
   */
  environmentIds: Schema.Array(EnvironmentId).check(Schema.isMaxLength(256)),
});
export type BrowserHistoryClearInput = typeof BrowserHistoryClearInput.Type;

export const BrowserHistoryLegacyEntry = Schema.Struct({
  url: Url,
  title: Schema.optional(Schema.String),
  lastVisitedAt: Timestamp,
});
export type BrowserHistoryLegacyEntry = typeof BrowserHistoryLegacyEntry.Type;

export const BrowserHistoryImportLegacyInput = Schema.Struct({
  entries: Schema.Array(BrowserHistoryLegacyEntry).check(
    Schema.isMaxLength(BROWSER_HISTORY_LEGACY_IMPORT_MAX_ENTRIES),
  ),
});
export type BrowserHistoryImportLegacyInput = typeof BrowserHistoryImportLegacyInput.Type;

export const BrowserHistoryImportLegacyResult = Schema.Struct({
  imported: Schema.Int,
});
export type BrowserHistoryImportLegacyResult = typeof BrowserHistoryImportLegacyResult.Type;

export const BrowserHistoryStatusInput = Schema.Struct({
  profileId: BrowserProfileId,
});
export type BrowserHistoryStatusInput = typeof BrowserHistoryStatusInput.Type;

export const BrowserHistoryStatus = Schema.Struct({
  /** False when the profile's history database could not be opened; browsing still works. */
  available: Schema.Boolean,
  /** Managed builds can lock removal and clearing. */
  deletionLocked: Schema.Boolean,
});
export type BrowserHistoryStatus = typeof BrowserHistoryStatus.Type;

export const BrowserHistoryChangedEvent = Schema.Struct({
  profileId: BrowserProfileId,
});
export type BrowserHistoryChangedEvent = typeof BrowserHistoryChangedEvent.Type;

export const BROWSER_HISTORY_SUGGEST_MAX_LIMIT = 20;
export const ADDRESS_BAR_REMOTE_SUGGESTIONS_MAX = 4;

export const BrowserHistorySuggestion = Schema.Struct({
  url: Schema.String,
  title: Schema.NullOr(Schema.String),
});
export type BrowserHistorySuggestion = typeof BrowserHistorySuggestion.Type;

export const BrowserHistorySuggestInput = Schema.Struct({
  profileId: BrowserProfileId,
  input: Schema.String.check(Schema.isMaxLength(BROWSER_HISTORY_MAX_URL_LENGTH)),
  limit: Limit(BROWSER_HISTORY_SUGGEST_MAX_LIMIT),
});
export type BrowserHistorySuggestInput = typeof BrowserHistorySuggestInput.Type;

export const BrowserHistorySuggestResult = Schema.Struct({
  /** History matches, best first. Empty for incognito. */
  matches: Schema.Array(BrowserHistorySuggestion),
  /** The top match's origin root and how often it was visited, for inline completion. */
  topOrigin: Schema.NullOr(Schema.Struct({ url: Schema.String, visitCount: Schema.Int })),
});
export type BrowserHistorySuggestResult = typeof BrowserHistorySuggestResult.Type;

export const BrowserHistoryFrequentInput = Schema.Struct({
  profileId: BrowserProfileId,
  limit: Limit(BROWSER_HISTORY_SUGGEST_MAX_LIMIT),
});
export type BrowserHistoryFrequentInput = typeof BrowserHistoryFrequentInput.Type;

export const AddressBarRemoteSuggestInput = Schema.Struct({
  profileId: BrowserProfileId,
  input: Schema.String.check(Schema.isMaxLength(512)),
});
export type AddressBarRemoteSuggestInput = typeof AddressBarRemoteSuggestInput.Type;

export const AddressBarRemoteSuggestResult = Schema.Struct({
  suggestions: Schema.Array(Schema.String),
});
export type AddressBarRemoteSuggestResult = typeof AddressBarRemoteSuggestResult.Type;

export interface DesktopBrowserHistoryBridge {
  suggest: (input: BrowserHistorySuggestInput) => Promise<BrowserHistorySuggestResult>;
  frequent: (
    input: BrowserHistoryFrequentInput,
  ) => Promise<ReadonlyArray<BrowserHistorySuggestion>>;
  /**
   * Search suggestions from the engine. Main checks the setting itself and
   * sends nothing while it is off or for incognito.
   */
  remoteSuggestions: (
    input: AddressBarRemoteSuggestInput,
  ) => Promise<AddressBarRemoteSuggestResult>;
  search: (input: BrowserHistorySearchInput) => Promise<BrowserHistorySearchResult>;
  recent: (input: BrowserHistoryRecentInput) => Promise<ReadonlyArray<BrowserHistoryRecentEntry>>;
  remove: (input: BrowserHistoryRemoveInput) => Promise<void>;
  clear: (input: BrowserHistoryClearInput) => Promise<void>;
  importLegacy: (
    input: BrowserHistoryImportLegacyInput,
  ) => Promise<BrowserHistoryImportLegacyResult>;
  status: (input: BrowserHistoryStatusInput) => Promise<BrowserHistoryStatus>;
  onChanged: (listener: (event: BrowserHistoryChangedEvent) => void) => () => void;
}
