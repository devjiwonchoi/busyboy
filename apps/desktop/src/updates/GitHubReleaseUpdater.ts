// @effect-diagnostics nodeBuiltinImport:off -- The installer must outlive the app, so it spawns a detached Node child process and writes the bundle with Node APIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import type * as NodeStreamWeb from "node:stream/web";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";

/**
 * Updates a macOS release build from the repository's GitHub Releases.
 *
 * Release builds are ad-hoc signed, and Squirrel.Mac (behind electron-updater)
 * refuses to install an update whose signature does not match the running
 * app's. So this updater does the install itself: it downloads the release
 * ZIP, unpacks it next to the app's state, and after the app quits a detached
 * shell swaps the bundle in place and reopens it.
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
    zipUrl: asset.browser_download_url,
  };
}

/** `/Applications/BusyBoy.app/Contents/MacOS/BusyBoy` → `/Applications/BusyBoy.app`. */
export function resolveAppBundlePath(executablePath: string): string | null {
  const bundle = NodePath.resolve(executablePath, "../../..");
  return bundle.endsWith(".app") ? bundle : null;
}

// Waits for the app to exit, swaps the bundle (restoring the old one if the
// move fails), and reopens whichever bundle ended up in place.
export const INSTALL_SCRIPT = `
pid="$1"; target="$2"; staged="$3"
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
open "$target"
`;

class GitHubReleaseUpdaterFailure extends Error {}

export const make = Effect.fn("desktop.githubRelease.makeUpdater")(function* (input: {
  readonly owner: string;
  readonly repo: string;
  readonly productName: string;
  readonly currentVersion: string;
  readonly arch: string;
  readonly stagingDir: string;
  readonly quit: Effect.Effect<void>;
  readonly fetch?: typeof globalThis.fetch;
}) {
  const fetch = input.fetch ?? globalThis.fetch;
  const events = new NodeEvents.EventEmitter();
  let available: AvailableUpdate | null = null;
  let stagedApp: string | null = null;

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
    NodeFS.mkdirSync(versionDir, { recursive: true });

    const response = await fetch(update.zipUrl, {
      headers: { "User-Agent": `${input.productName}/${input.currentVersion}` },
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
    return NodePath.join(extractDir, app);
  };

  const prepareInstall = (staged: string): void => {
    const target = resolveAppBundlePath(NodeProcess.execPath);
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
    const child = NodeChildProcess.spawn(
      "/bin/sh",
      ["-c", INSTALL_SCRIPT, "busyboy-update", String(NodeProcess.pid), target, staged],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  };

  return ElectronUpdater.ElectronUpdater.of({
    // The feed is fixed to this repository's stable releases.
    setFeedURL: () => Effect.void,
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: () => Effect.void,
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
        stagedApp = await download(available);
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
          prepareInstall(stagedApp);
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

/** Packaged macOS builds with a GitHub feed update here; everything else uses electron-updater. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const feed =
      environment.isPackaged && environment.platform === "darwin"
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
      }),
    );
  }),
);
