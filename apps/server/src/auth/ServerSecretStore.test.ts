import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layerServerConfig = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-store-test-" });

const layerServerSecretStore = () => Layer.provide(ServerSecretStore.layer, layerServerConfig());

const layerPermissionDeniedFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      readFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: path,
            description: "Permission denied while reading secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerPermissionDeniedSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerPermissionDeniedFileSystem),
  );

const layerRenameFailureFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      rename: (from, to) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: `${String(from)} -> ${String(to)}`,
            description: "Permission denied while persisting secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerRenameFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRenameFailureFileSystem),
  );

const layerRemoveFailureFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      remove: (path, options) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: String(path),
            description: `Permission denied while removing secret file.${options ? " options-set" : ""}`,
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerRemoveFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRemoveFailureFileSystem),
  );

const layerConcurrentReadMissFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const readCountRef = yield* Ref.make(0);
    const readBarrier = yield* Deferred.make<void>();

    return {
      ...fileSystem,
      readFile: (path) =>
        /[\\/]session-signing-key\.bin$/.test(String(path))
          ? Ref.updateAndGet(readCountRef, (count) => count + 1).pipe(
              Effect.flatMap((count) => {
                if (count > 2) {
                  return fileSystem.readFile(path);
                }
                return Effect.gen(function* () {
                  if (count === 2) {
                    yield* Deferred.succeed(readBarrier, void 0);
                  }
                  yield* Deferred.await(readBarrier);
                  return yield* Effect.failCause(
                    Cause.fail(
                      PlatformError.systemError({
                        _tag: "NotFound",
                        module: "FileSystem",
                        method: "readFile",
                        pathOrDescriptor: String(path),
                        description: "Secret file does not exist yet.",
                      }),
                    ),
                  );
                });
              }),
            )
          : fileSystem.readFile(path),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerConcurrentCreateSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerConcurrentReadMissFileSystem),
  );

it.layer(NodeServices.layer)("ServerSecretStore.layer", (it) => {
  it.effect("returns Option.none when a secret file does not exist", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const secret = yield* secretStore.get("missing-secret");

      assert.isTrue(Option.isNone(secret));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("returns the persisted secret when concurrent creators race", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const [first, second] = yield* Effect.all(
        [
          secretStore.getOrCreateRandom("session-signing-key", 32),
          secretStore.getOrCreateRandom("session-signing-key", 32),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = yield* secretStore.get("session-signing-key");
      const persistedBytes = Option.getOrThrow(persisted);

      assert.deepEqual(Array.from(first), Array.from(persistedBytes));
      assert.deepEqual(Array.from(second), Array.from(persistedBytes));
    }).pipe(Effect.provide(layerConcurrentCreateSecretStore())),
  );

  it.effect("uses restrictive permissions for the secret directory and files", () =>
    Effect.gen(function* () {
      const chmodCalls: Array<{ readonly path: string; readonly mode: number }> = [];
      const layerRecordingFileSystem = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;

          return {
            ...fileSystem,
            makeDirectory: () => Effect.void,
            writeFile: () => Effect.void,
            rename: () => Effect.void,
            chmod: (path, mode) =>
              Effect.sync(() => {
                chmodCalls.push({ path: String(path), mode });
              }),
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer));

      const secretStore = yield* Effect.service(ServerSecretStore.ServerSecretStore).pipe(
        Effect.provide(
          ServerSecretStore.layer.pipe(
            Layer.provide(layerServerConfig()),
            Layer.provideMerge(layerRecordingFileSystem),
          ),
        ),
      );

      yield* secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3]));

      assert.isTrue(
        chmodCalls.some((call) => call.mode === 0o700 && /[\\/]secrets$/.test(call.path)),
      );
      assert.isAtLeast(chmodCalls.filter((call) => call.mode === 0o600).length, 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));

      assert.instanceOf(error, ServerSecretStore.SecretStoreReadError);
      assert.include(error.message, "Failed to read secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerPermissionDeniedSecretStore())),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(
        secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3])),
      );

      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.include(error.message, "Failed to persist secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerRenameFailureSecretStore())),
  );

  it.effect("propagates remove failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.remove("session-signing-key"));

      assert.instanceOf(error, ServerSecretStore.SecretStoreRemoveError);
      assert.include(error.message, "Failed to remove secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerRemoveFailureSecretStore())),
  );
});

const encryptionKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const otherEncryptionKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const textEncoder = new TextEncoder();

const makeStoreAt = (baseDir: string, key?: Uint8Array) =>
  Effect.service(ServerSecretStore.ServerSecretStore).pipe(
    Effect.provide(
      ServerSecretStore.layer.pipe(
        Layer.provide(
          ServerConfig.layerTest(
            process.cwd(),
            baseDir,
            key === undefined ? undefined : { secretStoreKey: Redacted.make(key) },
          ),
        ),
      ),
    ),
  );

const makeBaseDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-secret-store-encrypted-test-" });
});

const listSecrets = (directory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return [...(yield* fileSystem.readDirectory(directory))].sort();
  });

it.layer(NodeServices.layer)("ServerSecretStore.layer with a keychain key", (it) => {
  it.effect("stores secrets encrypted and reads them back", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const store = yield* makeStoreAt(yield* makeBaseDir, encryptionKey);
      const directory = store.directory!;
      const plaintext = textEncoder.encode("super-secret-provider-token");

      yield* store.set("provider-token", plaintext);

      assert.deepEqual(yield* listSecrets(directory), ["provider-token.enc"]);
      const onDisk = yield* fileSystem.readFile(`${directory}/provider-token.enc`);
      assert.isFalse(Buffer.from(onDisk).includes(Buffer.from(plaintext)));
      const read = yield* store.get("provider-token");
      assert.deepEqual(Array.from(Option.getOrThrow(read)), Array.from(plaintext));
    }),
  );

  it.effect("encrypts plaintext secrets left by older builds at startup", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* makeBaseDir;
      const plaintextStore = yield* makeStoreAt(baseDir);
      const directory = plaintextStore.directory!;
      const plaintext = textEncoder.encode("legacy-signing-key");
      yield* plaintextStore.set("session-signing-key", plaintext);
      yield* fileSystem.writeFile(`${directory}/other.bin.stale.tmp`, plaintext);

      const encryptedStore = yield* makeStoreAt(baseDir, encryptionKey);

      assert.deepEqual(yield* listSecrets(directory), ["session-signing-key.enc"]);
      const read = yield* encryptedStore.get("session-signing-key");
      assert.deepEqual(Array.from(Option.getOrThrow(read)), Array.from(plaintext));
    }),
  );

  it.effect("encrypts a plaintext secret that appears after startup when it is read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const store = yield* makeStoreAt(yield* makeBaseDir, encryptionKey);
      const directory = store.directory!;
      const plaintext = textEncoder.encode("late-legacy-secret");
      yield* fileSystem.writeFile(`${directory}/late.bin`, plaintext);

      const read = yield* store.get("late");

      assert.deepEqual(Array.from(Option.getOrThrow(read)), Array.from(plaintext));
      assert.deepEqual(yield* listSecrets(directory), ["late.enc"]);
    }),
  );

  it.effect("treats a plaintext secret as existing when creating exclusively", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const store = yield* makeStoreAt(yield* makeBaseDir, encryptionKey);
      const directory = store.directory!;
      const plaintext = textEncoder.encode("existing-secret");
      yield* fileSystem.writeFile(`${directory}/existing.bin`, plaintext);

      const error = yield* Effect.flip(store.create("existing", textEncoder.encode("new")));

      assert.isTrue(ServerSecretStore.isSecretAlreadyExistsError(error));
      const read = yield* store.get("existing");
      assert.deepEqual(Array.from(Option.getOrThrow(read)), Array.from(plaintext));
    }),
  );

  it.effect("fails to decode with the wrong key instead of reporting the secret missing", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir;
      const store = yield* makeStoreAt(baseDir, encryptionKey);
      yield* store.getOrCreateRandom("session-signing-key", 32);

      const wrongKeyStore = yield* makeStoreAt(baseDir, otherEncryptionKey);

      const getError = yield* Effect.flip(wrongKeyStore.get("session-signing-key"));
      assert.instanceOf(getError, ServerSecretStore.SecretStoreDecodeError);
      const createError = yield* Effect.flip(
        wrongKeyStore.getOrCreateRandom("session-signing-key", 32),
      );
      assert.instanceOf(createError, ServerSecretStore.SecretStoreDecodeError);
    }),
  );

  it.effect("keeps a generated secret stable across store instances", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir;
      const first = yield* (yield* makeStoreAt(baseDir, encryptionKey)).getOrCreateRandom(
        "session-signing-key",
        32,
      );
      const second = yield* (yield* makeStoreAt(baseDir, encryptionKey)).getOrCreateRandom(
        "session-signing-key",
        32,
      );

      assert.deepEqual(Array.from(second), Array.from(first));
    }),
  );

  it.effect("removes both encrypted and plaintext copies", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const store = yield* makeStoreAt(yield* makeBaseDir, encryptionKey);
      const directory = store.directory!;
      yield* store.set("token", textEncoder.encode("value"));
      yield* fileSystem.writeFile(`${directory}/token.bin`, textEncoder.encode("value"));

      yield* store.remove("token");

      assert.deepEqual(yield* listSecrets(directory), []);
    }),
  );

  it.effect("refuses encrypted secrets when started without the key", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeBaseDir;
      const encryptedStore = yield* makeStoreAt(baseDir, encryptionKey);
      const signingKey = yield* encryptedStore.getOrCreateRandom("session-signing-key", 32);

      const plaintextStore = yield* makeStoreAt(baseDir);

      const getError = yield* Effect.flip(plaintextStore.get("session-signing-key"));
      assert.instanceOf(getError, ServerSecretStore.SecretStoreKeyUnavailableError);
      assert.include(getError.message, "start BusyBoy from the desktop app");
      const createError = yield* Effect.flip(
        plaintextStore.getOrCreateRandom("session-signing-key", 32),
      );
      assert.instanceOf(createError, ServerSecretStore.SecretStoreKeyUnavailableError);
      assert.deepEqual(yield* listSecrets(encryptedStore.directory!), ["session-signing-key.enc"]);
      const read = yield* encryptedStore.get("session-signing-key");
      assert.deepEqual(Array.from(Option.getOrThrow(read)), Array.from(signingKey));
    }),
  );
});
