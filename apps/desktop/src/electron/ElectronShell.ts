import { MAC_PERMISSION_SETTINGS_URLS } from "../permissions/MacPermission.ts";
import {
  COMPUTER_USE_SETTINGS_URLS,
  REMOTE_CAPABLE_EDITOR_IDS,
  remoteSchemeForEditor,
  type SystemSettingsPane,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

// Remote open-in-editor deep links (`vscode://vscode-remote/ssh-remote+…`,
// `zed://ssh/<host>/<path>`, `jetbrains://gateway/ssh/environment?h=…`) must
// reach the OS handler; every other non-web scheme stays blocked.
const SAFE_WEB_PROTOCOLS = new Set(["http:", "https:"]);
const REMOTE_EDITOR_PROTOCOLS = new Set(
  REMOTE_CAPABLE_EDITOR_IDS.flatMap((id) => {
    const scheme = remoteSchemeForEditor(id);
    return scheme === undefined ? [] : [`${scheme}:`];
  }),
);

// Zed's host sits in the first path segment, so it needs its own userinfo ban.
const ZED_SSH_PATHNAME = /^\/[^/@:]+\/.*$/;

const isRemoteEditorUrl = (url: URL) =>
  REMOTE_EDITOR_PROTOCOLS.has(url.protocol) &&
  url.username.length === 0 &&
  url.password.length === 0 &&
  (url.protocol === "zed:"
    ? url.host === "ssh" && ZED_SSH_PATHNAME.test(url.pathname)
    : url.protocol === "jetbrains:"
      ? url.host === "gateway" &&
        url.pathname === "/ssh/environment" &&
        (url.searchParams.get("h") ?? "").length > 0
      : url.host === "vscode-remote" &&
        url.pathname.startsWith("/ssh-remote+") &&
        url.pathname.length > "/ssh-remote+".length);

// The Computer Use settings links to the helper's privacy panes, exactly.
const SYSTEM_SETTINGS_URLS = new Set<string>(Object.values(COMPUTER_USE_SETTINGS_URLS));

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }
  if (SYSTEM_SETTINGS_URLS.has(rawUrl)) return Option.some(rawUrl);

  try {
    const url = new URL(rawUrl);
    return SAFE_WEB_PROTOCOLS.has(url.protocol) || isRemoteEditorUrl(url)
      ? Option.some(url.href)
      : Option.none();
  } catch {
    return Option.none();
  }
}

const decodeHost = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** The SSH host a safe remote-editor link connects to, or `null` for any other link. */
export function remoteEditorHost(safeUrl: string): string | null {
  const url = new URL(safeUrl);
  if (!isRemoteEditorUrl(url)) return null;
  if (url.protocol === "jetbrains:") return url.searchParams.get("h");
  if (url.protocol === "zed:") return decodeHost(url.pathname.split("/")[1] ?? "");
  const authority = url.pathname.slice("/ssh-remote+".length).split("/")[0] ?? "";
  return decodeHost(authority);
}

const MAX_CONFIRM_URL_LENGTH = 300;

/**
 * A remote-editor link makes the user's editor connect over SSH to whatever host it names, and
 * such links can come from untrusted chat content. Nothing opens until the user has seen the host.
 */
const confirmRemoteEditorLink = (url: string, host: string): Promise<boolean> => {
  const shownUrl =
    url.length > MAX_CONFIRM_URL_LENGTH ? `${url.slice(0, MAX_CONFIRM_URL_LENGTH)}…` : url;
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    buttons: ["Connect", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Connect your editor to ${host}?`,
    detail: `This link opens your editor and connects it over SSH to ${host}. Only continue if you trust this host.\n\n${shownUrl}`,
  };
  const owner = Electron.BrowserWindow.getFocusedWindow();
  return (
    owner === null
      ? Electron.dialog.showMessageBox(options)
      : Electron.dialog.showMessageBox(owner, options)
  ).then(
    ({ response }) => response === 0,
    () => false,
  );
};

const openUrl = (externalUrl: string): Promise<boolean> =>
  Electron.shell.openExternal(externalUrl).then(
    () => true,
    () => false,
  );

export class ElectronShell extends Context.Service<
  ElectronShell,
  {
    readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
    readonly openSystemSettings: (pane: SystemSettingsPane) => Effect.Effect<boolean>;
    readonly copyText: (text: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronShell") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = ElectronShell.of({
  openExternal: (rawUrl) =>
    Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        Effect.promise(() => {
          const host = remoteEditorHost(externalUrl);
          return host === null
            ? openUrl(externalUrl)
            : confirmRemoteEditorLink(externalUrl, host).then((confirmed) =>
                confirmed ? openUrl(externalUrl) : false,
              );
        }),
    }),
  openSystemSettings: (pane) =>
    Effect.promise(() =>
      Electron.shell.openExternal(MAC_PERMISSION_SETTINGS_URLS[pane]).then(
        () => true,
        () => false,
      ),
    ),
  copyText: (text) =>
    Effect.promise(() => Electron.clipboard.writeText(text).catch(() => undefined)),
});

export const layer = Layer.succeed(ElectronShell, make);
