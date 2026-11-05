// @effect-diagnostics nodeBuiltinImport:off - builds fake helper bundles on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  checkComputerUseHelper,
  COMPUTER_USE_BUNDLE_NAME,
  COMPUTER_USE_SIGN_IGNORE,
  createBuilderConfig,
  readFuses,
} from "./build-desktop-release.ts";

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const fakeHelper = (contents: string) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cu-release-"));
  dirs.push(dir);
  const bundle = NodePath.join(dir, COMPUTER_USE_BUNDLE_NAME);
  NodeFS.mkdirSync(NodePath.join(bundle, "Contents/MacOS"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(bundle, "Contents/MacOS/busyboy-computer-use"), contents);
  return bundle;
};

describe("computer-use helper in the release build", () => {
  it("leaves the helper out unless --computer-use is passed", () => {
    const config = createBuilderConfig("1.2.3");
    expect(config.extraResources).toEqual([
      { from: "apps/desktop/prod-resources/resource-monitor", to: "resource-monitor" },
      {
        from: "server-runtime",
        to: ".",
        filter: expect.arrayContaining([
          "server/**/*",
          "server/node_modules/**/*",
          "!server/pnpm-lock.yaml",
          // Source maps stay out of the server copy too.
          "!**/*.map",
        ]),
      },
    ]);
    expect(config.mac).not.toHaveProperty("signIgnore");
    expect(config.files.some((pattern) => pattern.includes("computer-use"))).toBe(false);
  });

  it("with --computer-use, ships the helper as an extra resource that electron-builder does not re-sign", () => {
    const config = createBuilderConfig("1.2.3", { computerUse: true });
    // BusyBoy itself is Developer ID signed and notarized; only the helper is left alone.
    expect(config.forceCodeSigning).toBe(true);
    expect(config.extraResources).toContainEqual({
      from: "apps/desktop/prod-resources/computer-use",
      to: "computer-use",
    });
    expect(config.mac.signIgnore).toEqual([COMPUTER_USE_SIGN_IGNORE]);
    const ignore = new RegExp(config.mac.signIgnore![0]!);
    expect(
      ignore.test(
        "/x/BusyBoy.app/Contents/Resources/computer-use/BusyBoy Computer Use.app/Contents/MacOS/busyboy-computer-use",
      ),
    ).toBe(true);
    expect(
      ignore.test("/x/BusyBoy.app/Contents/Resources/resource-monitor/t3-resource-monitor"),
    ).toBe(false);
  });

  it("refuses a helper built with dev-callers and checks the signature otherwise", () => {
    const verified: Array<string> = [];
    const verify = (bundle: string) => void verified.push(bundle);
    expect(() =>
      checkComputerUseHelper(fakeHelper("binary BUSYBOY_CU_DEV_CALLERS_ENABLED binary"), verify),
    ).toThrow(/dev-callers/);
    expect(verified).toEqual([]);

    const release = fakeHelper("release binary");
    checkComputerUseHelper(release, verify);
    expect(verified).toEqual([release]);
  });
});

describe("release hardening", () => {
  it("keeps other programs from running code as BusyBoy", () => {
    const config = createBuilderConfig("1.2.3");
    // ELECTRON_RUN_AS_NODE, NODE_OPTIONS and --inspect would let any program run code
    // under BusyBoy's signature, which the Computer Use helper and the keychain trust.
    expect(config.electronFuses).toEqual({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    });
    expect(config.mac.entitlements).toBe(config.mac.entitlementsInherit);
    const entitlements = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "..", config.mac.entitlements),
      "utf8",
    );
    expect(entitlements).toContain("com.apple.security.cs.allow-jit");
    expect(entitlements).not.toContain("disable-library-validation");
    // The server stage ships beside app.asar, never inside it.
    expect(config.files).toContain("!server-runtime/**/*");
  });

  it("reads the fuse wire the way Electron lays it out", () => {
    const wire = Buffer.concat([
      Buffer.from("padding"),
      Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"),
      Buffer.from([1, 6]),
      Buffer.from("010010"),
    ]);
    expect(readFuses(wire)).toEqual({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: false,
    });
  });
});
