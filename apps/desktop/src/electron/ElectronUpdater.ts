// @effect-diagnostics nodeBuiltinImport:off - Deletes a refused update download.
import * as NodeFS from "node:fs";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { autoUpdater } from "electron-updater";

import { UpdateVerificationError } from "../updates/updateSignature.ts";

type AutoUpdater = typeof autoUpdater;

export type ElectronUpdaterFeedUrl = Parameters<AutoUpdater["setFeedURL"]>[0];

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedError<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedError<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedError<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronUpdater") {}

/** Proves the files electron-updater downloaded for `version` came from us, or throws. */
export type VerifyDownload = (input: {
  readonly version: string;
  readonly files: ReadonlyArray<string>;
}) => Promise<void>;

type Updater = Pick<
  AutoUpdater,
  | "checkForUpdates"
  | "downloadUpdate"
  | "quitAndInstall"
  | "on"
  | "removeListener"
  | "autoInstallOnAppQuit"
>;

/**
 * Wraps electron-updater so that a download counts only once `verifyDownload`
 * accepts it: until then "update-downloaded" is held back, quitAndInstall
 * refuses and install-on-quit stays off. A refused download is deleted.
 */
export function makeVerified(
  verifyDownload: VerifyDownload,
  updater: Updater = autoUpdater,
): ElectronUpdater["Service"] {
  const base = makeFor(updater as AutoUpdater);
  const downloadedListeners = new Set<(...args: Array<unknown>) => void>();
  let offeredVersion: string | null = null;
  let downloadedInfo: unknown = null;
  let verified = false;
  let installOnQuit = false;
  // electron-updater only arms its quit handler if the flag is on when the
  // download finishes, which is before verification, so arm it ourselves.
  const applyInstallOnQuit = () => {
    updater.autoInstallOnAppQuit = installOnQuit && verified;
    if (updater.autoInstallOnAppQuit) {
      (updater as { addQuitHandler?: () => void }).addQuitHandler?.();
    }
  };
  applyInstallOnQuit();
  updater.on("update-downloaded", (info) => {
    downloadedInfo = info;
  });

  return ElectronUpdater.of({
    ...base,
    setAutoInstallOnAppQuit: (value) =>
      Effect.sync(() => {
        installOnQuit = value;
        applyInstallOnQuit();
      }),
    checkForUpdates: Effect.tryPromise({
      try: async () => {
        const result = await updater.checkForUpdates();
        offeredVersion = result?.updateInfo.version ?? null;
      },
      catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel: null, cause }),
    }),
    downloadUpdate: Effect.tryPromise({
      try: async () => {
        verified = false;
        applyInstallOnQuit();
        downloadedInfo = null;
        const files = await updater.downloadUpdate();
        try {
          if (offeredVersion === null) {
            throw new UpdateVerificationError("No update version was offered.");
          }
          if (files.length === 0) {
            throw new UpdateVerificationError("No update file was downloaded.");
          }
          await verifyDownload({ version: offeredVersion, files });
        } catch (cause) {
          for (const file of files) NodeFS.rmSync(file, { force: true });
          throw cause;
        }
        verified = true;
        applyInstallOnQuit();
        for (const listener of downloadedListeners) {
          listener(downloadedInfo ?? { version: offeredVersion });
        }
      },
      catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel: null, cause }),
    }),
    quitAndInstall: (options) =>
      verified
        ? base.quitAndInstall(options)
        : Effect.fail(
            new ElectronUpdaterQuitAndInstallError({
              channel: null,
              ...options,
              cause: new UpdateVerificationError("It was not verified after downloading."),
            }),
          ),
    on: (eventName, listener) => {
      if (eventName !== "update-downloaded") return base.on(eventName, listener);
      const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
      return Effect.acquireRelease(
        Effect.sync(() => {
          downloadedListeners.add(untypedListener);
        }),
        () =>
          Effect.sync(() => {
            downloadedListeners.delete(untypedListener);
          }),
      ).pipe(Effect.asVoid);
    },
  });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = makeFor(autoUpdater);

function makeFor(autoUpdater: AutoUpdater): ElectronUpdater["Service"] {
  return ElectronUpdater.of({
    setFeedURL: (options) =>
      Effect.suspend(() => {
        autoUpdater.setFeedURL(options);
        return Effect.void;
      }),
    setAutoDownload: (value) =>
      Effect.suspend(() => {
        autoUpdater.autoDownload = value;
        return Effect.void;
      }),
    setAutoInstallOnAppQuit: (value) =>
      Effect.suspend(() => {
        autoUpdater.autoInstallOnAppQuit = value;
        return Effect.void;
      }),
    setChannel: (channel) =>
      Effect.suspend(() => {
        autoUpdater.channel = channel;
        return Effect.void;
      }),
    setAllowPrerelease: (value) =>
      Effect.suspend(() => {
        autoUpdater.allowPrerelease = value;
        return Effect.void;
      }),
    allowDowngrade: Effect.sync(() => autoUpdater.allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.suspend(() => {
        autoUpdater.allowDowngrade = value;
        return Effect.void;
      }),
    setFullChangelog: (value) =>
      Effect.suspend(() => {
        autoUpdater.fullChangelog = value;
        return Effect.void;
      }),
    setDisableDifferentialDownload: (value) =>
      Effect.suspend(() => {
        autoUpdater.disableDifferentialDownload = value;
        return Effect.void;
      }),
    checkForUpdates: Effect.suspend(() => {
      const channel = autoUpdater.channel;
      return Effect.tryPromise({
        try: () => autoUpdater.checkForUpdates(),
        catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
      }).pipe(Effect.asVoid);
    }),
    downloadUpdate: Effect.suspend(() => {
      const channel = autoUpdater.channel;
      return Effect.tryPromise({
        try: () => autoUpdater.downloadUpdate(),
        catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
      }).pipe(Effect.asVoid);
    }),
    quitAndInstall: ({ isSilent, isForceRunAfter }) =>
      Effect.suspend(() => {
        const channel = autoUpdater.channel;
        return Effect.try({
          try: () => autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
          catch: (cause) =>
            new ElectronUpdaterQuitAndInstallError({
              channel,
              isSilent,
              isForceRunAfter,
              cause,
            }),
        });
      }),
    on: (eventName, listener) => {
      const eventTarget = autoUpdater as unknown as {
        on: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
        removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
      };
      const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
      return Effect.acquireRelease(
        Effect.sync(() => {
          eventTarget.on(eventName, untypedListener);
        }),
        () =>
          Effect.sync(() => {
            eventTarget.removeListener(eventName, untypedListener);
          }),
      ).pipe(Effect.asVoid);
    },
  });
}

export const layer = Layer.succeed(ElectronUpdater, make);
