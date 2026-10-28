import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { WebContents } from "electron";
import * as NodeEvents from "node:events";

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

/**
 * A preview webview: `request` plays the preload asking main for a fill, and
 * `click` and `type` play real input reaching the page.
 */
const fakeGuest = (origin: string) => {
  const events = new NodeEvents.EventEmitter();
  const mainFrame = { origin, isDestroyed: () => false };
  let serve: ((event: unknown, request: unknown) => Promise<unknown>) | undefined;
  const guest = Object.assign(events, {
    mainFrame,
    session: { isPersistent: () => true, webRequest: { onBeforeRequest: () => {} } },
    ipc: {
      handle: (_channel: string, handler: typeof serve) => {
        serve = handler;
      },
      removeHandler: () => {},
    },
  });
  return {
    webContents: guest as unknown as WebContents,
    request: () => serve!({ senderFrame: mainFrame }, { typedUsername: "", wantsPassword: true }),
    click: () => events.emit("before-mouse-event", {}, { type: "mouseDown" }),
    type: () => events.emit("before-input-event", {}, { type: "keyDown" }),
  };
};

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

  it.effect("fills a page only right after real input reaches it, and never for an agent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-password-vault-" });

      yield* Effect.gen(function* () {
        const vault = yield* PasswordVault.PasswordVault;
        yield* vault.save({ passwords: [github], source: "chrome", onlyWhileChromeSyncs: false });
        const filled: Array<string> = [];
        let agentDriving = false;
        const page = fakeGuest("https://github.com");
        vault.attachGuest({
          guest: page.webContents,
          isAgentDriven: () => agentDriving,
          onPasswordFilled: (password) => filled.push(password),
        });

        // A script in the page can fake the preload's own gesture check.
        expect(yield* Effect.promise(page.request)).toBeNull();

        page.click();
        expect(yield* Effect.promise(page.request)).toEqual({
          username: "octo",
          password: "one",
        });
        expect(filled).toEqual(["one"]);

        page.type();
        agentDriving = true;
        expect(yield* Effect.promise(page.request)).toBeNull();
      }).pipe(Effect.provide(vaultLayer({ baseDir, encryptionAvailable: true })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("writes nothing back from an import that started before the user cleared", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-password-vault-" });

      yield* Effect.gen(function* () {
        const vault = yield* PasswordVault.PasswordVault;
        const importStarted = yield* vault.clears;
        yield* vault.clear;

        expect(
          yield* vault.save({
            passwords: [github],
            source: "chrome",
            onlyWhileChromeSyncs: false,
            unlessClearedSince: importStarted,
          }),
        ).toEqual({ imported: 0, updated: 0 });
        yield* vault.setChromeSync(
          { profileDirectory: "Default", keys: { cbcV10: "a2V5" } },
          { unlessClearedSince: importStarted },
        );
        expect(yield* vault.count).toBe(0);
        expect(yield* vault.chromeSync).toBeNull();
      }).pipe(Effect.provide(vaultLayer({ baseDir, encryptionAvailable: true })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
