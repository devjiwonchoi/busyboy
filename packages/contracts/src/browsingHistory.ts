import * as Schema from "effect/Schema";

export const BrowsingHistorySuggestion = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
});
export type BrowsingHistorySuggestion = typeof BrowsingHistorySuggestion.Type;

export const DesktopPreviewSearchHistoryInputSchema = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(2048)),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
});

export const ChromeHistoryImportFailureReason = Schema.Literals([
  "notInstalled",
  "unsupportedPlatform",
  "readFailed",
  "saveFailed",
]);
export type ChromeHistoryImportFailureReason = typeof ChromeHistoryImportFailureReason.Type;

export const ChromeHistoryImportResult = Schema.Struct({
  imported: Schema.Int,
});
export type ChromeHistoryImportResult = typeof ChromeHistoryImportResult.Type;

export const CHROME_HISTORY_IMPORT_FAILURE_COPY: Readonly<
  Record<ChromeHistoryImportFailureReason, string>
> = {
  notInstalled: "Chrome has no browsing history on this machine.",
  unsupportedPlatform: "Importing Chrome history isn't possible on this platform.",
  readFailed: "Chrome's history could not be read.",
  saveFailed: "The history was read, but couldn't be saved. Try again.",
};
