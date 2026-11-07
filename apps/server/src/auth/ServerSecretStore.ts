// @effect-diagnostics nodeBuiltinImport:off - AES-256-GCM is not available from effect/Crypto.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const secretStoreErrorContext = {
  resource: Schema.String,
  cause: Schema.Defect(),
};

export class SecretStoreSecureError extends Schema.TaggedError<SecretStoreSecureError>()(
  "SecretStoreSecureError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to secure ${this.resource}.`;
  }
}

export class SecretStoreReadError extends Schema.TaggedError<SecretStoreReadError>()(
  "SecretStoreReadError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource}.`;
  }
}

export class SecretStoreTemporaryPathError extends Schema.TaggedError<SecretStoreTemporaryPathError>()(
  "SecretStoreTemporaryPathError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to create temporary path for ${this.resource}.`;
  }
}

export class SecretStorePersistError extends Schema.TaggedError<SecretStorePersistError>()(
  "SecretStorePersistError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to persist ${this.resource}.`;
  }
}

export class SecretStoreRandomGenerationError extends Schema.TaggedError<SecretStoreRandomGenerationError>()(
  "SecretStoreRandomGenerationError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to generate random bytes for ${this.resource}.`;
  }
}

export class SecretStoreConcurrentReadError extends Schema.TaggedError<SecretStoreConcurrentReadError>()(
  "SecretStoreConcurrentReadError",
  {
    resource: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to read ${this.resource} after concurrent creation.`;
  }
}

export class SecretStoreRemoveError extends Schema.TaggedError<SecretStoreRemoveError>()(
  "SecretStoreRemoveError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to remove ${this.resource}.`;
  }
}

export class SecretStoreDecodeError extends Schema.TaggedError<SecretStoreDecodeError>()(
  "SecretStoreDecodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to decode ${this.resource}.`;
  }
}

export class SecretStoreEncodeError extends Schema.TaggedError<SecretStoreEncodeError>()(
  "SecretStoreEncodeError",
  {
    ...secretStoreErrorContext,
  },
) {
  override get message(): string {
    return `Failed to encode ${this.resource}.`;
  }
}

export class SecretStoreKeyUnavailableError extends Schema.TaggedError<SecretStoreKeyUnavailableError>()(
  "SecretStoreKeyUnavailableError",
  {
    resource: Schema.String,
  },
) {
  override get message(): string {
    return `${this.resource} is encrypted with the desktop keychain key; start BusyBoy from the desktop app.`;
  }
}

export const SecretStoreError = Schema.Union([
  SecretStoreSecureError,
  SecretStoreReadError,
  SecretStoreTemporaryPathError,
  SecretStorePersistError,
  SecretStoreRandomGenerationError,
  SecretStoreConcurrentReadError,
  SecretStoreRemoveError,
  SecretStoreDecodeError,
  SecretStoreEncodeError,
  SecretStoreKeyUnavailableError,
]);
export type SecretStoreError = typeof SecretStoreError.Type;
export const isSecretStoreError = Schema.is(SecretStoreError);

const isPlatformError = (value: unknown): value is PlatformError.PlatformError =>
  Predicate.isTagged(value, "PlatformError");

export const isSecretAlreadyExistsError = (error: SecretStoreError): boolean =>
  "cause" in error && isPlatformError(error.cause) && error.cause.reason._tag === "AlreadyExists";

export class ServerSecretStore extends Context.Service<
  ServerSecretStore,
  {
    readonly directory?: string;
    readonly get: (name: string) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreError>;
    readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly create: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
    readonly getOrCreateRandom: (
      name: string,
      bytes: number,
    ) => Effect.Effect<Uint8Array, SecretStoreError>;
    readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
  }
>()("t3/auth/ServerSecretStore") {}

// Encrypted secret file layout (`<name>.enc`):
//   1 byte version (0x01) | 12 byte IV | AES-256-GCM ciphertext | 16 byte tag
// The AAD binds the ciphertext to its secret name, so files cannot be swapped.
const ENCRYPTED_FORMAT_VERSION = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES;
const LEGACY_EXTENSION = ".bin";
const ENCRYPTED_EXTENSION = ".enc";

const additionalData = (name: string) => Buffer.from(`busyboy-secret:v1:${name}`, "utf8");

const encryptSecret = (key: Uint8Array, name: string, value: Uint8Array) =>
  Effect.try({
    try: () => {
      const iv = NodeCrypto.randomBytes(IV_BYTES);
      const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv, {
        authTagLength: TAG_BYTES,
      });
      cipher.setAAD(additionalData(name));
      const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
      return Uint8Array.from(
        Buffer.concat([Buffer.of(ENCRYPTED_FORMAT_VERSION), iv, ciphertext, cipher.getAuthTag()]),
      );
    },
    catch: (cause) => new SecretStoreEncodeError({ resource: `secret ${name}`, cause }),
  });

const decryptSecret = (key: Uint8Array, name: string, payload: Uint8Array) =>
  Effect.try({
    try: () => {
      if (payload.length < HEADER_BYTES + TAG_BYTES) {
        throw new Error("Encrypted secret is truncated.");
      }
      if (payload[0] !== ENCRYPTED_FORMAT_VERSION) {
        throw new Error(`Unsupported encrypted secret version ${payload[0]}.`);
      }
      const iv = payload.subarray(1, HEADER_BYTES);
      const ciphertext = payload.subarray(HEADER_BYTES, payload.length - TAG_BYTES);
      const tag = payload.subarray(payload.length - TAG_BYTES);
      const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(additionalData(name));
      decipher.setAuthTag(tag);
      return Uint8Array.from(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    },
    catch: (cause) => new SecretStoreDecodeError({ resource: `secret ${name}`, cause }),
  });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const key =
    serverConfig.secretStoreKey === undefined
      ? undefined
      : Redacted.value(serverConfig.secretStoreKey);

  yield* fileSystem.makeDirectory(serverConfig.secretsDir, { recursive: true });
  yield* fileSystem.chmod(serverConfig.secretsDir, 0o700).pipe(
    Effect.mapError(
      (cause) =>
        new SecretStoreSecureError({
          resource: `secrets directory ${serverConfig.secretsDir}`,
          cause,
        }),
    ),
  );

  const legacyPath = (name: string) =>
    path.join(serverConfig.secretsDir, `${name}${LEGACY_EXTENSION}`);
  const encryptedPath = (name: string) =>
    path.join(serverConfig.secretsDir, `${name}${ENCRYPTED_EXTENSION}`);

  const readOptional = (
    filePath: string,
    name: string,
  ): Effect.Effect<Option.Option<Uint8Array>, SecretStoreReadError> =>
    fileSystem.readFile(filePath).pipe(
      Effect.map((bytes): Option.Option<Uint8Array> => Option.some(Uint8Array.from(bytes))),
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeedNone
          : Effect.fail(
              new SecretStoreReadError({
                resource: `secret ${name}`,
                cause,
              }),
            ),
      ),
    );

  const removeOptional = (
    filePath: string,
    name: string,
  ): Effect.Effect<void, SecretStoreRemoveError> =>
    fileSystem.remove(filePath).pipe(
      Effect.catch((cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.void
          : Effect.fail(
              new SecretStoreRemoveError({
                resource: `secret ${name}`,
                cause,
              }),
            ),
      ),
    );

  const makeTempPath = (secretPath: string, name: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((uuid) => `${secretPath}.${uuid}.tmp`),
      Effect.mapError(
        (cause) =>
          new SecretStoreTemporaryPathError({
            resource: `secret ${name}`,
            cause,
          }),
      ),
    );

  // Writes `value` to a private temp file, then publishes it at `secretPath`.
  // `exclusive` publishes with a hard link, which fails AlreadyExists without
  // replacing an existing file; otherwise the temp file replaces it by rename.
  const writeSecretFile = (
    secretPath: string,
    name: string,
    value: Uint8Array,
    exclusive: boolean,
  ) =>
    makeTempPath(secretPath, name).pipe(
      Effect.flatMap((tempPath) =>
        Effect.gen(function* () {
          yield* fileSystem.writeFile(tempPath, value, { mode: 0o600 });
          yield* fileSystem.chmod(tempPath, 0o600);
          if (exclusive) {
            yield* fileSystem.link(tempPath, secretPath);
            yield* fileSystem.remove(tempPath).pipe(Effect.ignore);
          } else {
            yield* fileSystem.rename(tempPath, secretPath);
          }
          yield* fileSystem.chmod(secretPath, 0o600);
        }).pipe(
          Effect.catch((cause) =>
            fileSystem.remove(tempPath).pipe(
              Effect.ignore,
              Effect.flatMap(() =>
                Effect.fail(
                  new SecretStorePersistError({
                    resource: `secret ${name}`,
                    cause,
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );

  // ---- Plaintext mode: no keychain key, behaves like the original store. ----

  // Without the key, a secret that only exists encrypted must not read as
  // missing: callers would regenerate it (e.g. the session signing key).
  const failIfEncrypted = Effect.fn("ServerSecretStore.failIfEncrypted")(function* (name: string) {
    const encrypted = yield* fileSystem
      .exists(encryptedPath(name))
      .pipe(
        Effect.mapError((cause) => new SecretStoreReadError({ resource: `secret ${name}`, cause })),
      );
    if (encrypted) {
      return yield* new SecretStoreKeyUnavailableError({ resource: `secret ${name}` });
    }
  });

  const plaintextGet = Effect.fn(function* (name: string) {
    const value = yield* readOptional(legacyPath(name), name);
    if (Option.isNone(value)) {
      yield* failIfEncrypted(name);
    }
    return value;
  });

  const plaintextSet = Effect.fn(function* (name: string, value: Uint8Array) {
    yield* failIfEncrypted(name);
    yield* writeSecretFile(legacyPath(name), name, value, false);
  });

  const plaintextCreate = Effect.fn(function* (name: string, value: Uint8Array) {
    yield* failIfEncrypted(name);
    const secretPath = legacyPath(name);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(secretPath, {
          flag: "wx",
          mode: 0o600,
        });
        yield* file.writeAll(value);
        yield* file.sync;
        yield* fileSystem.chmod(secretPath, 0o600);
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SecretStorePersistError({
            resource: `secret ${name}`,
            cause,
          }),
      ),
    );
  });

  // ---- Encrypted mode: secrets live in `<name>.enc`. ----

  const readEncrypted = Effect.fn(function* (encryptionKey: Uint8Array, name: string) {
    const payload = yield* readOptional(encryptedPath(name), name);
    if (Option.isNone(payload)) {
      return Option.none<Uint8Array>();
    }
    return Option.some(yield* decryptSecret(encryptionKey, name, payload.value));
  });

  // Moves a plaintext `<name>.bin` into `<name>.enc` and deletes the plaintext.
  // An existing `.enc` wins: plaintext only coexists with it after an
  // interrupted migration of the same value. Returns whether a legacy file was found.
  const migrateLegacy = Effect.fn(function* (encryptionKey: Uint8Array, name: string) {
    const plaintext = yield* readOptional(legacyPath(name), name);
    if (Option.isNone(plaintext)) {
      return false;
    }
    const payload = yield* encryptSecret(encryptionKey, name, plaintext.value);
    yield* writeSecretFile(encryptedPath(name), name, payload, true).pipe(
      Effect.catchIf(isSecretAlreadyExistsError, () => Effect.void),
    );
    yield* removeOptional(legacyPath(name), name);
    return true;
  });

  const encryptedGet = Effect.fn(function* (encryptionKey: Uint8Array, name: string) {
    const value = yield* readEncrypted(encryptionKey, name);
    if (Option.isSome(value)) {
      return value;
    }
    const migrated = yield* migrateLegacy(encryptionKey, name);
    return migrated ? yield* readEncrypted(encryptionKey, name) : Option.none<Uint8Array>();
  });

  const encryptedSet = Effect.fn(function* (
    encryptionKey: Uint8Array,
    name: string,
    value: Uint8Array,
  ) {
    const payload = yield* encryptSecret(encryptionKey, name, value);
    yield* writeSecretFile(encryptedPath(name), name, payload, false);
    yield* removeOptional(legacyPath(name), name);
  });

  const encryptedCreate = Effect.fn(function* (
    encryptionKey: Uint8Array,
    name: string,
    value: Uint8Array,
  ) {
    // Migrating first makes a legacy `.bin` count as an existing secret, so the
    // exclusive publish below fails AlreadyExists for it too.
    yield* migrateLegacy(encryptionKey, name);
    const payload = yield* encryptSecret(encryptionKey, name, value);
    yield* writeSecretFile(encryptedPath(name), name, payload, true);
  });

  const get: ServerSecretStore["Service"]["get"] = (name) => {
    const effect: Effect.Effect<Option.Option<Uint8Array>, SecretStoreError> = key === undefined
      ? plaintextGet(name)
      : encryptedGet(key, name);
    return effect.pipe(Effect.withSpan("ServerSecretStore.get"));
  };

  const set: ServerSecretStore["Service"]["set"] = (name, value) => {
    const effect: Effect.Effect<void, SecretStoreError> =
      key === undefined ? plaintextSet(name, value) : encryptedSet(key, name, value);
    return effect.pipe(Effect.withSpan("ServerSecretStore.set"));
  };

  const create: ServerSecretStore["Service"]["create"] = (name, value) =>
    key === undefined ? plaintextCreate(name, value) : encryptedCreate(key, name, value);

  const getOrCreateRandom: ServerSecretStore["Service"]["getOrCreateRandom"] = (name, bytes) =>
    get(name).pipe(
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            crypto.randomBytes(bytes).pipe(
              Effect.mapError(
                (cause) =>
                  new SecretStoreRandomGenerationError({
                    resource: `secret ${name}`,
                    cause,
                  }),
              ),
              Effect.flatMap((generated) =>
                create(name, generated).pipe(
                  Effect.as(Uint8Array.from(generated)),
                  Effect.catchIf(isSecretStoreError, (error) =>
                    isSecretAlreadyExistsError(error)
                      ? get(name).pipe(
                          Effect.flatMap(
                            Option.match({
                              onSome: Effect.succeed,
                              onNone: () =>
                                Effect.fail(
                                  new SecretStoreConcurrentReadError({
                                    resource: `secret ${name}`,
                                  }),
                                ),
                            }),
                          ),
                        )
                      : Effect.fail(error),
                  ),
                ),
              ),
            ),
        }),
      ),
      Effect.withSpan("ServerSecretStore.getOrCreateRandom"),
    );

  const remove: ServerSecretStore["Service"]["remove"] = (name) =>
    (key === undefined
      ? removeOptional(legacyPath(name), name)
      : removeOptional(encryptedPath(name), name).pipe(
          Effect.andThen(removeOptional(legacyPath(name), name)),
        )
    ).pipe(Effect.withSpan("ServerSecretStore.remove"));

  // Encrypts every plaintext `<name>.bin` left by older builds. A failure on
  // one file is logged and skipped so startup still succeeds.
  const sweepLegacySecrets = (encryptionKey: Uint8Array) =>
    Effect.gen(function* () {
      const entries = yield* fileSystem
        .readDirectory(serverConfig.secretsDir)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to list secrets for encryption migration", { cause }).pipe(
              Effect.as([] as ReadonlyArray<string>),
            ),
          ),
        );
      let migrated = 0;
      for (const entry of entries) {
        // Temp files from interrupted plaintext writes hold plaintext too.
        if (entry.endsWith(".tmp") && entry.includes(`${LEGACY_EXTENSION}.`)) {
          yield* fileSystem.remove(path.join(serverConfig.secretsDir, entry)).pipe(Effect.ignore);
          continue;
        }
        if (!entry.endsWith(LEGACY_EXTENSION)) {
          continue;
        }
        const name = entry.slice(0, -LEGACY_EXTENSION.length);
        const succeeded = yield* migrateLegacy(encryptionKey, name).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to encrypt a plaintext secret", {
              secret: name,
              error: error.message,
            }).pipe(Effect.as(false)),
          ),
        );
        if (succeeded) {
          migrated += 1;
        }
      }
      if (migrated > 0) {
        yield* Effect.logInfo(`Encrypted ${migrated} plaintext secret(s) at rest`);
      }
    });

  if (key === undefined) {
    yield* Effect.logWarning(
      "Secrets are stored unencrypted because no OS keychain key was provided. Start BusyBoy from the desktop app to encrypt them.",
    );
  } else {
    yield* sweepLegacySecrets(key);
  }

  return ServerSecretStore.of({
    directory: serverConfig.secretsDir,
    get,
    set,
    create,
    getOrCreateRandom,
    remove,
  });
});

export const layer = Layer.effect(ServerSecretStore, make);
