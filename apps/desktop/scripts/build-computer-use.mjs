// Builds "BusyBoy Computer Use.app": runs cargo, assembles the bundle, and signs it
// inside-out with the local Developer ID (team 5PA4R2B5FF). Never signs ad hoc, because
// macOS ties an ad-hoc grant to one build and silently drops it on the next rebuild.
//
//   node apps/desktop/scripts/build-computer-use.mjs [--release] [--dev-callers]
//     [--output <dir>] [--identity <name>] [--build-number <n>] [--no-timestamp]
//
// --dev-callers lets the helper accept the unsigned dev Electron that launched it.
// Release builds refuse it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export const HELPER_BUNDLE_NAME = "BusyBoy Computer Use.app";
export const HELPER_BUNDLE_ID = "dev.jiwon.busyboy.computer-use";
export const HELPER_EXECUTABLE = "busyboy-computer-use";
export const TEAM_ID = "5PA4R2B5FF";
export const DEFAULT_IDENTITY = `Developer ID Application: Jiwon Choi (${TEAM_ID})`;
export const HELPER_REQUIREMENT = `anchor apple generic and identifier "${HELPER_BUNDLE_ID}" and certificate leaf[subject.OU] = "${TEAM_ID}"`;
// Compiled into the binary only with the dev-callers feature; release builds check for it.
export const DEV_CALLERS_MARKER = "BUSYBOY_CU_DEV_CALLERS_ENABLED";

const repoRoot = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
const workspace = NodePath.join(repoRoot, "native/computer-use");

function run(command, args, options = {}) {
  return NodeChildProcess.execFileSync(command, args, { stdio: "inherit", ...options });
}

function capture(command, args) {
  return NodeChildProcess.execFileSync(command, args, { encoding: "utf8" }).trim();
}

function cargoVersion() {
  const manifest = NodeFS.readFileSync(NodePath.join(workspace, "Cargo.toml"), "utf8");
  const match = /^\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(manifest);
  if (!match)
    throw new Error("Could not read the workspace version from native/computer-use/Cargo.toml.");
  return match[1];
}

function defaultBuildNumber() {
  // Monotonic on main: the commit count.
  return capture("git", ["-C", repoRoot, "rev-list", "--count", "HEAD"]);
}

function stageIcon(resourcesDir) {
  const sourcePng = NodePath.join(repoRoot, "assets/busyboy.png");
  const iconsetDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "busyboy-cu-iconset-"));
  const iconset = NodePath.join(iconsetDir, "AppIcon.iconset");
  NodeFS.mkdirSync(iconset);
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const [scale, suffix] of [
        [1, ""],
        [2, "@2x"],
      ]) {
        const pixels = String(size * scale);
        const output = NodePath.join(iconset, `icon_${size}x${size}${suffix}.png`);
        run("sips", ["-z", pixels, pixels, sourcePng, "--out", output], { stdio: "ignore" });
      }
    }
    run("iconutil", ["-c", "icns", iconset, "-o", NodePath.join(resourcesDir, "AppIcon.icns")]);
  } finally {
    NodeFS.rmSync(iconsetDir, { recursive: true, force: true });
  }
}

function sign({ path, identity, timestamp, identifier }) {
  const args = ["--force", "--options", "runtime", "--sign", identity];
  args.push(timestamp ? "--timestamp" : "--timestamp=none");
  if (identifier) args.push("--identifier", identifier);
  run("codesign", [...args, path]);
}

/** Builds, bundles, signs, and verifies the helper. Returns the bundle path. */
export function buildComputerUse({
  release,
  devCallers,
  output,
  identity,
  buildNumber,
  timestamp,
}) {
  if (release && devCallers) {
    throw new Error("Release builds of the computer-use helper must not enable dev-callers.");
  }
  if (!identity || identity === "-") {
    throw new Error(
      "The computer-use helper must be signed with a Developer ID identity, never ad hoc.",
    );
  }

  const profile = release ? "release" : "debug";
  const cargoArgs = [
    "build",
    "--locked",
    "-p",
    "helper",
    "--manifest-path",
    NodePath.join(workspace, "Cargo.toml"),
  ];
  if (release) cargoArgs.push("--release");
  if (devCallers) cargoArgs.push("--features", "dev-callers");
  run("cargo", cargoArgs);

  const executable = NodePath.join(workspace, "target", profile, HELPER_EXECUTABLE);
  const binary = NodeFS.readFileSync(executable);
  if (release && binary.includes(DEV_CALLERS_MARKER)) {
    throw new Error(
      "The release helper binary contains the dev-callers path. Rebuild without --features dev-callers.",
    );
  }

  // Assemble into a temporary sibling, then swap into place.
  const outputDir = output ?? NodePath.join(workspace, "target", "bundle", profile);
  NodeFS.mkdirSync(outputDir, { recursive: true });
  const bundle = NodePath.join(outputDir, HELPER_BUNDLE_NAME);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone build script has no Effect runtime.
  const staging = NodePath.join(outputDir, `.${HELPER_BUNDLE_NAME}.${process.pid}.tmp`);
  NodeFS.rmSync(staging, { recursive: true, force: true });
  try {
    const contents = NodePath.join(staging, "Contents");
    const macos = NodePath.join(contents, "MacOS");
    const resources = NodePath.join(contents, "Resources");
    NodeFS.mkdirSync(macos, { recursive: true });
    NodeFS.mkdirSync(resources, { recursive: true });

    const plist = NodeFS.readFileSync(
      NodePath.join(workspace, "crates/helper/bundle/Info.plist"),
      "utf8",
    )
      .replace("@SHORT_VERSION@", cargoVersion())
      .replace("@BUILD_NUMBER@", buildNumber);
    NodeFS.writeFileSync(NodePath.join(contents, "Info.plist"), plist);
    run("plutil", ["-lint", "-s", NodePath.join(contents, "Info.plist")]);

    const bundledExecutable = NodePath.join(macos, HELPER_EXECUTABLE);
    NodeFS.copyFileSync(executable, bundledExecutable);
    NodeFS.chmodSync(bundledExecutable, 0o755);
    NodeFS.copyFileSync(
      NodePath.join(workspace, "THIRD_PARTY_NOTICES.md"),
      NodePath.join(resources, "THIRD_PARTY_NOTICES.md"),
    );
    stageIcon(resources);

    // Inside-out: the executable, then the bundle.
    sign({ path: bundledExecutable, identity, timestamp, identifier: HELPER_BUNDLE_ID });
    sign({ path: staging, identity, timestamp });

    NodeFS.rmSync(bundle, { recursive: true, force: true });
    NodeFS.renameSync(staging, bundle);
  } finally {
    NodeFS.rmSync(staging, { recursive: true, force: true });
  }

  run("codesign", ["--verify", "--strict", "--deep", `-R=${HELPER_REQUIREMENT}`, bundle]);
  return bundle;
}

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone build script has no Effect runtime.
const isMain = process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone build script has no Effect runtime.
  if (process.platform !== "darwin")
    throw new Error("The computer-use helper only builds on macOS.");
  const { values } = NodeUtil.parseArgs({
    options: {
      release: { type: "boolean", default: false },
      "dev-callers": { type: "boolean", default: false },
      output: { type: "string" },
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone build script has no Effect runtime.
      identity: {
        type: "string",
        default: process.env.BUSYBOY_CU_SIGN_IDENTITY || DEFAULT_IDENTITY,
      },
      "build-number": { type: "string" },
      "no-timestamp": { type: "boolean", default: false },
    },
  });
  const bundle = buildComputerUse({
    release: values.release,
    devCallers: values["dev-callers"],
    output: values.output,
    identity: values.identity,
    buildNumber: values["build-number"] ?? defaultBuildNumber(),
    timestamp: !values["no-timestamp"],
  });
  console.log(bundle);
}
