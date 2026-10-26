import {
  PasswordImportFailureReason,
  type ChromePasswordSource,
  type PasswordFileImportSourceId,
  type PasswordImportResult,
  type PasswordImportSourceId,
  type SavedPasswordStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import { resolveChromiumKeys } from "../BrowserImport/ChromiumKeys.ts";
import {
  BROWSER_IMPORT_SOURCES,
  listSourceProfiles,
  sourcePathContext,
} from "../BrowserImport/Sources.ts";
import {
  CHROME_PASSWORD_DATABASE_NAMES,
  decodeChromiumKeys,
  encodeChromiumKeys,
  readChromePasswords,
} from "./ChromePasswords.ts";
import { readPasswordCsv } from "./PasswordCsv.ts";
import type { PasswordReadResult } from "./PasswordEntry.ts";
import * as PasswordVault from "./PasswordVault.ts";

/** Real exports are a few MB at most; anything larger is the wrong file. */
const MAX_PASSWORD_FILE_BYTES = 50 * 1024 * 1024;
/** Lets the app finish starting (and `safeStorage` become usable) first. */
const CHROME_SYNC_STARTUP_DELAY = "15 seconds";
const CHROME_SYNC_INTERVAL = "15 minutes";

export class PasswordImportFailedError extends Schema.TaggedError<PasswordImportFailedError>()(
  "PasswordImportFailedError",
  {
    sourceId: Schema.String,
    reason: PasswordImportFailureReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // The reason token is part of the message on purpose: IPC flattens the error
  // to its message, and the renderer maps that token back to user-facing copy.
  override get message(): string {
    return `Importing passwords from ${this.sourceId} failed: ${this.reason}.`;
  }
}

export class PasswordImport extends Context.Service<
  PasswordImport,
  {
    readonly chromeSource: Effect.Effect<ChromePasswordSource>;
    /** Imports once, then keeps syncing from that Chrome profile. */
    readonly importChrome: (input: {
      readonly sourceProfileDirectory: string;
    }) => Effect.Effect<PasswordImportResult, PasswordImportFailedError>;
    readonly stopChromeSync: Effect.Effect<void, PasswordImportFailedError>;
    readonly importFile: (input: {
      readonly sourceId: PasswordFileImportSourceId;
      readonly filePath: string;
    }) => Effect.Effect<PasswordImportResult, PasswordImportFailedError>;
    readonly status: Effect.Effect<SavedPasswordStatus, PasswordImportFailedError>;
  }
>()("@t3tools/desktop/preview/Passwords/PasswordImport") {}

const chromeDefinition = BROWSER_IMPORT_SOURCES.find((definition) => definition.id === "chrome");

const vaultFailure =
  (sourceId: PasswordImportSourceId) => (cause: PasswordVault.PasswordVaultError) =>
    new PasswordImportFailedError({
      sourceId,
      reason: cause.reason === "encryptionUnavailable" ? "encryptionUnavailable" : "saveFailed",
      cause,
    });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const vault = yield* PasswordVault.PasswordVault;
  const platform = yield* HostProcess.Platform;
  const fileSystem = yield* FileSystem.FileSystem;
  const platformServices = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const pathContext = yield* sourcePathContext;
  const lastChromeSync = yield* Ref.make<number | null>(null);

  const saveRead = Effect.fn("PasswordImport.saveRead")(function* ({
    read,
    sourceId,
    onlyWhileChromeSyncs,
    unlessClearedSince,
    keepSavedInBusyboy,
  }: {
    readonly read: PasswordReadResult;
    readonly sourceId: PasswordImportSourceId;
    readonly onlyWhileChromeSyncs: boolean;
    readonly unlessClearedSince?: number;
    readonly keepSavedInBusyboy: boolean;
  }) {
    const saved = yield* vault
      .save({
        passwords: read.passwords,
        source: sourceId,
        onlyWhileChromeSyncs,
        ...(unlessClearedSince === undefined ? {} : { unlessClearedSince }),
        keepSavedInBusyboy,
      })
      .pipe(Effect.mapError(vaultFailure(sourceId)));
    return { ...saved, skipped: read.skipped } satisfies PasswordImportResult;
  });

  // Chrome profiles that actually hold a password database, keyed by the
  // directory the renderer will send back.
  const chromeProfiles = Effect.gen(function* () {
    if (chromeDefinition === undefined || !chromeDefinition.platforms.includes(platform)) {
      return [];
    }
    const root = chromeDefinition.userDataDirectory(pathContext);
    if (root === undefined) {
      return [];
    }

    const profiles = yield* listSourceProfiles(chromeDefinition, pathContext);
    const found = yield* Effect.forEach(profiles, (profile) =>
      Effect.forEach(CHROME_PASSWORD_DATABASE_NAMES, (name) => {
        const databasePath = pathContext.path.join(root, profile.directory, name);
        return fileSystem.stat(databasePath).pipe(
          Effect.map((info) => (info.type === "File" ? databasePath : undefined)),
          Effect.orElseSucceed(() => undefined),
        );
      }).pipe(
        Effect.map((paths) => ({
          directory: profile.directory,
          name: profile.name,
          databasePaths: paths.filter((databasePath) => databasePath !== undefined),
        })),
      ),
    );
    return found.filter((profile) => profile.databasePaths.length > 0);
  }).pipe(Effect.provide(platformServices));

  // Chrome may stay open: its password database is read from a copy.
  const chromeSource = Effect.gen(function* () {
    if (chromeDefinition === undefined || !chromeDefinition.platforms.includes(platform)) {
      return { profiles: [], unavailable: "unsupportedPlatform" as const };
    }
    const profiles = yield* chromeProfiles;
    if (profiles.length === 0) {
      return { profiles: [], unavailable: "notInstalled" as const };
    }
    return { profiles: profiles.map(({ directory, name }) => ({ directory, name })) };
  }) satisfies Effect.Effect<ChromePasswordSource>;

  // The directory arrives over IPC (or from the vault), so only one Chrome
  // itself reports is honoured; anything else could walk out of its user-data
  // directory.
  const findChromeProfile = Effect.fn("PasswordImport.findChromeProfile")(function* (
    profileDirectory: string,
  ) {
    if (chromeDefinition === undefined || !chromeDefinition.platforms.includes(platform)) {
      return yield* new PasswordImportFailedError({
        sourceId: "chrome",
        reason: "unsupportedPlatform",
      });
    }
    const profile = (yield* chromeProfiles).find(
      (candidate) => candidate.directory === profileDirectory,
    );
    if (profile === undefined) {
      return yield* new PasswordImportFailedError({
        sourceId: "chrome",
        reason: "unknownSourceProfile",
      });
    }
    return { definition: chromeDefinition, profile };
  });

  const readChromeProfile = Effect.fn("PasswordImport.readChromeProfile")(function* ({
    databasePaths,
    keys,
  }: {
    readonly databasePaths: ReadonlyArray<string>;
    readonly keys: Parameters<typeof readChromePasswords>[0]["keys"];
  }) {
    return yield* readChromePasswords({ databasePaths, keys, platform }).pipe(
      Effect.scoped,
      Effect.provide(platformServices),
      Effect.mapError(
        (cause) =>
          new PasswordImportFailedError({ sourceId: "chrome", reason: cause.reason, cause }),
      ),
    );
  });

  const importChrome = Effect.fn("PasswordImport.importChrome")(function* ({
    sourceProfileDirectory,
  }: {
    readonly sourceProfileDirectory: string;
  }) {
    const { definition, profile } = yield* findChromeProfile(sourceProfileDirectory);
    // Removing everything while this reads Chrome wins: nothing is written back.
    const clears = yield* vault.clears;

    // The one Keychain prompt: the key is kept in the vault for later syncs.
    const keys = yield* resolveChromiumKeys({
      platform,
      keychainService: definition.keychainService,
      keychainAccount: definition.keychainAccount,
      linuxSecretApplication: definition.linuxSecretApplication,
    }).pipe(
      Effect.provide(platformServices),
      Effect.mapError(
        (cause) =>
          new PasswordImportFailedError({ sourceId: "chrome", reason: cause.reason, cause }),
      ),
    );

    const read = yield* readChromeProfile({ databasePaths: profile.databasePaths, keys });
    const result = yield* saveRead({
      read,
      sourceId: "chrome",
      onlyWhileChromeSyncs: false,
      unlessClearedSince: clears,
      keepSavedInBusyboy: false,
    });
    yield* vault
      .setChromeSync(
        { profileDirectory: profile.directory, keys: encodeChromiumKeys(keys) },
        { unlessClearedSince: clears },
      )
      .pipe(Effect.mapError(vaultFailure("chrome")));
    yield* Ref.set(lastChromeSync, yield* Clock.currentTimeMillis);
    return result;
  });

  /** Re-reads the synced Chrome profile with the kept key; never prompts. */
  const syncChrome = Effect.gen(function* () {
    const sync = yield* vault.chromeSync.pipe(Effect.mapError(vaultFailure("chrome")));
    if (sync === null) {
      return;
    }

    const { profile } = yield* findChromeProfile(sync.profileDirectory);
    const read = yield* readChromeProfile({
      databasePaths: profile.databasePaths,
      keys: decodeChromiumKeys(sync.keys),
    });
    // Chrome changed its key (a reinstall or profile reset): saving nothing
    // beats saving undecryptable rows, and a new import from Settings fixes it.
    if (read.passwords.length === 0 && read.skipped > 0) {
      return yield* new PasswordImportFailedError({ sourceId: "chrome", reason: "readFailed" });
    }

    const result = yield* saveRead({
      read,
      sourceId: "chrome",
      onlyWhileChromeSyncs: true,
      keepSavedInBusyboy: true,
    });
    yield* Ref.set(lastChromeSync, yield* Clock.currentTimeMillis);
    if (result.imported > 0 || result.updated > 0) {
      yield* Effect.logInfo("Synced passwords from Chrome", {
        imported: result.imported,
        updated: result.updated,
      });
    }
  }).pipe(
    Effect.catch((error) => Effect.logWarning(error.message, { cause: error.cause })),
    Effect.withSpan("PasswordImport.syncChrome"),
  );

  yield* Effect.sleep(CHROME_SYNC_STARTUP_DELAY).pipe(
    Effect.andThen(syncChrome),
    Effect.andThen(
      Effect.sleep(CHROME_SYNC_INTERVAL).pipe(Effect.andThen(syncChrome), Effect.forever),
    ),
    Effect.forkScoped,
  );

  const stopChromeSync = vault
    .setChromeSync(null)
    .pipe(Effect.mapError(vaultFailure("chrome")), Effect.andThen(Ref.set(lastChromeSync, null)));

  const status = Effect.gen(function* () {
    const count = yield* vault.count;
    const sync = yield* vault.chromeSync;
    if (sync === null) {
      return { count, chromeSync: null };
    }
    const profile = (yield* chromeProfiles).find(
      (candidate) => candidate.directory === sync.profileDirectory,
    );
    return {
      count,
      chromeSync: {
        profileName: profile?.name ?? sync.profileDirectory,
        lastSyncedAt: yield* Ref.get(lastChromeSync),
      },
    };
  }).pipe(Effect.mapError(vaultFailure("chrome"))) satisfies Effect.Effect<
    SavedPasswordStatus,
    PasswordImportFailedError
  >;

  const importFile = Effect.fn("PasswordImport.importFile")(function* ({
    sourceId,
    filePath,
  }: {
    readonly sourceId: PasswordFileImportSourceId;
    readonly filePath: string;
  }) {
    const info = yield* fileSystem
      .stat(filePath)
      .pipe(
        Effect.mapError(
          (cause) => new PasswordImportFailedError({ sourceId, reason: "readFailed", cause }),
        ),
      );
    if (info.type !== "File" || Number(info.size) > MAX_PASSWORD_FILE_BYTES) {
      return yield* new PasswordImportFailedError({ sourceId, reason: "invalidFile" });
    }

    const text = yield* fileSystem
      .readFileString(filePath)
      .pipe(
        Effect.mapError(
          (cause) => new PasswordImportFailedError({ sourceId, reason: "readFailed", cause }),
        ),
      );
    const read = readPasswordCsv(text);
    if (read === undefined) {
      return yield* new PasswordImportFailedError({ sourceId, reason: "invalidFile" });
    }

    return yield* saveRead({
      read,
      sourceId,
      onlyWhileChromeSyncs: false,
      keepSavedInBusyboy: false,
    });
  });

  return PasswordImport.of({ chromeSource, importChrome, stopChromeSync, importFile, status });
});

export const layer = Layer.effect(PasswordImport, make);
