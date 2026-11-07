// @effect-diagnostics nodeBuiltinImport:off -- The installer must outlive the app, so it spawns a detached Node child process and writes the bundle with Node APIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import type * as NodeStreamWeb from "node:stream/web";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as UpdateSignature from "./updateSignature.ts";

/**
 * Updates a macOS release build from the repository's GitHub Releases.
 *
 * This updater does the install itself instead of Squirrel.Mac: it downloads
 * the release ZIP, unpacks it next to the app's state, and after the app quits
 * a detached shell swaps the bundle in place and reopens it.
 *
 * Before staging, the update must prove it came from us: the release's
 * Ed25519-signed manifest must cover the ZIP (see updateSignature.ts), and the
 * unpacked app must carry BusyBoy's Developer ID signature.
 */

export interface GitHubReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
}

export interface GitHubRelease {
  readonly tag_name: string;
  readonly body?: string | null;
  readonly assets: ReadonlyArray<GitHubReleaseAsset>;
}

export interface AvailableUpdate {
  readonly version: string;
  readonly releaseNotes: string;
  readonly zipName: string;
  readonly zipUrl: string;
}

const RELEASE_TAG_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

function versionParts(version: string): [number, number, number] | null {
  const match = RELEASE_TAG_PATTERN.exec(version.split("+")[0] ?? version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Positive when `a` is newer than `b`. Unparseable versions never win. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  if (left === null) return -1;
  if (right === null) return 1;
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Must match macZipAssetName in scripts/build-desktop-release.ts. */
export function zipAssetName(productName: string, version: string, arch: string): string {
  return `${productName}-${version}-${arch}.zip`;
}

export function resolveAvailableUpdate(input: {
  readonly release: GitHubRelease;
  readonly currentVersion: string;
  readonly productName: string;
  readonly arch: string;
}): AvailableUpdate | null {
  const version = input.release.tag_name.replace(/^v/, "");
  if (compareVersions(version, input.currentVersion) <= 0) return null;
  // Case-insensitive so a change in the product name's casing keeps matching.
  const assetName = zipAssetName(input.productName, version, input.arch).toLowerCase();
  const asset = input.release.assets.find(
    (candidate) => candidate.name.toLowerCase() === assetName,
  );
  if (asset === undefined) return null;
  return {
    version,
    releaseNotes: input.release.body ?? "",
    zipName: asset.name,
    zipUrl: asset.browser_download_url,
  };
}

/** `/Applications/BusyBoy.app/Contents/MacOS/BusyBoy` → `/Applications/BusyBoy.app`. */
export function resolveAppBundlePath(executablePath: string): string | null {
  const bundle = NodePath.resolve(executablePath, "../../..");
  return bundle.endsWith(".app") ? bundle : null;
}

// Waits for the app to exit, swaps the bundle (restoring the old one if the
// move fails), and reopens whichever bundle ended up in place unless the
// fourth argument is "no-reopen" (installing on quit).
export const INSTALL_SCRIPT = `
pid="$1"; target="$2"; staged="$3"; reopen="$4"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
backup="$target.previous"
rm -rf "$backup"
if mv "$target" "$backup"; then
  if mv "$staged" "$target"; then
    rm -rf "$backup"
  else
    mv "$backup" "$target"
  fi
fi
[ "$reopen" = "no-reopen" ] || open "$target"
`;

function spawnInstallScript(args: ReadonlyArray<string>): void {
  const child = NodeChildProcess.spawn(
    "/bin/sh",
    ["-c", INSTALL_SCRIPT, "busyboy-update", ...args],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

class GitHubReleaseUpdaterFailure extends Error {}

/** Must match APP_ID in scripts/build-desktop-release.ts and its Developer ID team. */
export const APP_CODE_REQUIREMENT =
  'anchor apple generic and identifier "dev.jiwon.busyboy" and certificate leaf[subject.OU] = "5PA4R2B5FF"';

/** Throws unless the app bundle carries BusyBoy's Developer ID signature. */
export function verifyAppCodeSignature(appPath: string): void {
  const result = NodeChildProcess.spawnSync(
    "codesign",
    ["--verify", "--deep", "--strict", `-R=${APP_CODE_REQUIREMENT}`, appPath],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new UpdateSignature.UpdateVerificationError(
      "The new app is not signed with BusyBoy's Apple Developer ID.",
    );
  }
}

export const make = Effect.fn("desktop.githubRelease.makeUpdater")(function* (input: {
  readonly owner: string;
  readonly repo: string;
  readonly productName: string;
  readonly currentVersion: string;
  readonly arch: string;
  readonly stagingDir: string;
  readonly quit: Effect.Effect<void>;
  /**
   * Calls `listener` when the app quits normally (exit code 0). The listener
   * is kept for the life of the process: see the comment where it is added.
   */
  readonly onQuit: (listener: () => void) => Effect.Effect<void, never, Scope.Scope>;
  /** Records what installing on quit did. It runs while the app exits, after logging stops. */
  readonly recordQuitInstall?: (message: string) => void;
  readonly fetch?: typeof globalThis.fetch;
  /** Tests swap these; release builds use the shipped key and codesign. */
  readonly publicKeys?: ReadonlyArray<string>;
  readonly verifyCodeSignature?: (appPath: string) => void;
  readonly appBundlePath?: string | null;
  readonly spawnInstaller?: (args: ReadonlyArray<string>) => void;
}) {
  const fetch = input.fetch ?? globalThis.fetch;
  const verifyCodeSignature = input.verifyCodeSignature ?? verifyAppCodeSignature;
  const spawnInstaller = input.spawnInstaller ?? spawnInstallScript;
  const userAgent = `${input.productName}/${input.currentVersion}`;
  const events = new NodeEvents.EventEmitter();
  let available: AvailableUpdate | null = null;
  let stagedApp: string | null = null;
  let installOnQuit = false;
  let installStarted = false;

  const fetchLatestRelease = async (): Promise<GitHubRelease | null> => {
    const response = await fetch(
      `https://api.github.com/repos/${input.owner}/${input.repo}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `${input.productName}/${input.currentVersion}`,
        },
      },
    );
    // No published release yet.
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new GitHubReleaseUpdaterFailure(
        `GitHub returned ${response.status} for the latest release.`,
      );
    }
    return (await response.json()) as GitHubRelease;
  };

  const download = async (update: AvailableUpdate): Promise<string> => {
    const versionDir = NodePath.join(input.stagingDir, update.version);
    NodeFS.rmSync(input.stagingDir, { recursive: true, force: true });
    // An unsigned or tampered release is refused before its ZIP is downloaded.
    const manifest = await UpdateSignature.fetchVerifiedManifest({
      owner: input.owner,
      repo: input.repo,
      version: update.version,
      fetch,
      userAgent,
      ...(input.publicKeys ? { publicKeys: input.publicKeys } : {}),
    });
    NodeFS.mkdirSync(versionDir, { recursive: true });

    const response = await fetch(update.zipUrl, {
      headers: { "User-Agent": userAgent },
    });
    if (!response.ok || response.body === null) {
      throw new GitHubReleaseUpdaterFailure(
        `Downloading ${update.zipUrl} failed with ${response.status}.`,
      );
    }
    const total = Number(response.headers.get("content-length") ?? 0);
    const zipPath = NodePath.join(versionDir, "update.zip");
    let received = 0;
    const progress = new NodeStream.Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.byteLength;
        if (total > 0) events.emit("download-progress", { percent: (received / total) * 100 });
        callback(null, chunk);
      },
    });
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.fromWeb(response.body as NodeStreamWeb.ReadableStream<Uint8Array>),
      progress,
      NodeFS.createWriteStream(zipPath),
    );

    await UpdateSignature.verifyUpdateFile({ manifest, path: zipPath, name: update.zipName });

    // ditto keeps the bundle's symlinks and signature intact.
    const extractDir = NodePath.join(versionDir, "app");
    const result = NodeChildProcess.spawnSync("ditto", ["-x", "-k", zipPath, extractDir], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new GitHubReleaseUpdaterFailure(`Unpacking the update failed: ${result.stderr.trim()}`);
    }
    NodeFS.rmSync(zipPath, { force: true });
    const app = NodeFS.readdirSync(extractDir).find((entry) => entry.endsWith(".app"));
    if (app === undefined) {
      throw new GitHubReleaseUpdaterFailure("The update archive does not contain an app bundle.");
    }
    const appPath = NodePath.join(extractDir, app);
    verifyCodeSignature(appPath);
    return appPath;
  };

  const prepareInstall = (staged: string, reopen: boolean): void => {
    const target =
      input.appBundlePath === undefined
        ? resolveAppBundlePath(NodeProcess.execPath)
        : input.appBundlePath;
    if (target === null) {
      throw new GitHubReleaseUpdaterFailure(
        `Cannot find the app bundle for ${NodeProcess.execPath}.`,
      );
    }
    if (target.startsWith("/Volumes/")) {
      throw new GitHubReleaseUpdaterFailure(
        `Move ${input.productName} to your Applications folder, open it from there, and update again.`,
      );
    }
    try {
      NodeFS.accessSync(NodePath.dirname(target), NodeFS.constants.W_OK);
    } catch {
      throw new GitHubReleaseUpdaterFailure(
        `${NodePath.dirname(target)} is not writable, so the update cannot replace ${target}.`,
      );
    }
    spawnInstaller([String(NodeProcess.pid), target, staged, reopen ? "reopen" : "no-reopen"]);
    installStarted = true;
  };

  const recordQuitInstall = input.recordQuitInstall ?? (() => {});
  // Only a staged app exists here, and it is staged only after verification.
  // A normal quit tears down the app's layers before Electron emits "quit",
  // so a listener tied to the layer scope would already be gone. Give it a
  // scope that is never closed.
  yield* input
    .onQuit(() => {
      if (!installOnQuit || installStarted || stagedApp === null) return;
      try {
        prepareInstall(stagedApp, false);
        recordQuitInstall(`Installing ${stagedApp} on quit.`);
      } catch (cause) {
        // The app is quitting; the staged update is offered again next launch.
        recordQuitInstall(
          `Could not install ${stagedApp} on quit: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    })
    .pipe(Scope.provide(Scope.makeUnsafe()));

  return ElectronUpdater.ElectronUpdater.of({
    // The feed is fixed to this repository's stable releases.
    setFeedURL: () => Effect.void,
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: (value) =>
      Effect.sync(() => {
        installOnQuit = value;
      }),
    setChannel: () => Effect.void,
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.succeed(false),
    setAllowDowngrade: () => Effect.void,
    setFullChangelog: () => Effect.void,
    setDisableDifferentialDownload: () => Effect.void,

    checkForUpdates: Effect.tryPromise({
      try: async () => {
        events.emit("checking-for-update");
        const release = await fetchLatestRelease();
        available =
          release === null
            ? null
            : resolveAvailableUpdate({
                release,
                currentVersion: input.currentVersion,
                productName: input.productName,
                arch: input.arch,
              });
        if (available === null) {
          events.emit("update-not-available");
          return;
        }
        events.emit("update-available", {
          version: available.version,
          releaseNotes: available.releaseNotes,
        });
      },
      catch: (cause) =>
        new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({ channel: null, cause }),
    }),

    downloadUpdate: Effect.tryPromise({
      try: async () => {
        if (available === null) {
          throw new GitHubReleaseUpdaterFailure("No update is available to download.");
        }
        stagedApp = null;
        try {
          stagedApp = await download(available);
        } catch (cause) {
          // Never leave a refused or partial update where it could be installed.
          NodeFS.rmSync(input.stagingDir, { recursive: true, force: true });
          throw cause;
        }
        events.emit("update-downloaded", { version: available.version });
      },
      catch: (cause) =>
        new ElectronUpdater.ElectronUpdaterDownloadUpdateError({ channel: null, cause }),
    }),

    quitAndInstall: ({ isSilent, isForceRunAfter }) =>
      Effect.try({
        try: () => {
          if (stagedApp === null) {
            throw new GitHubReleaseUpdaterFailure("No downloaded update is ready to install.");
          }
          if (installStarted) {
            throw new GitHubReleaseUpdaterFailure("The update is already installing.");
          }
          prepareInstall(stagedApp, true);
        },
        catch: (cause) =>
          new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
            channel: null,
            isSilent,
            isForceRunAfter,
            cause,
          }),
      }).pipe(Effect.andThen(input.quit)),

    on: (eventName, listener) => {
      const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
      return Effect.acquireRelease(
        Effect.sync(() => {
          events.on(eventName, untypedListener);
        }),
        () =>
          Effect.sync(() => {
            events.removeListener(eventName, untypedListener);
          }),
      ).pipe(Effect.asVoid);
    },
  });
});

/** True for the failures whose message is written for the user. */
export const isGitHubReleaseUpdaterFailure = (cause: unknown): cause is Error =>
  cause instanceof GitHubReleaseUpdaterFailure;

// Matches PRODUCT_NAME in scripts/build-desktop-release.ts, which names the ZIP.
const PRODUCT_NAME = "BusyBoy";

/** Reads `owner` and `repo` from the github feed electron-builder writes to app-update.yml. */
export function parseGitHubFeed(appUpdateYml: string): { owner: string; repo: string } | null {
  const entries: Record<string, string> = {};
  for (const line of appUpdateYml.split("\n")) {
    const match = /^(\w+):\s*(.+)$/.exec(line);
    if (match?.[1] && match[2]) entries[match[1]] = match[2].trim();
  }
  if (entries.provider !== "github" || !entries.owner || !entries.repo) return null;
  return { owner: entries.owner, repo: entries.repo };
}

/**
 * Checks electron-updater's Windows installer against the release's signed
 * manifest. Unsigned builds have no publisherName, so electron-updater's own
 * check only compares against latest.yml from the same, possibly tampered,
 * release.
 */
export function makeWindowsDownloadVerifier(input: {
  readonly owner: string;
  readonly repo: string;
  readonly userAgent: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly publicKeys?: ReadonlyArray<string>;
}): ElectronUpdater.VerifyDownload {
  return async ({ version, files }) => {
    const manifest = await UpdateSignature.fetchVerifiedManifest({
      owner: input.owner,
      repo: input.repo,
      version,
      fetch: input.fetch ?? globalThis.fetch,
      userAgent: input.userAgent,
      ...(input.publicKeys ? { publicKeys: input.publicKeys } : {}),
    });
    for (const path of files) {
      await UpdateSignature.verifyUpdateFile({ manifest, path });
    }
  };
}

/**
 * Packaged builds with a GitHub feed verify every update before installing it:
 * macOS through this updater, Windows through electron-updater plus the signed
 * manifest. Development builds use electron-updater as is.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const feed =
      environment.isPackaged &&
      (environment.platform === "darwin" || environment.platform === "win32")
        ? yield* Effect.sync(() => {
            try {
              return parseGitHubFeed(NodeFS.readFileSync(environment.appUpdateYmlPath, "utf8"));
            } catch {
              return null;
            }
          })
        : null;
    if (feed === null) {
      return ElectronUpdater.layer;
    }

    if (environment.platform === "win32") {
      return Layer.succeed(
        ElectronUpdater.ElectronUpdater,
        ElectronUpdater.makeVerified(
          makeWindowsDownloadVerifier({
            ...feed,
            userAgent: `${PRODUCT_NAME}/${environment.appVersion}`,
          }),
        ),
      );
    }

    const electronApp = yield* ElectronApp.ElectronApp;
    return Layer.succeed(
      ElectronUpdater.ElectronUpdater,
      yield* make({
        ...feed,
        productName: PRODUCT_NAME,
        currentVersion: environment.appVersion,
        arch: NodeProcess.arch,
        stagingDir: environment.path.join(environment.stateDir, "pending-update"),
        quit: electronApp.quit,
        onQuit: (listener) =>
          electronApp.on("quit", (_event: unknown, exitCode: number) => {
            if (exitCode === 0) listener();
          }),
        recordQuitInstall: (message) => {
          try {
            NodeFS.mkdirSync(environment.logDir, { recursive: true });
            NodeFS.appendFileSync(
              environment.path.join(environment.logDir, "update-install.log"),
              `${DateTime.formatIso(DateTime.nowUnsafe())} ${message}\n`,
            );
          } catch {
            // Best effort: the app is exiting.
          }
        },
      }),
    );
  }),
);
