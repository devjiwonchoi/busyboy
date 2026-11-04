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
  it("ships the helper as an extra resource that electron-builder does not re-sign", () => {
    const config = createBuilderConfig("1.2.3");
    expect(config.extraResources).toContainEqual({
      from: "apps/desktop/prod-resources/computer-use",
      to: "computer-use",
    });
    const ignore = new RegExp(config.mac.signIgnore[0]!);
    expect(config.mac.signIgnore).toEqual([COMPUTER_USE_SIGN_IGNORE]);
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
