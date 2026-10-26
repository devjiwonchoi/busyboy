// Builds "Busyboy Computer Use.app" (native/computer-use-host), the app that
// holds the macOS permissions for computer use so Busyboy and its agents do
// not. Its ad-hoc signature depends only on the source, so a rebuild keeps the
// user's grant. Without a compiler there is no app, and computer use stays off.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export const BUNDLE_ID = "dev.jiwon.busyboy.computer-use";
export const APP_NAME = "Busyboy Computer Use";
export const EXECUTABLE = "busyboy-computer-use";

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${EXECUTABLE}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;

const source = NodeURL.fileURLToPath(
  new URL("../../../native/computer-use-host/main.c", import.meta.url),
);

function isCurrent(app) {
  try {
    return (
      NodeFS.statSync(NodePath.join(app, "Contents/MacOS", EXECUTABLE)).mtimeMs >=
      Math.max(
        NodeFS.statSync(source).mtimeMs,
        NodeFS.statSync(NodeURL.fileURLToPath(import.meta.url)).mtimeMs,
      )
    );
  } catch {
    return false;
  }
}

/** Builds the app at `app`, replacing any older build in one rename. */
export function buildComputerUseHost(app) {
  const staged = `${app}.${process.pid}.staged`;
  NodeFS.rmSync(staged, { recursive: true, force: true });
  try {
    NodeFS.mkdirSync(NodePath.join(staged, "Contents/MacOS"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(staged, "Contents/Info.plist"), INFO_PLIST);
    NodeChildProcess.execFileSync(
      process.env.CC || "cc",
      [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-framework",
        "ApplicationServices",
        "-framework",
        "CoreFoundation",
        "-framework",
        "Security",
        source,
        "-o",
        NodePath.join(staged, "Contents/MacOS", EXECUTABLE),
      ],
      { stdio: "inherit" },
    );
    NodeChildProcess.execFileSync("codesign", ["--force", "--sign", "-", staged], {
      stdio: "inherit",
    });
    NodeFS.rmSync(app, { recursive: true, force: true });
    NodeFS.renameSync(staged, app);
  } finally {
    NodeFS.rmSync(staged, { recursive: true, force: true });
  }
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = NodeUtil.parseArgs({
    options: { output: { type: "string" }, strict: { type: "boolean", default: false } },
  });
  const app = NodePath.resolve(
    values.output ??
      NodeURL.fileURLToPath(new URL(`../resources/computer-use/${APP_NAME}.app`, import.meta.url)),
  );
  if (process.platform === "darwin" && !isCurrent(app)) {
    NodeFS.mkdirSync(NodePath.dirname(app), { recursive: true });
    try {
      buildComputerUseHost(app);
    } catch (error) {
      if (values.strict) throw error;
      console.warn(
        `Could not build ${APP_NAME}.app (install the Xcode command line tools); computer use will be unavailable.`,
      );
    }
  }
}
