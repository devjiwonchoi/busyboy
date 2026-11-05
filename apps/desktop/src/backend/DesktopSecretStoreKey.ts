import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

const KEY_BYTES = 32;
export const SECRET_STORE_KEY_FILE_NAME = "server-secret-key.json";

// Linux backends that do not protect the key with an OS keyring.
const UNPROTECTED_LINUX_BACKENDS = new Set(["basic_text", "unknown"]);

const SecretStoreKeyDocument = Schema.Struct({
  version: Schema.Literal(1),
  encryptedKey: Schema.String,
});
type SecretStoreKeyDocument = typeof SecretStoreKeyDocument.Type;

const SecretStoreKeyDocumentJson = fromLenientJson(SecretStoreKeyDocument);
const decodeDocumentJson = Schema.decodeEffect(SecretStoreKeyDocumentJson);
const encodeDocumentJson = Schema.encodeEffect(SecretStoreKeyDocumentJson);

const { logWarning } = DesktopObservability.makeComponentLogger("desktop-secret-store-key");

/**
 * The master key the server uses to encrypt its secret files. It is kept in
 * the state directory, encrypted by Electron safe storage (macOS Keychain,
 * Windows DPAPI, a Linux keyring), and handed to the server only through the
 * fd-3 bootstrap. `get` yields `None` when no keyring can protect the key or
 * the stored key cannot be read; it never fails.
 */
export class DesktopSecretStoreKey extends Context.Service<
  DesktopSecretStoreKey,
  {
    /** Standard base64 of the 32-byte key. Resolved once per app run. */
    readonly get: Effect.Effect<Option.Option<string>>;
  }
>()("@t3tools/desktop/backend/DesktopSecretStoreKey") {}

const isValidKey = (encoded: string): boolean => {
  const decoded = Base64.decode(encoded);
  return decoded._tag === "Success" && decoded.success.length === KEY_BYTES;
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const crypto = yield* Crypto.Crypto;
  const keyPath = path.join(environment.stateDir, SECRET_STORE_KEY_FILE_NAME);

  const unavailable = (reason: string, annotations: Record<string, unknown> = {}) =>
    logWarning(`server secrets stay unencrypted: ${reason}`, { keyPath, ...annotations }).pipe(
      Effect.as(Option.none<string>()),
    );

  const keyringAvailable = Effect.gen(function* () {
    const available = yield* safeStorage.isEncryptionAvailable.pipe(
      Effect.catch((error) =>
        logWarning("could not check safe storage availability", {
          keyPath,
          error: error.message,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!available) {
      return Option.some("safe storage encryption is unavailable");
    }
    if (environment.platform === "linux") {
      const backend = yield* safeStorage.selectedStorageBackend;
      if (Option.isNone(backend) || UNPROTECTED_LINUX_BACKENDS.has(backend.value)) {
        return Option.some(
          `safe storage uses no OS keyring (backend ${Option.getOrElse(backend, () => "none")})`,
        );
      }
    }
    return Option.none<string>();
  });

  const readExisting = (raw: string) =>
    Effect.gen(function* () {
      const document = yield* decodeDocumentJson(raw).pipe(Effect.option);
      if (Option.isNone(document)) {
        return yield* unavailable("the stored key file is malformed; leaving it untouched");
      }
      const encryptedKey = Base64.decode(document.value.encryptedKey);
      if (encryptedKey._tag === "Failure") {
        return yield* unavailable("the stored key file is malformed; leaving it untouched");
      }
      const decrypted = yield* safeStorage.decryptString(encryptedKey.success).pipe(Effect.option);
      if (Option.isNone(decrypted)) {
        return yield* unavailable(
          "safe storage could not decrypt the stored key; leaving it untouched",
        );
      }
      if (!isValidKey(decrypted.value)) {
        return yield* unavailable("the stored key has the wrong shape; leaving it untouched");
      }
      return Option.some(decrypted.value);
    });

  const writeDocument = (document: SecretStoreKeyDocument) =>
    Effect.gen(function* () {
      const encoded = yield* encodeDocumentJson(document);
      const suffix = Hex.encode(yield* crypto.randomBytes(8));
      const tempPath = `${keyPath}.${process.pid}.${suffix}.tmp`;
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
      yield* fileSystem
        .writeFileString(tempPath, `${encoded}\n`, { flag: "wx", mode: 0o600 })
        .pipe(
          Effect.andThen(fileSystem.rename(tempPath, keyPath)),
          Effect.ensuring(fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)),
        );
    });

  const createKey = Effect.gen(function* () {
    const key = Base64.encode(yield* crypto.randomBytes(KEY_BYTES));
    const encryptedKey = Base64.encode(yield* safeStorage.encryptString(key));
    yield* writeDocument({ version: 1, encryptedKey });
    return key;
  });

  const resolve = Effect.gen(function* () {
    const unprotected = yield* keyringAvailable;
    if (Option.isSome(unprotected)) {
      return yield* unavailable(unprotected.value);
    }
    const raw = yield* fileSystem.readFileString(keyPath).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeedNone,
      ),
      Effect.result,
    );
    if (raw._tag === "Failure") {
      return yield* unavailable("the stored key file could not be read; leaving it untouched", {
        error: raw.failure.message,
      });
    }
    if (Option.isSome(raw.success)) {
      return yield* readExisting(raw.success.value);
    }
    // Hand the server a key only once it is persisted: secrets encrypted with
    // a key that was never saved would be lost on the next launch.
    return yield* createKey.pipe(
      Effect.asSome,
      Effect.catch((error) =>
        unavailable("could not create and store a new key", { error: error.message }),
      ),
    );
  });

  // SynchronizedRef so concurrent callers agree on one result per app run.
  const resolved = yield* SynchronizedRef.make(Option.none<Option.Option<string>>());
  const get = SynchronizedRef.modifyEffect(resolved, (current) =>
    Option.match(current, {
      onSome: (key) => Effect.succeed([key, current] as const),
      onNone: () => resolve.pipe(Effect.map((key) => [key, Option.some(key)] as const)),
    }),
  ).pipe(Effect.withSpan("desktop.secretStoreKey.get"));

  return DesktopSecretStoreKey.of({ get });
});

export const layer = Layer.effect(DesktopSecretStoreKey, make);

export const layerTest = (key: Option.Option<string> = Option.none()) =>
  Layer.succeed(DesktopSecretStoreKey, DesktopSecretStoreKey.of({ get: Effect.succeed(key) }));
