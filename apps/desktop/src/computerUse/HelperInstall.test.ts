// @effect-diagnostics nodeBuiltinImport:off - Builds fake helper bundles on disk.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  HELPER_BUNDLE_NAME,
  HELPER_REQUIREMENT,
  HelperInstaller,
  type CommandRunner,
} from "./HelperInstall.ts";

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const writeBundle = (bundle: string, version: string, executable: string) => {
  NodeFS.mkdirSync(NodePath.join(bundle, "Contents/MacOS"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(bundle, "Contents/Info.plist"),
    `<plist><dict>\n<key>CFBundleVersion</key>\n<string>${version}</string>\n</dict></plist>`,
  );
  NodeFS.writeFileSync(NodePath.join(bundle, "Contents/MacOS/busyboy-computer-use"), executable);
};

const setup = (options: { readonly rename?: (from: string, to: string) => Promise<void> } = {}) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cu-install-"));
  dirs.push(root);
  const bundled = NodePath.join(root, "resources", HELPER_BUNDLE_NAME);
  const installRoot = NodePath.join(root, "Application Support/BusyBoy/ComputerUse");
  const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  const state = { signatureValid: true };
  // ditto copies; codesign passes or fails on demand.
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === "ditto") {
      NodeFS.cpSync(args[1]!, args[2]!, { recursive: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "codesign") {
      return state.signatureValid
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 3, stdout: "", stderr: "test-requirement failed" };
    }
    throw new Error(`unexpected ${command}`);
  };
  const installer = new HelperInstaller({ bundledPath: bundled, installRoot, run, ...options });
  const installedExecutable = () =>
    NodeFS.readFileSync(
      NodePath.join(installer.installedPath, "Contents/MacOS/busyboy-computer-use"),
      "utf8",
    );
  const leftovers = () => NodeFS.readdirSync(installRoot).filter((name) => name.startsWith("."));
  return { bundled, installRoot, calls, state, installer, installedExecutable, leftovers };
};

describe("HelperInstaller", () => {
  it("copies the helper once and re-copies when its build or executable changes", async () => {
    const test = setup();
    writeBundle(test.bundled, "100", "build-a");
    let replaced = 0;
    const beforeReplace = async () => {
      replaced += 1;
    };

    const first = await test.installer.ensureInstalled({ beforeReplace });
    expect(first).toMatchObject({
      copied: true,
      version: "100",
      path: test.installer.installedPath,
    });
    expect(test.installedExecutable()).toBe("build-a");
    expect(test.calls.find((call) => call.command === "ditto")?.args[0]).toBe("--noqtn");

    const again = await test.installer.ensureInstalled({ beforeReplace });
    expect(again.copied).toBe(false);
    expect(replaced).toBe(1);

    writeBundle(test.bundled, "101", "build-a");
    expect((await test.installer.ensureInstalled({ beforeReplace })).copied).toBe(true);

    // Same build number, different binary.
    writeBundle(test.bundled, "101", "build-b");
    expect((await test.installer.ensureInstalled({ beforeReplace })).copied).toBe(true);
    expect(test.installedExecutable()).toBe("build-b");
    expect(replaced).toBe(3);
    expect(test.leftovers()).toEqual([]);
  });

  it("keeps the old install when the new copy fails verification", async () => {
    const test = setup();
    writeBundle(test.bundled, "100", "good");
    await test.installer.ensureInstalled();

    writeBundle(test.bundled, "101", "tampered");
    test.state.signatureValid = false;
    await expect(test.installer.ensureInstalled()).rejects.toMatchObject({
      reason: "helper_signature_invalid",
    });
    expect(test.installedExecutable()).toBe("good");
    expect(test.leftovers()).toEqual([]);
  });

  it("verifies the installed bundle against the BusyBoy requirement before launch", async () => {
    const test = setup();
    writeBundle(test.bundled, "100", "good");
    await test.installer.ensureInstalled();
    test.calls.length = 0;

    await test.installer.verifyInstalled();
    expect(test.calls).toEqual([
      {
        command: "codesign",
        args: ["--verify", "--strict", `-R=${HELPER_REQUIREMENT}`, test.installer.installedPath],
      },
    ]);
    test.state.signatureValid = false;
    await expect(test.installer.verifyInstalled()).rejects.toMatchObject({
      reason: "helper_signature_invalid",
    });
  });

  it("reports a missing helper when nothing is bundled or installed", async () => {
    const test = setup();
    await expect(test.installer.ensureInstalled()).rejects.toMatchObject({
      reason: "helper_missing",
    });
    await expect(test.installer.verifyInstalled()).rejects.toMatchObject({
      reason: "helper_missing",
    });
  });

  it("reports a build without the helper as not bundled, even over an earlier install", async () => {
    const test = setup();
    writeBundle(test.bundled, "100", "good");
    await test.installer.ensureInstalled();
    const calls = test.calls.length;
    const unbundled = new HelperInstaller({
      bundledPath: null,
      installRoot: test.installRoot,
      run: async () => {
        throw new Error("nothing should run");
      },
    });
    await expect(unbundled.ensureInstalled()).rejects.toMatchObject({
      reason: "helper_not_bundled",
    });
    expect(test.calls.length).toBe(calls);
  });

  it("keeps the previous install when neither the new copy nor the old one can be moved back", async () => {
    let failMoves = false;
    const test = setup({
      rename: async (from, to) => {
        // The first move (old install aside) works; the next two fail.
        if (failMoves && !from.endsWith(HELPER_BUNDLE_NAME)) throw new Error("EIO");
        NodeFS.renameSync(from, to);
      },
    });
    writeBundle(test.bundled, "100", "good");
    await test.installer.ensureInstalled();

    writeBundle(test.bundled, "101", "next");
    failMoves = true;
    await expect(test.installer.ensureInstalled()).rejects.toMatchObject({
      reason: "helper_install_failed",
    });
    const kept = test.leftovers().filter((name) => name.endsWith(".old"));
    expect(kept).toHaveLength(1);
    expect(
      NodeFS.readFileSync(
        NodePath.join(test.installRoot, kept[0]!, "Contents/MacOS/busyboy-computer-use"),
        "utf8",
      ),
    ).toBe("good");
  });
});
