import {
  AddressBarRemoteSuggestInput,
  AddressBarRemoteSuggestResult,
  BrowserHistoryFrequentInput,
  BrowserHistorySuggestInput,
  BrowserHistorySuggestResult,
  BrowserHistorySuggestion,
  BrowserHistoryClearInput,
  BrowserHistoryImportLegacyInput,
  BrowserHistoryImportLegacyResult,
  BrowserHistoryRecentEntry,
  BrowserHistoryRecentInput,
  BrowserHistoryRemoveInput,
  BrowserHistorySearchInput,
  BrowserHistorySearchResult,
  BrowserHistoryStatus,
  BrowserHistoryStatusInput,
} from "@t3tools/contracts";
import { resolveSearchEngine } from "@t3tools/shared/preview";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as BrowserHistory from "../../preview/BrowserHistory/BrowserHistory.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import { requireAppSender } from "../appSender.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { resolvePartitionScope } from "./preview.ts";

export const installBrowserHistoryEventForwarding = Effect.fn(
  "desktop.ipc.browserHistory.installEventForwarding",
)(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const history = yield* BrowserHistory.BrowserHistory;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const unsubscribe = history.subscribeChanges((profileId) =>
    runFork(electronWindow.sendAll(IpcChannels.BROWSER_HISTORY_CHANGED_CHANNEL, { profileId })),
  );
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
});

export const search = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_HISTORY_SEARCH_CHANNEL,
  payload: BrowserHistorySearchInput,
  result: BrowserHistorySearchResult,
  handler: Effect.fn("desktop.ipc.browserHistory.search")(function* (input, event) {
    yield* requireAppSender(IpcChannels.BROWSER_HISTORY_SEARCH_CHANNEL, event);
    const history = yield* BrowserHistory.BrowserHistory;
    return yield* history.search(input);
  }),
});

export const recent = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_HISTORY_RECENT_CHANNEL,
  payload: BrowserHistoryRecentInput,
  result: Schema.Array(BrowserHistoryRecentEntry),
  handler: Effect.fn("desktop.ipc.browserHistory.recent")(function* (input, event) {
    yield* requireAppSender(IpcChannels.BROWSER_HISTORY_RECENT_CHANNEL, event);
    const history = yield* BrowserHistory.BrowserHistory;
    return yield* history.recent(input);
  }),
});

export const remove = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_HISTORY_REMOVE_CHANNEL,
  payload: BrowserHistoryRemoveInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.browserHistory.remove")(function* (input, event) {
    yield* requireAppSender(IpcChannels.BROWSER_HISTORY_REMOVE_CHANNEL, event);
    const history = yield* BrowserHistory.BrowserHistory;
    yield* history.remove(input);
  }),
});

export const clear = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_HISTORY_CLEAR_CHANNEL,
  payload: BrowserHistoryClearInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.browserHistory.clear")(function* (input, event) {
    yield* requireAppSender(IpcChannels.BROWSER_HISTORY_CLEAR_CHANNEL, event);
    const history = yield* BrowserHistory.BrowserHistory;
    if (history.deletionLocked)
      return yield* new BrowserHistory.BrowserHistoryDeletionLockedError();
    const manager = yield* PreviewManager.PreviewManager;
    const clearCookies = input.dataTypes.includes("cookies_site_data");
    const clearCache = input.dataTypes.includes("cache");
    if (clearCookies || clearCache) {
      // Electron cannot clear storage by time, so cookies and cache go for all time.
      const partitions = yield* Effect.forEach(input.environmentIds, (environmentId) =>
        Effect.gen(function* () {
          const { scope, persistent, namespace } = resolvePartitionScope(
            environmentId,
            input.profileId,
          );
          // Loading the session registers the partition so the clear can reach it.
          yield* manager.getBrowserSession(scope, persistent, namespace);
          return yield* manager.getBrowserPartition(scope, persistent, namespace);
        }),
      );
      if (partitions.length > 0) {
        if (clearCookies) yield* manager.clearCookies(partitions);
        if (clearCache) yield* manager.clearCache(partitions);
      }
    }
    if (input.dataTypes.includes("history")) {
      yield* history.clearHistory({ profileId: input.profileId, range: input.range });
    }
  }),
});

export const importLegacy = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_HISTORY_IMPORT_LEGACY_CHANNEL,
  payload: BrowserHistoryImportLegacyInput,
  result: BrowserHistoryImportLegacyResult,
  handler: Effect.fn("desktop.ipc.browserHistory.importLegacy")(function* ({ entries }, event) {
    yield* requireAppSender(IpcChannels.BROWSER_HISTORY_IMPORT_LEGACY_CHANNEL, event);
    const history = yield* BrowserHistory.BrowserHistory;
    return yield* history.importLegacy(entries);
  }),
});

export const status = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_HISTORY_STATUS_CHANNEL,
  payload: BrowserHistoryStatusInput,
  result: BrowserHistoryStatus,
  handler: Effect.fn("desktop.ipc.browserHistory.status")(function* ({ profileId }, event) {
    yield* requireAppSender(IpcChannels.BROWSER_HISTORY_STATUS_CHANNEL, event);
    const history = yield* BrowserHistory.BrowserHistory;
    return yield* history.status(profileId);
  }),
});

export const suggest = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_HISTORY_SUGGEST_CHANNEL,
  payload: BrowserHistorySuggestInput,
  result: BrowserHistorySuggestResult,
  handler: Effect.fn("desktop.ipc.browserHistory.suggest")(function* (input, event) {
    yield* requireAppSender(IpcChannels.BROWSER_HISTORY_SUGGEST_CHANNEL, event);
    const history = yield* BrowserHistory.BrowserHistory;
    return yield* history.suggest({
      profileId: input.profileId,
      text: input.input,
      limit: input.limit,
    });
  }),
});

export const frequent = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BROWSER_HISTORY_FREQUENT_CHANNEL,
  payload: BrowserHistoryFrequentInput,
  result: Schema.Array(BrowserHistorySuggestion),
  handler: Effect.fn("desktop.ipc.browserHistory.frequent")(function* (input, event) {
    yield* requireAppSender(IpcChannels.BROWSER_HISTORY_FREQUENT_CHANNEL, event);
    const history = yield* BrowserHistory.BrowserHistory;
    return yield* history.frequent(input);
  }),
});

export const remoteSuggestions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.ADDRESS_BAR_REMOTE_SUGGESTIONS_CHANNEL,
  payload: AddressBarRemoteSuggestInput,
  result: AddressBarRemoteSuggestResult,
  handler: Effect.fn("desktop.ipc.browserHistory.remoteSuggestions")(function* (input, event) {
    yield* requireAppSender(IpcChannels.ADDRESS_BAR_REMOTE_SUGGESTIONS_CHANNEL, event);
    const history = yield* BrowserHistory.BrowserHistory;
    // Main reads the opt-in itself rather than trusting the renderer.
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    // Unreadable settings count as "off".
    const readSettings = clientSettings.get.pipe(Effect.orElseSucceed(() => Option.none()));
    const settings = Option.getOrNull(yield* readSettings);
    const suggestions = yield* history.remoteSuggestions({
      enabled: settings?.browserRemoteSearchSuggestions === true,
      profileId: input.profileId,
      engine: resolveSearchEngine({
        engine: settings?.browserSearchEngine,
        customSearchUrl: settings?.browserCustomSearchUrl,
      }),
      text: input.input,
      stillEnabled: () =>
        Option.getOrNull(Effect.runSync(readSettings))?.browserRemoteSearchSuggestions === true,
    });
    return { suggestions };
  }),
});

export const methods = [
  search,
  recent,
  remove,
  clear,
  importLegacy,
  status,
  suggest,
  frequent,
] as const;
