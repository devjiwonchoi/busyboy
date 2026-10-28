// Fetches the Cua driver executable that computer use runs as a private worker.
//
// The version and per-architecture SHA-256 are pinned here rather than read
// from the release's checksums.txt: Cua driver releases are marked
// pre-release, and a re-published asset must fail the check instead of being
// trusted. A failed fetch only leaves computer use unavailable; it never fails
// the desktop build.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export const CUA_DRIVER_VERSION = "0.37.0";

export const CUA_DRIVER_ASSETS = {
  arm64: {
    name: `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-arm64`,
    sha256: "1e9b8c58cc830e080ada881ec76286529f5f1264fe9ecc371b0ae95cff98928b",
  },
  x64: {
    name: `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-x86_64`,
    sha256: "2f9f0d652b2a571d210a3280028774cd640f805284868e8beef160a83fc07bfd",
  },
};

// Files copied out of the release archive. The license files ship next to the
// executable because the app redistributes it.
export const CUA_DRIVER_FILES = ["cua-driver", "LICENSE", "THIRD_PARTY_NOTICES.md"];

const VERSION_STAMP = "VERSION";

export const defaultOutputDir = NodePath.resolve(
  NodeURL.fileURLToPath(new URL("../resources/cua-driver", import.meta.url)),
);

export function cuaDriverAssetUrl(asset) {
  return `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/${asset.name}.tar.gz`;
}

function stampFor(asset) {
  return `${CUA_DRIVER_VERSION} ${asset.sha256}\n`;
}

export function isInstalled(outputDir, asset) {
  try {
    if (NodeFS.readFileSync(NodePath.join(outputDir, VERSION_STAMP), "utf8") !== stampFor(asset)) {
      return false;
    }
    return CUA_DRIVER_FILES.every((file) => NodeFS.existsSync(NodePath.join(outputDir, file)));
  } catch {
    return false;
  }
}

function sha256(file) {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
}

/**
 * Verifies `archivePath` against the pinned hash and installs its files into
 * `outputDir`. The new files replace the old directory in one rename, so a
 * failure part way leaves the previous install untouched.
 */
export function installFromArchive({ archivePath, asset, outputDir: requestedOutputDir }) {
  const outputDir = NodePath.resolve(requestedOutputDir);
  const actual = sha256(archivePath);
  if (actual !== asset.sha256) {
    throw new Error(
      `Cua driver archive ${asset.name} has SHA-256 ${actual}, expected ${asset.sha256}.`,
    );
  }
  const parent = NodePath.dirname(outputDir);
  NodeFS.mkdirSync(parent, { recursive: true });
  const extractDir = NodeFS.mkdtempSync(NodePath.join(parent, ".cua-driver-extract-"));
  const stagedDir = `${outputDir}.${process.pid}.staged`;
  try {
    NodeChildProcess.execFileSync("tar", ["-xzf", archivePath, "-C", extractDir], {
      stdio: "inherit",
    });
    NodeFS.rmSync(stagedDir, { recursive: true, force: true });
    NodeFS.mkdirSync(stagedDir);
    for (const file of CUA_DRIVER_FILES) {
      const source = NodePath.join(extractDir, asset.name, file);
      if (!NodeFS.statSync(source, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Cua driver archive ${asset.name} has no ${file}.`);
      }
      NodeFS.copyFileSync(source, NodePath.join(stagedDir, file));
    }
    NodeFS.chmodSync(NodePath.join(stagedDir, "cua-driver"), 0o755);
    NodeFS.writeFileSync(NodePath.join(stagedDir, VERSION_STAMP), stampFor(asset));
    NodeFS.rmSync(outputDir, { recursive: true, force: true });
    NodeFS.renameSync(stagedDir, outputDir);
  } finally {
    NodeFS.rmSync(extractDir, { recursive: true, force: true });
    NodeFS.rmSync(stagedDir, { recursive: true, force: true });
  }
}

// Long enough for the ~85 MB archive on a slow connection, short enough that a
// stalled download cannot hold up a build indefinitely.
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) {
    throw new Error(`Downloading ${url} failed with HTTP ${response.status}.`);
  }
  NodeFS.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

export async function fetchCuaDriver({
  arch,
  outputDir = defaultOutputDir,
  fetchArchive = download,
}) {
  const asset = CUA_DRIVER_ASSETS[arch];
  if (!asset) throw new Error(`No Cua driver build for macOS ${arch}.`);
  if (isInstalled(outputDir, asset)) return { status: "current" };
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cua-driver-"));
  try {
    const archivePath = NodePath.join(tempDir, `${asset.name}.tar.gz`);
    await fetchArchive(cuaDriverAssetUrl(asset), archivePath);
    installFromArchive({ archivePath, asset, outputDir });
    return { status: "installed" };
  } finally {
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] !== undefined &&
  NodeFS.realpathSync(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url);

if (isMain) {
  const { values } = NodeUtil.parseArgs({
    options: {
      arch: { type: "string", default: process.arch },
      output: { type: "string" },
      strict: { type: "boolean", default: false },
    },
  });
  // Computer use ships on macOS only.
  if (process.platform !== "darwin") process.exit(0);
  try {
    const result = await fetchCuaDriver({
      arch: values.arch,
      ...(values.output ? { outputDir: NodePath.resolve(values.output) } : {}),
    });
    if (result.status === "installed") console.log(`Installed Cua driver ${CUA_DRIVER_VERSION}.`);
  } catch (error) {
    if (values.strict) throw error;
    console.warn(
      `Computer use will be unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
