#!/usr/bin/env node
// Runs Busyboy from its own source checkout and updates it from origin/main.
//
//   pnpm local-app:install   one-time setup: clones into ~/.busyboy/source, builds,
//                            and creates ~/Applications/Busyboy.app
//
// The app's updater runs the other commands from the checkout it is running:
//   check     fetch origin/main and print what is new (JSON)
//   prepare   build origin/main in the idle slot, printing progress (JSON lines)
//   switch    point `current` at the prepared slot
//   bundle    rebuild Busyboy.app from this checkout's Electron
//
// Two slots (a, b) let an update build without touching the copy that is running.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const scriptPath = NodeURL.fileURLToPath(import.meta.url);
const checkoutDir = NodePath.resolve(scriptPath, "../../../..");
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone script has no Effect runtime.
const homeDir = NodeOS.homedir();
const root =
  process.env.T3CODE_LOCAL_APP_ROOT?.trim() || NodePath.join(homeDir, ".busyboy", "source");
const currentLink = NodePath.join(root, "current");
const preparedPath = NodePath.join(root, "prepared.json");
const logPath = NodePath.join(root, "update.log");
const appBundlePath = NodePath.join(homeDir, "Applications", "Busyboy.app");
const ELECTRON_VERSION_KEY = "BusyboyElectronVersion";

// Build tools must run as plain Node even when the app runs this script through Electron.
const toolEnv = { ...process.env };
delete toolEnv.ELECTRON_RUN_AS_NODE;

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The bundle's executable. It resolves `current` on every launch, so a relaunch
 * after `switch` runs the new slot, and passes the slot's commit to the app.
 */
export function makeLauncherScript(localAppRoot) {
  return [
    "#!/bin/sh",
    `root=${shellSingleQuote(localAppRoot)}`,
    'slot=$(cd "$root/current" && pwd -P) || exit 1',
    'gitdir="$slot/.git"',
    'if [ -f "$gitdir" ]; then gitdir=$(sed -n "s/^gitdir: //p" "$gitdir"); fi',
    'export T3CODE_LOCAL_APP_ROOT="$root"',
    'export T3CODE_LOCAL_APP_LAUNCHER="$0"',
    'export T3CODE_LOCAL_APP_COMMIT="$(cat "$gitdir/HEAD")"',
    'cd "$slot/apps/desktop" || exit 1',
    // Launch the app folder like a packaged build, so Electron reads its package.json
    // (name, version, and the boot entry that turns on the compile cache).
    'exec "$(dirname "$0")/Electron" "$slot/apps/desktop" "$@"',
    "",
  ].join("\n");
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function git(cwd, args) {
  const result = NodeChildProcess.spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: toolEnv,
  });
  if (result.status !== 0) {
    const details = result.error?.message ?? (result.stderr || result.stdout).trim();
    throw new Error(`git ${args.join(" ")} failed: ${details}`);
  }

  return result.stdout.trim();
}

// Long steps write their output to update.log so a failure can be read afterwards.
function runLogged(cwd, command, args) {
  const logFd = NodeFS.openSync(logPath, "a");
  try {
    NodeFS.writeSync(logFd, `\n$ ${command} ${args.join(" ")}\n`);
    const result = NodeChildProcess.spawnSync(command, args, {
      cwd,
      env: toolEnv,
      stdio: ["ignore", logFd, logFd],
    });
    if (result.status !== 0) {
      const reason = result.error?.message ?? `exit ${result.status}`;
      throw new Error(`${command} ${args.join(" ")} failed (${reason}). See ${logPath}`);
    }
  } finally {
    NodeFS.closeSync(logFd);
  }
}

function slotDir(slot) {
  return NodePath.join(root, slot);
}

function currentSlot() {
  return NodePath.basename(NodeFS.realpathSync(currentLink));
}

function idleSlot() {
  return currentSlot() === "a" ? "b" : "a";
}

// Renaming a new link over the old one swaps `current` atomically.
function pointCurrentAt(slot) {
  const nextLink = `${currentLink}.next`;
  NodeFS.rmSync(nextLink, { force: true });
  NodeFS.symlinkSync(slot, nextLink);
  NodeFS.renameSync(nextLink, currentLink);
}

function prepareSlot(slot, report) {
  const dir = slotDir(slot);

  report("fetch", 5);
  git(dir, ["fetch", "--quiet", "origin", "main"]);
  if (git(dir, ["status", "--porcelain"]) !== "") {
    throw new Error(`${dir} has local changes. Commit or discard them, then try again.`);
  }

  report("checkout", 10);
  git(dir, ["checkout", "--quiet", "--detach", "origin/main"]);

  report("install", 15);
  runLogged(dir, "pnpm", ["install", "--frozen-lockfile"]);

  report("build", 50);
  runLogged(dir, "pnpm", ["build"]);

  return git(dir, ["rev-parse", "HEAD"]);
}

function readElectronVersion(dir) {
  try {
    const packageJsonPath = NodePath.join(dir, "apps/desktop/node_modules/electron/package.json");
    return JSON.parse(NodeFS.readFileSync(packageJsonPath, "utf8")).version;
  } catch {
    return null;
  }
}

function readBundleElectronVersion() {
  const result = NodeChildProcess.spawnSync(
    "plutil",
    [
      "-extract",
      ELECTRON_VERSION_KEY,
      "raw",
      NodePath.join(appBundlePath, "Contents", "Info.plist"),
    ],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

// Runs `bundle` from the given checkout so the bundle copies that checkout's Electron.
function rebuildBundleFrom(dir) {
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(dir, "apps/desktop/scripts/local-app.mjs"), "bundle"],
    { env: { ...process.env, T3CODE_LOCAL_APP_ROOT: root }, stdio: ["ignore", "ignore", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(`Rebuilding ${appBundlePath} failed: ${result.stderr?.toString().trim()}`);
  }
}

const commands = {
  install() {
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone script has no Effect runtime.
    if (process.platform !== "darwin") {
      throw new Error("The local app is only supported on macOS.");
    }

    const origin = git(checkoutDir, ["remote", "get-url", "origin"]);
    NodeFS.mkdirSync(root, { recursive: true });

    if (!NodeFS.existsSync(slotDir("a"))) {
      console.log(`Cloning ${origin} into ${slotDir("a")}`);
      git(root, ["clone", "--quiet", origin, slotDir("a")]);
    }
    if (!NodeFS.existsSync(slotDir("b"))) {
      git(slotDir("a"), ["worktree", "add", "--quiet", "--detach", slotDir("b"), "origin/main"]);
    }

    if (!NodeFS.existsSync(currentLink)) {
      NodeFS.writeFileSync(logPath, "");
      prepareSlot("a", (phase) => console.log(`${phase}… (log: ${logPath})`));
      pointCurrentAt("a");
    }

    rebuildBundleFrom(slotDir(currentSlot()));
    console.log(`Installed ${appBundlePath}, running ${slotDir(currentSlot())}`);
  },

  check() {
    const dir = NodeFS.realpathSync(currentLink);
    git(dir, ["fetch", "--quiet", "origin", "main"]);
    const commits = git(dir, ["log", "--reverse", "--format=%s", "HEAD..origin/main"]);
    print({
      currentCommit: git(dir, ["rev-parse", "HEAD"]),
      latestCommit: git(dir, ["rev-parse", "origin/main"]),
      commits: commits === "" ? [] : commits.split("\n"),
    });
  },

  prepare() {
    const slot = idleSlot();
    NodeFS.rmSync(preparedPath, { force: true });
    NodeFS.writeFileSync(logPath, "");
    const commit = prepareSlot(slot, (phase, percent) => print({ phase, percent }));
    NodeFS.writeFileSync(preparedPath, JSON.stringify({ slot, commit }));
    print({ phase: "done", percent: 100, commit });
  },

  switch() {
    if (!NodeFS.existsSync(preparedPath)) {
      throw new Error("No prepared update. Run prepare first.");
    }

    const { slot, commit } = JSON.parse(NodeFS.readFileSync(preparedPath, "utf8"));
    if (slot === currentSlot()) {
      throw new Error(`Slot ${slot} is already current.`);
    }

    // A new Electron needs a new bundle before the relaunch can run the new slot.
    const bundleRebuilt = readElectronVersion(slotDir(slot)) !== readBundleElectronVersion();
    if (bundleRebuilt) {
      rebuildBundleFrom(slotDir(slot));
    }

    pointCurrentAt(slot);
    NodeFS.rmSync(preparedPath, { force: true });
    print({ slot, commit, bundleRebuilt });
  },

  async bundle() {
    // The bundle carries the production identity, never a dev server's.
    delete process.env.VITE_DEV_SERVER_URL;
    const { buildMacAppBundle } = await import("./electron-launcher.mjs");
    buildMacAppBundle({
      targetAppBundlePath: appBundlePath,
      launcherScript: makeLauncherScript(root),
      metadata: { [ELECTRON_VERSION_KEY]: readElectronVersion(checkoutDir) ?? "unknown" },
    });
  },
};

const isEntrypoint =
  process.argv[1] !== undefined && NodeFS.realpathSync(process.argv[1]) === scriptPath;

if (isEntrypoint) {
  const command = commands[process.argv[2] ?? ""];
  if (command === undefined) {
    console.error("usage: local-app.mjs install | check | prepare | switch | bundle");
    process.exit(1);
  }

  try {
    await command();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
