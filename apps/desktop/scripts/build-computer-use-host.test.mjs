import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { APP_NAME, BUNDLE_ID, EXECUTABLE } from "./build-computer-use-host.mjs";

const scriptPath = NodePath.join(import.meta.dirname, "build-computer-use-host.mjs");
const realDriver = NodePath.join(import.meta.dirname, "../resources/cua-driver/cua-driver");

const cdhash = (app) =>
  /^CDHash=(\w+)$/m.exec(
    NodeChildProcess.spawnSync("codesign", ["-dvvv", app], { encoding: "utf8" }).stderr,
  )?.[1];

/** An app with the given bundle id that runs a command as its child. */
function makeParentApp(dir, bundleId) {
  const app = NodePath.join(dir, "Parent.app");
  const source = NodePath.join(dir, "parent.c");
  NodeFS.mkdirSync(NodePath.join(app, "Contents/MacOS"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(app, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleExecutable</key><string>parent</string></dict></plist>`,
  );
  NodeFS.writeFileSync(
    source,
    `#include <spawn.h>
#include <sys/wait.h>
extern char **environ;
int main(int argc, char *argv[]) {
  pid_t pid; int status;
  if (argc < 2 || posix_spawn(&pid, argv[1], 0, 0, argv + 1, environ) != 0) return 99;
  waitpid(pid, &status, 0);
  return WEXITSTATUS(status);
}
`,
  );
  const executable = NodePath.join(app, "Contents/MacOS/parent");
  NodeChildProcess.execFileSync("cc", [source, "-o", executable]);
  return executable;
}

// The app uses macOS code signing and spawn attributes, so it only builds there.
describe.runIf(process.platform === "darwin")("Busyboy Computer Use.app", () => {
  let tmp;
  let host;
  let busyboy;

  /** Installs `driver` where the app looks for the Cua driver. */
  const installDriver = (driver) => {
    const target = NodePath.join(tmp, "resources/cua-driver/cua-driver");
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.rmSync(target, { force: true });
    NodeFS.copyFileSync(driver, target);
    NodeFS.chmodSync(target, 0o755);
  };

  beforeAll(() => {
    tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "computer-use-host-"));
    const app = NodePath.join(tmp, `resources/computer-use/${APP_NAME}.app`);
    NodeChildProcess.execFileSync(process.execPath, [scriptPath, "--strict", "--output", app]);
    host = NodePath.join(app, "Contents/MacOS", EXECUTABLE);
    busyboy = makeParentApp(tmp, "dev.jiwon.busyboy");
  });

  afterAll(() => {
    NodeFS.rmSync(tmp, { recursive: true, force: true });
  });

  it("builds a signed app whose signature survives a rebuild elsewhere", () => {
    const app = NodePath.dirname(NodePath.dirname(NodePath.dirname(host)));
    const rebuilt = NodePath.join(tmp, "rebuilt", `${APP_NAME}.app`);
    NodeChildProcess.execFileSync(process.execPath, [scriptPath, "--strict", "--output", rebuilt]);

    const info = NodeChildProcess.spawnSync("codesign", ["-dv", app], { encoding: "utf8" });
    expect(info.stderr).toContain(`Identifier=${BUNDLE_ID}`);
    expect(NodeChildProcess.spawnSync("codesign", ["--verify", "--strict", app]).status).toBe(0);
    // macOS keys an ad-hoc app's grant to this hash, so the user grants once.
    expect(cdhash(rebuilt)).toBe(cdhash(app));
  });

  it("refuses to start for anything but Busyboy", () => {
    const fromShell = NodeChildProcess.spawnSync(host, ["--version"], { encoding: "utf8" });
    expect(fromShell.status).toBe(77);
    expect(fromShell.stderr).toContain("only Busyboy can start computer use");

    const other = makeParentApp(NodePath.join(tmp, "other"), "com.example.other");
    expect(NodeChildProcess.spawnSync(other, [host, "--version"]).status).toBe(77);
  });

  it("runs only a driver signed by Cua", () => {
    installDriver("/bin/echo");
    const result = NodeChildProcess.spawnSync(busyboy, [host, "--version"], { encoding: "utf8" });
    expect(result.status).toBe(77);
    expect(result.stderr).toContain("not signed by Cua");
  });

  it.runIf(NodeFS.existsSync(realDriver))(
    "runs the Cua driver for Busyboy with its arguments, output and exit status",
    () => {
      installDriver(realDriver);
      const result = NodeChildProcess.spawnSync(busyboy, [host, "--version"], {
        encoding: "utf8",
      });
      expect(result.stdout).toMatch(/^cua-driver \d+\.\d+\.\d+/);
      expect(result.status).toBe(0);
    },
  );
});
