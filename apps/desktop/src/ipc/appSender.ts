import { webContents } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { DesktopIpcInvokeEvent } from "./DesktopIpc.ts";

export class DesktopIpcUntrustedSenderError extends Schema.TaggedError<DesktopIpcUntrustedSenderError>()(
  "DesktopIpcUntrustedSenderError",
  { channel: Schema.String },
) {
  override get message(): string {
    return `${this.channel} is only available to the app window.`;
  }
}

/**
 * Browser guests share ipcMain with the app window. Private data such as
 * browsing history must only reach the app's own renderer, never a page.
 */
export const requireAppSender = (channel: string, event: DesktopIpcInvokeEvent | undefined) =>
  Effect.suspend(() => {
    const sender = event === undefined ? undefined : webContents.fromId(event.sender.id);
    return sender === undefined || sender.getType() === "webview"
      ? Effect.fail(new DesktopIpcUntrustedSenderError({ channel }))
      : Effect.void;
  });
