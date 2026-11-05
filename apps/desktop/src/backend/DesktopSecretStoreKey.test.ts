import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSecretStoreKey from "./DesktopSecretStoreKey.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

interface FakeSafeStorage {
  readonly available?: boolean;
  readonly backend?: Option.Option<string>;
  readonly failDecrypt?: boolean;
}

function layerSafeStorage(options: FakeSafeStorage) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(options.available ?? true),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
    decryptString: (value) => {
      const decoded = textDecoder.decode(value);
      return options.failDecrypt || !decoded.startsWith("encrypted:")
        ? Effect.fail(
            new ElectronSafeStorage.ElectronSafeStorageDecryptError({
              cause: new Error("keychain denied"),
            }),
          )
        : Effect.succeed(decoded.slice("encrypted:".length));
    },
    selectedStorageBackend: Effect.succeed(options.backend ?? Option.none()),
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

function layerFor(baseDir: string, platform: NodeJS.Platform, safeStorage: FakeSafeStorage) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform,
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ BUSYBOY_HOME: baseDir })),
    ),
  );
  return DesktopSecretStoreKey.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(layerEnvironment, layerSafeStorage(safeStorage), NodeServices.layer),
    ),
  );
}

/** Builds a fresh service instance (a new app run) over `baseDir`. */
const resolveKey = (
  baseDir: string,
  safeStorage: FakeSafeStorage = {},
  platform: NodeJS.Platform = "darwin",
) =>
  Effect.gen(function* () {
    const service = yield* DesktopSecretStoreKey.DesktopSecretStoreKey;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const path = yield* Path.Path;
    const key = yield* service.get;
    return {
      key,
      keyPath: path.join(environment.stateDir, DesktopSecretStoreKey.SECRET_STORE_KEY_FILE_NAME),
    };
  }).pipe(Effect.provide(layerFor(baseDir, platform, safeStorage)));

const withTempDir = <A, E, R>(f: (baseDir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-secret-store-key-test-",
    });
    return yield* f(baseDir);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("DesktopSecretStoreKey", () => {
  it.effect("creates a 32-byte key, stores it encrypted, and reuses it on the next run", () =>
    withTempDir((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const first = yield* resolveKey(baseDir);
        assert.isTrue(Option.isSome(first.key));
        const key = Option.getOrThrow(first.key);
        assert.equal(Buffer.from(key, "base64").length, 32);

        const raw = yield* fileSystem.readFileString(first.keyPath);
        const document = JSON.parse(raw);
        assert.equal(document.version, 1);
        assert.notInclude(raw, key);
        assert.equal(
          Buffer.from(document.encryptedKey, "base64").toString("utf8"),
          `encrypted:${key}`,
        );
        const stat = yield* fileSystem.stat(first.keyPath);
        assert.equal(stat.mode & 0o777, 0o600);

        const second = yield* resolveKey(baseDir);
        assert.deepStrictEqual(second.key, Option.some(key));
      }),
    ),
  );

  it.effect("returns the same key to concurrent callers in one run", () =>
    withTempDir((baseDir) =>
      Effect.gen(function* () {
        const service = yield* DesktopSecretStoreKey.DesktopSecretStoreKey;
        const keys = yield* Effect.all([service.get, service.get, service.get], {
          concurrency: "unbounded",
        });
        assert.isTrue(Option.isSome(keys[0]));
        assert.deepStrictEqual(keys[1], keys[0]);
        assert.deepStrictEqual(keys[2], keys[0]);
      }).pipe(Effect.provide(layerFor(baseDir, "darwin", {}))),
    ),
  );

  it.effect("returns no key and writes nothing when encryption is unavailable", () =>
    withTempDir((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const result = yield* resolveKey(baseDir, { available: false });
        assert.isTrue(Option.isNone(result.key));
        assert.isFalse(yield* fileSystem.exists(result.keyPath));
      }),
    ),
  );

  it.effect("returns no key on Linux when safe storage falls back to basic_text", () =>
    withTempDir((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const result = yield* resolveKey(baseDir, { backend: Option.some("basic_text") }, "linux");
        assert.isTrue(Option.isNone(result.key));
        assert.isFalse(yield* fileSystem.exists(result.keyPath));

        const unknown = yield* resolveKey(baseDir, { backend: Option.none() }, "linux");
        assert.isTrue(Option.isNone(unknown.key));
      }),
    ),
  );

  it.effect("uses a Linux keyring backend", () =>
    withTempDir((baseDir) =>
      Effect.gen(function* () {
        const result = yield* resolveKey(
          baseDir,
          { backend: Option.some("gnome_libsecret") },
          "linux",
        );
        assert.isTrue(Option.isSome(result.key));
      }),
    ),
  );

  it.effect("returns no key and leaves the file untouched when decryption fails", () =>
    withTempDir((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const created = yield* resolveKey(baseDir);
        const before = yield* fileSystem.readFileString(created.keyPath);

        const denied = yield* resolveKey(baseDir, { failDecrypt: true });
        assert.isTrue(Option.isNone(denied.key));
        assert.equal(yield* fileSystem.readFileString(created.keyPath), before);

        // A later launch with a working keychain gets the original key back.
        const recovered = yield* resolveKey(baseDir);
        assert.deepStrictEqual(recovered.key, created.key);
      }),
    ),
  );

  it.effect("returns no key and leaves a malformed file untouched", () =>
    withTempDir((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const created = yield* resolveKey(baseDir);
        yield* fileSystem.makeDirectory(path.dirname(created.keyPath), { recursive: true });
        yield* fileSystem.writeFileString(created.keyPath, "{not-json");

        const result = yield* resolveKey(baseDir);
        assert.isTrue(Option.isNone(result.key));
        assert.equal(yield* fileSystem.readFileString(created.keyPath), "{not-json");
      }),
    ),
  );
});
