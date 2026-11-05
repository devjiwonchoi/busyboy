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
  fileExclusions,
  readFuses,
  resolveWindowsSigning,
  WINDOWS_SIGNING_ENV,
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

describe("Windows release", () => {
  const signingEnv = Object.fromEntries(WINDOWS_SIGNING_ENV.map((name) => [name, `${name}-value`]));

  it("builds a per-arch NSIS installer with the same fuses and busyboy:// links", () => {
    const config = createBuilderConfig("1.2.3", { computerUse: true, platform: "win" });
    expect(config.win.target).toEqual(["nsis"]);
    expect(config.win.icon).toBe("icon.ico");
    expect(config.nsis.artifactName).toBe("BusyBoy-Setup-${version}-${arch}.${ext}");
    expect(config.electronFuses.runAsNode).toBe(false);
    expect(config.protocols).toEqual([{ name: "BusyBoy", schemes: ["busyboy"] }]);
    // The Computer Use helper is macOS only.
    expect(config.extraResources.some((resource) => resource.to === "computer-use")).toBe(false);
    // Unsigned until Azure Trusted Signing is set up.
    expect(config.forceCodeSigning).toBe(false);
    expect(config.win).not.toHaveProperty("azureSignOptions");
  });

  it("keeps the Windows terminal binaries in Windows builds only", () => {
    expect(fileExclusions("win")).not.toContain(
      "!**/node_modules/node-pty/third_party/conpty/**/*",
    );
    expect(fileExclusions("win")).toContain("!**/node_modules/node-pty/prebuilds/darwin-*/**/*");
    expect(fileExclusions("mac")).toContain("!**/node_modules/node-pty/third_party/conpty/**/*");
  });

  it("signs with Azure Trusted Signing only when every setting is present", () => {
    expect(resolveWindowsSigning({})).toBeUndefined();
    const signing = resolveWindowsSigning(signingEnv);
    expect(signing).toEqual({
      publisherName: "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME-value",
      endpoint: "AZURE_TRUSTED_SIGNING_ENDPOINT-value",
      codeSigningAccountName: "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME-value",
      certificateProfileName: "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME-value",
    });
    const config = createBuilderConfig("1.2.3", {
      computerUse: false,
      platform: "win",
      windowsSigning: signing,
    });
    expect(config.forceCodeSigning).toBe(true);
    expect(config.win.azureSignOptions).toEqual(signing);
    expect(() => resolveWindowsSigning({ ...signingEnv, AZURE_CLIENT_SECRET: undefined })).toThrow(
      "missing AZURE_CLIENT_SECRET",
    );
  });
});
