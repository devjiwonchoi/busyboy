import {
  BrowserLoginSummary,
  BrowserNeverSaveEntry,
  BrowserPasswordsAddInput,
  BrowserPasswordsAddResult,
  BrowserPasswordsDeleteAllResult,
  BrowserPasswordsGatedResult,
  BrowserPasswordsIdInput,
  BrowserPasswordsIdsInput,
  BrowserPasswordsListInput,
  BrowserPasswordsNoteResult,
  BrowserPasswordsProfileInput,
  BrowserPasswordsRevealResult,
  BrowserPasswordsStatus,
  BrowserPasswordsStatusInput,
  BrowserPasswordsUpdateInput,
  BrowserPasswordsUpdateResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as BrowserPasswords from "../../preview/BrowserPasswords/BrowserPasswords.ts";
import { requireAppSender } from "../appSender.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const installBrowserPasswordsEventForwarding = Effect.fn(
  "desktop.ipc.browserPasswords.installEventForwarding",
)(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const passwords = yield* BrowserPasswords.BrowserPasswords;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const unsubscribe = passwords.subscribeChanges((profileId) =>
    runFork(electronWindow.sendAll(IpcChannels.BROWSER_PASSWORDS_CHANGED_CHANNEL, { profileId })),
  );
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
});

/**
 * Every vault method is for the app's own settings UI. Guests are refused, and
 * only `reveal` returns a password, after the device check.
 */
const method = <P, PE, R, RE, E>(
  channel: string,
  payload: Schema.Codec<P, PE>,
  result: Schema.Codec<R, RE>,
  run: (passwords: BrowserPasswords.BrowserPasswordsShape, input: P) => Effect.Effect<R, E>,
) =>
  DesktopIpc.makeIpcMethod({
    channel,
    payload,
    result,
    handler: Effect.fn(`desktop.ipc.browserPasswords.${channel}`)(function* (input: P, event) {
      yield* requireAppSender(channel, event);
      return yield* run(yield* BrowserPasswords.BrowserPasswords, input);
    }),
  });

export const methods = [
  method(
    IpcChannels.BROWSER_PASSWORDS_STATUS_CHANNEL,
    BrowserPasswordsStatusInput,
    BrowserPasswordsStatus,
    (passwords, { profileId }) => passwords.status(profileId),
  ),
  method(
    IpcChannels.BROWSER_PASSWORDS_LIST_CHANNEL,
    BrowserPasswordsListInput,
    Schema.Array(BrowserLoginSummary),
    (passwords, input) => passwords.list(input),
  ),
  method(
    IpcChannels.BROWSER_PASSWORDS_ADD_CHANNEL,
    BrowserPasswordsAddInput,
    BrowserPasswordsAddResult,
    (passwords, input) => passwords.add(input),
  ),
  method(
    IpcChannels.BROWSER_PASSWORDS_UPDATE_CHANNEL,
    BrowserPasswordsUpdateInput,
    BrowserPasswordsUpdateResult,
    (passwords, input) => passwords.update(input),
  ),
  method(
    IpcChannels.BROWSER_PASSWORDS_REMOVE_CHANNEL,
    BrowserPasswordsIdsInput,
    Schema.Void,
    (passwords, input) => passwords.remove(input),
  ),
  method(
    IpcChannels.BROWSER_PASSWORDS_NOTE_CHANNEL,
    BrowserPasswordsIdInput,
    BrowserPasswordsNoteResult,
    (passwords, input) => passwords.note(input).pipe(Effect.map((note) => ({ note }))),
  ),
  method(
    IpcChannels.BROWSER_PASSWORDS_REVEAL_CHANNEL,
    BrowserPasswordsIdInput,
    BrowserPasswordsRevealResult,
    (passwords, input) => passwords.reveal(input),
  ),
  method(
    IpcChannels.BROWSER_PASSWORDS_COPY_CHANNEL,
    BrowserPasswordsIdInput,
    BrowserPasswordsGatedResult,
    (passwords, input) => passwords.copy(input),
  ),
  method(
    IpcChannels.BROWSER_PASSWORDS_DELETE_ALL_CHANNEL,
    BrowserPasswordsProfileInput,
    BrowserPasswordsDeleteAllResult,
    (passwords, { profileId }) => passwords.deleteAll(profileId),
  ),
  method(
    IpcChannels.BROWSER_PASSWORDS_NEVER_SAVE_LIST_CHANNEL,
    BrowserPasswordsProfileInput,
    Schema.Array(BrowserNeverSaveEntry),
    (passwords, { profileId }) => passwords.neverSaveList(profileId),
  ),
  method(
    IpcChannels.BROWSER_PASSWORDS_NEVER_SAVE_REMOVE_CHANNEL,
    BrowserPasswordsIdsInput,
    Schema.Void,
    (passwords, input) => passwords.neverSaveRemove(input),
  ),
] as const;
