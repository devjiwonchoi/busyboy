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
