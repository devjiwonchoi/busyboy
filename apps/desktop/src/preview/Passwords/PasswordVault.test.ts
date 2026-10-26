import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../../electron/ElectronSafeStorage.ts";
import * as PasswordVault from "./PasswordVault.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const vaultLayer = ({
  baseDir,
  encryptionAvailable,
}: {
  readonly baseDir: string;
  readonly encryptionAvailable: boolean;
}) =>
  PasswordVault.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/src",
          homeDirectory: baseDir,
          platform: "darwin",
          processArch: "arm64",
          appVersion: "1.2.3",
          appPath: "/repo",
          isPackaged: true,
          resourcesPath: "/missing/resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
          ),
        ),
        Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
          isEncryptionAvailable: Effect.succeed(encryptionAvailable),
          encryptString: (value) => Effect.succeed(textEncoder.encode(`sealed:${value}`)),
          decryptString: (value) =>
            Effect.succeed(textDecoder.decode(value).slice("sealed:".length)),
          selectedStorageBackend: Effect.succeedNone,
        } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]),
        NodeServices.layer,
      ),
    ),
  );

const github = { origin: "https://github.com", username: "octo", password: "one" };
const example = { origin: "https://example.com", username: "me", password: "two" };

describe("PasswordVault", () => {
  it.effect("saves, updates, survives a restart and clears", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-password-vault-" });
      const layer = vaultLayer({ baseDir, encryptionAvailable: true });

      yield* Effect.gen(function* () {
        const vault = yield* PasswordVault.PasswordVault;
        expect(yield* vault.count).toBe(0);
        expect(
          yield* vault.save({
            passwords: [github, example],
            source: "chrome",
            onlyWhileChromeSyncs: false,
          }),
        ).toEqual({
          imported: 2,
          updated: 0,
        });
        // Same login again with a new password replaces it rather than adding one.
        expect(
          yield* vault.save({
            passwords: [{ ...github, password: "changed" }, example],
            source: "1password",
            onlyWhileChromeSyncs: false,
          }),
        ).toEqual({ imported: 0, updated: 1 });
      }).pipe(Effect.provide(layer));

      const chromeSync = { profileDirectory: "Default", keys: { cbcV10: "a2V5" } };
      yield* Effect.gen(function* () {
        const vault = yield* PasswordVault.PasswordVault;
        yield* vault.setChromeSync(chromeSync);
      }).pipe(Effect.provide(layer));

      // A fresh service instance reads what the previous one wrote.
      yield* Effect.gen(function* () {
        const vault = yield* PasswordVault.PasswordVault;
        expect(yield* vault.count).toBe(2);
        expect(yield* vault.chromeSync).toEqual(chromeSync);
        // Clearing also forgets the Chrome sync, so cleared logins stay gone.
        yield* vault.clear;
        expect(yield* vault.count).toBe(0);
        expect(yield* vault.chromeSync).toBeNull();
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads a vault written before Chrome sync existed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-password-vault-" });
      const legacy = JSON.stringify([{ ...github, source: "chrome", savedAt: 1 }]);
      const encrypted = Buffer.from(`sealed:${legacy}`).toString("base64");
      const environment = yield* Effect.gen(function* () {
        return yield* DesktopEnvironment.DesktopEnvironment;
      }).pipe(Effect.provide(vaultLayer({ baseDir, encryptionAvailable: true })));
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
      yield* fileSystem.writeFileString(
        `${environment.stateDir}/preview-passwords.json`,
        JSON.stringify({ version: 1, encryptedPasswords: encrypted }),
      );

      yield* Effect.gen(function* () {
        const vault = yield* PasswordVault.PasswordVault;
        expect(yield* vault.count).toBe(1);
        expect(yield* vault.chromeSync).toBeNull();
      }).pipe(Effect.provide(vaultLayer({ baseDir, encryptionAvailable: true })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to save when the OS cannot encrypt", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-password-vault-" });

      const error = yield* Effect.gen(function* () {
        const vault = yield* PasswordVault.PasswordVault;
        return yield* Effect.flip(
          vault.save({ passwords: [github], source: "chrome", onlyWhileChromeSyncs: false }),
        );
      }).pipe(Effect.provide(vaultLayer({ baseDir, encryptionAvailable: false })));

      expect(error.reason).toBe("encryptionUnavailable");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
