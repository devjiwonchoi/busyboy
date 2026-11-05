#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A plain build script that shells out to pnpm, cargo, and electron-builder.
// Packages BusyBoy for macOS as a DMG (for first installs) and a ZIP (for the
// in-app updater). A trimmed, mac-only port of t3code's build-desktop-artifact.
//
//   node scripts/build-desktop-release.ts --version 0.0.3 [--skip-build] [--out release]
//
// The build stages the bundled desktop and server output into a temporary
// directory, installs only their runtime-external packages there, and runs
// electron-builder against it. The app is signed with a Developer ID and
// notarized, so the build fails without signing and notarization credentials:
//   signing:      a Developer ID Application identity in the keychain, or CSC_LINK + CSC_KEY_PASSWORD
//   notarization: APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_KEYCHAIN_PROFILE
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";
import { selectDesktopRuntimeExternalDependencies } from "./lib/desktop-external-packages.ts";

export const PRODUCT_NAME = "BusyBoy";
export const APP_ID = "dev.jiwon.busyboy";
export const UPDATE_REPOSITORY = { owner: "devjiwonchoi", repo: "busyboy" } as const;

// The in-app updater downloads this asset; keep the two in sync.
export function macZipAssetName(version: string, arch: string): string {
  return `${PRODUCT_NAME}-${version}-${arch}.zip`;
}

// Their versions show up in the app and server, so the build stamps them.
const RELEASE_PACKAGE_FILES = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
] as const;

const FILE_EXCLUSIONS = [
  "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
  "!**/*.map",
  "!**/*.d.cts",
  "!apps/desktop/resources/browser-secret",
  "!apps/desktop/resources/browser-secret/**/*",
  "!apps/desktop/prod-resources/browser-secret",
  "!apps/desktop/prod-resources/browser-secret/**/*",
  "!**/node_modules/node-pty/prebuilds/win32-*/**/*",
  "!**/node_modules/node-pty/third_party/conpty/**/*",
];

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

// Same values as apps/desktop/scripts/build-computer-use.mjs.
export const COMPUTER_USE_BUNDLE_NAME = "BusyBoy Computer Use.app";
const COMPUTER_USE_EXECUTABLE = "busyboy-computer-use";
export const COMPUTER_USE_REQUIREMENT =
  'anchor apple generic and identifier "dev.jiwon.busyboy.computer-use" and certificate leaf[subject.OU] = "5PA4R2B5FF"';
const COMPUTER_USE_DEV_CALLERS_MARKER = "BUSYBOY_CU_DEV_CALLERS_ENABLED";
// electron-builder signs the outer app ad hoc; re-signing the helper that way
// would drop its Developer ID signature and every TCC grant tied to it.
export const COMPUTER_USE_SIGN_IGNORE = "computer-use/BusyBoy Computer Use\\.app";
// Shipped through extraResources only, with its own signature.
const COMPUTER_USE_FILE_EXCLUSIONS = [
  "!apps/desktop/resources/computer-use",
  "!apps/desktop/resources/computer-use/**/*",
  "!apps/desktop/prod-resources/computer-use",
  "!apps/desktop/prod-resources/computer-use/**/*",
];
// Electron fuses for the release app. The app holds the user's macOS permissions, its
// keychain items, and the Computer Use helper's trust, so no other program may run code
// as BusyBoy: Node mode, NODE_OPTIONS, and the inspector are off, and Electron only runs
// the integrity-checked app.asar.
export const ELECTRON_FUSES = {
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
} as const;

// Fuse wire layout from @electron/fuses: sentinel, version byte, length byte, then one
// byte per fuse ("1" on, "0" off) in this order.
const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
const FUSE_ORDER = [
  "runAsNode",
  "enableCookieEncryption",
  "enableNodeOptionsEnvironmentVariable",
  "enableNodeCliInspectArguments",
  "enableEmbeddedAsarIntegrityValidation",
  "onlyLoadAppFromAsar",
] as const;

// The server runs outside app.asar on its own Node, because Electron's Node mode is off.
// Same Node as Electron 44 embeds; the hashes are from nodejs.org's SHASUMS256.txt.
export const SERVER_NODE_VERSION = "24.21.0";
const SERVER_NODE_SHA256: Readonly<Record<string, string>> = {
  arm64: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
  x64: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
};
// Staged inside the app project so extraResources can copy it; kept out of app.asar.
const SERVER_STAGE_DIR = "server-runtime";
export const SERVER_NODE_PATH = "Contents/Resources/server/bin/busyboy-node";
const SERVER_STAGE_EXCLUSIONS = [`!${SERVER_STAGE_DIR}`, `!${SERVER_STAGE_DIR}/**/*`];
// electron-builder's default entitlements minus disable-library-validation, so a copy of
// the app can't be made to load a dylib or .node addon signed by someone else.
const ENTITLEMENTS = "apps/desktop/resources/entitlements.mac.plist";

export interface ReleaseOptions {
  /** Bundle the computer-use helper (`--computer-use`). Off by default. */
  readonly computerUse: boolean;
}

const DEFAULT_RELEASE_OPTIONS: ReleaseOptions = { computerUse: false };

const repoRoot = NodePath.resolve(import.meta.dirname, "..");

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(NodeFS.readFileSync(NodePath.join(repoRoot, relativePath), "utf8"));
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnSyncOptions = {},
) {
  console.log(`[release] $ ${command} ${args.join(" ")}`);
  const result = NodeChildProcess.spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  }
}

export function resolveCatalogDependencies(
  dependencies: Readonly<Record<string, string>>,
  catalog: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, spec]) => {
      if (!spec.startsWith("catalog:")) return [name, spec];
      const selector = name.split(">").at(-1) ?? name;
      const versionIndex = selector.indexOf("@", 1);
      const packageName = versionIndex === -1 ? selector : selector.slice(0, versionIndex);
      const key = spec.slice("catalog:".length).trim() || packageName;
      const resolved = catalog[key];
      if (!resolved) throw new Error(`No catalog entry '${key}' for dependency '${name}'.`);
      return [name, resolved];
    }),
  );
}

// Pin each package to the exact version the repo's lockfile installed, so the
// stage ships what was tested and the workspace patches still apply.
function pinInstalledVersions(
  dependencies: Readonly<Record<string, string>>,
  packageDir: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, spec]) => {
      const manifest = NodePath.join(repoRoot, packageDir, "node_modules", name, "package.json");
      if (!NodeFS.existsSync(manifest)) return [name, spec];
      return [name, JSON.parse(NodeFS.readFileSync(manifest, "utf8")).version as string];
    }),
  );
}

function patchPackageName(patchKey: string): string {
  const versionSeparator = patchKey.lastIndexOf("@");
  return versionSeparator > 0 ? patchKey.slice(0, versionSeparator) : patchKey;
}

function withReleaseVersions<T>(version: string, body: () => T): T {
  const originals = RELEASE_PACKAGE_FILES.map((file) => {
    const filePath = NodePath.join(repoRoot, file);
    return { filePath, contents: NodeFS.readFileSync(filePath, "utf8") };
  });
  try {
    for (const { filePath, contents } of originals) {
      const manifest = JSON.parse(contents);
      manifest.version = version;
      NodeFS.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    return body();
  } finally {
    for (const { filePath, contents } of originals) NodeFS.writeFileSync(filePath, contents);
  }
}

function stageIcons(resourcesDir: string) {
  const sourcePng = NodePath.join(repoRoot, "assets/busyboy.png");
  const iconsetDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "busyboy-iconset-"));
  const iconset = NodePath.join(iconsetDir, "icon.iconset");
  NodeFS.mkdirSync(iconset);
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const [scale, suffix] of [
        [1, ""],
        [2, "@2x"],
      ] as const) {
        const pixels = String(size * scale);
        run(
          "sips",
          [
            "-z",
            pixels,
            pixels,
            sourcePng,
            "--out",
            NodePath.join(iconset, `icon_${size}x${size}${suffix}.png`),
          ],
          { stdio: "ignore" },
        );
      }
    }
    run("iconutil", ["-c", "icns", iconset, "-o", NodePath.join(resourcesDir, "icon.icns")]);
    NodeFS.copyFileSync(sourcePng, NodePath.join(resourcesDir, "icon.png"));
  } finally {
    NodeFS.rmSync(iconsetDir, { recursive: true, force: true });
  }
}

function stageResourceMonitor(resourcesDir: string) {
  run("cargo", [
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    NodePath.join(repoRoot, "native/resource-monitor/Cargo.toml"),
  ]);
  const destination = NodePath.join(resourcesDir, "resource-monitor");
  NodeFS.mkdirSync(destination, { recursive: true });
  const target = NodePath.join(destination, "t3-resource-monitor");
  NodeFS.copyFileSync(
    NodePath.join(repoRoot, "native/resource-monitor/target/release/t3-resource-monitor"),
    target,
  );
  NodeFS.chmodSync(target, 0o755);
}

function stageComputerUse(resourcesDir: string) {
  run(process.execPath, [
    NodePath.join(repoRoot, "apps/desktop/scripts/build-computer-use.mjs"),
    "--release",
    "--output",
    NodePath.join(resourcesDir, "computer-use"),
  ]);
  checkComputerUseHelper(NodePath.join(resourcesDir, "computer-use", COMPUTER_USE_BUNDLE_NAME));
}

/**
 * Release gate for a staged or packaged helper: a Developer ID signature that
 * meets BusyBoy's requirement, and no dev-callers path compiled in.
 */
export function checkComputerUseHelper(
  bundle: string,
  verify: (bundle: string) => void = (path) =>
    run("codesign", ["--verify", "--strict", "--deep", `-R=${COMPUTER_USE_REQUIREMENT}`, path]),
) {
  const executable = NodePath.join(bundle, "Contents/MacOS", COMPUTER_USE_EXECUTABLE);
  if (!NodeFS.existsSync(executable)) throw new Error(`Missing computer-use helper at ${bundle}.`);
  if (NodeFS.readFileSync(executable).includes(COMPUTER_USE_DEV_CALLERS_MARKER)) {
    throw new Error(`The computer-use helper at ${bundle} was built with dev-callers.`);
  }
  verify(bundle);
}

/** Downloads the server's Node, checks it against the pinned hash, and stages it. */
function stageServerNode(serverStage: string, arch: string, scratch: string) {
  const expected = SERVER_NODE_SHA256[arch];
  if (!expected) throw new Error(`No pinned Node ${SERVER_NODE_VERSION} for arch '${arch}'.`);
  const name = `node-v${SERVER_NODE_VERSION}-darwin-${arch}`;
  const archive = NodePath.join(scratch, `${name}.tar.gz`);
  run("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--output",
    archive,
    `https://nodejs.org/dist/v${SERVER_NODE_VERSION}/${name}.tar.gz`,
  ]);
  const actual = NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(archive)).digest("hex");
  if (actual !== expected) {
    throw new Error(`${name}.tar.gz has sha256 ${actual}, expected ${expected}.`);
  }
  run("tar", ["-xzf", archive, "-C", scratch, `${name}/bin/node`, `${name}/LICENSE`]);
  const binDir = NodePath.join(serverStage, "bin");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.copyFileSync(
    NodePath.join(scratch, name, "bin/node"),
    NodePath.join(binDir, "busyboy-node"),
  );
  NodeFS.chmodSync(NodePath.join(binDir, "busyboy-node"), 0o755);
  NodeFS.copyFileSync(
    NodePath.join(scratch, name, "LICENSE"),
    NodePath.join(binDir, "NODE_LICENSE"),
  );
}

/** Reads Electron's fuse wire from a framework binary; `undefined` when absent. */
export function readFuses(binary: Buffer): Partial<Record<(typeof FUSE_ORDER)[number], boolean>> {
  const at = binary.indexOf(FUSE_SENTINEL);
  if (at === -1) throw new Error("The Electron framework has no fuse wire.");
  const length = binary[at + FUSE_SENTINEL.length + 1] ?? 0;
  const wire = binary.subarray(
    at + FUSE_SENTINEL.length + 2,
    at + FUSE_SENTINEL.length + 2 + length,
  );
  return Object.fromEntries(
    FUSE_ORDER.slice(0, length).map((fuse, index) => [fuse, wire[index] === 0x31]),
  );
}

function captured(command: string, args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

/**
 * Release gate: the fuses are set, no binary may load someone else's libraries, and the
 * server's Node is signed under its own identifier, never the app's, so the Computer Use
 * helper (which trusts the app's identifier) does not trust it.
 */
export function checkPackagedHardening(app: string) {
  const framework = NodePath.join(
    app,
    "Contents/Frameworks/Electron Framework.framework/Electron Framework",
  );
  const fuses = readFuses(NodeFS.readFileSync(framework));
  for (const [fuse, wanted] of Object.entries(ELECTRON_FUSES)) {
    if (fuses[fuse as keyof typeof fuses] !== wanted) {
      throw new Error(
        `Fuse ${fuse} is ${String(fuses[fuse as keyof typeof fuses])}, expected ${wanted}.`,
      );
    }
  }
  const plist = NodeFS.readFileSync(NodePath.join(app, "Contents/Info.plist"), "utf8");
  if (!plist.includes("ElectronAsarIntegrity")) {
    throw new Error(
      "Info.plist has no ElectronAsarIntegrity, so the asar check would fail closed.",
    );
  }
  for (const binary of [app, NodePath.join(app, SERVER_NODE_PATH)]) {
    const entitlements = captured("codesign", ["-d", "--entitlements", "-", "--xml", binary]);
    if (entitlements.includes("disable-library-validation")) {
      throw new Error(`${binary} is signed with disable-library-validation.`);
    }
  }
  const node = captured("codesign", ["-dv", NodePath.join(app, SERVER_NODE_PATH)]);
  const identifier = /^Identifier=(.*)$/m.exec(node)?.[1];
  if (!identifier || identifier === APP_ID) {
    throw new Error(
      `The server's Node is signed as '${identifier}', which the helper would trust.`,
    );
  }
}

/** electron-builder's `.app` output: `dist/mac-arm64/BusyBoy.app`, or `dist/mac` for x64. */
function findPackagedApp(distDir: string): string {
  for (const entry of NodeFS.readdirSync(distDir)) {
    const app = NodePath.join(distDir, entry, `${PRODUCT_NAME}.app`);
    if (entry.startsWith("mac") && NodeFS.existsSync(app)) return app;
  }
  throw new Error(`electron-builder produced no ${PRODUCT_NAME}.app in ${distDir}.`);
}

export function createBuilderConfig(
  version: string,
  release: ReleaseOptions = DEFAULT_RELEASE_OPTIONS,
  // codesign runs from another directory, so the stage passes its absolute path.
  projectDir = "",
) {
  const entitlements = NodePath.join(projectDir, ENTITLEMENTS);
  return {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    artifactName: `${PRODUCT_NAME}-\${version}-\${arch}.\${ext}`,
    electronLanguages: ["en-US"],
    files: release.computerUse
      ? [...FILE_EXCLUSIONS, ...SERVER_STAGE_EXCLUSIONS, ...COMPUTER_USE_FILE_EXCLUSIONS]
      : [...FILE_EXCLUSIONS, ...SERVER_STAGE_EXCLUSIONS],
    electronFuses: ELECTRON_FUSES,
    directories: { buildResources: "apps/desktop/resources" },
    extraResources: [
      { from: "apps/desktop/prod-resources/resource-monitor", to: "resource-monitor" },
      {
        // electron-builder always drops a node_modules at the root of `from`, so the server
        // sits one level down, and a pattern naming node_modules keeps it from being skipped.
        from: SERVER_STAGE_DIR,
        to: ".",
        filter: [
          "server/**/*",
          "server/node_modules/**/*",
          "!server/pnpm-lock.yaml",
          "!server/pnpm-workspace.yaml",
          // `files` exclusions don't reach extra resources.
          ...FILE_EXCLUSIONS,
        ],
      },
      ...(release.computerUse
        ? [{ from: "apps/desktop/prod-resources/computer-use", to: "computer-use" }]
        : []),
    ],
    // Writes resources/app-update.yml, which turns the in-app updater on.
    publish: [{ provider: "github", ...UPDATE_REPOSITORY, releaseType: "release" }],
    // Fail instead of shipping an unsigned app when no Developer ID is found.
    forceCodeSigning: true,
    mac: {
      target: ["dmg", "zip"],
      icon: "icon.icns",
      category: "public.app-category.developer-tools",
      entitlements,
      entitlementsInherit: entitlements,
      // The helper is signed by its own build; keep electron-builder from re-signing it.
      ...(release.computerUse ? { signIgnore: [COMPUTER_USE_SIGN_IGNORE] } : {}),
      extendInfo: {
        NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac: true,
        NSScreenCaptureUsageDescription:
          "BusyBoy captures the active window when you use the snapshot shortcut.",
        NSDocumentsFolderUsageDescription:
          "BusyBoy reads project files you open in the desktop app.",
        NSLocalNetworkUsageDescription:
          "BusyBoy connects to devices on your local network for remote environments and commands run by terminals and coding agents.",
      },
      protocols: [{ name: PRODUCT_NAME, schemes: ["busyboy"] }],
    },
    dmg: {
      title: `${PRODUCT_NAME} ${version}`,
      contents: [
        { x: 166, y: 214, type: "file" },
        { x: 474, y: 214, type: "link", path: "/Applications" },
      ],
    },
  };
}

export function buildDesktopRelease(options: {
  readonly version: string;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly arch: string;
  readonly release?: ReleaseOptions;
}) {
  const { version, arch } = options;
  const release = options.release ?? DEFAULT_RELEASE_OPTIONS;
  if (!VERSION_PATTERN.test(version)) throw new Error(`Version '${version}' is not x.y.z.`);

  // electron-builder only warns and skips notarization without credentials,
  // so check before the long build instead of shipping an app Gatekeeper blocks.
  if (!process.env.APPLE_API_KEY && !process.env.APPLE_KEYCHAIN_PROFILE) {
    throw new Error(
      "Notarization needs APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER, or APPLE_KEYCHAIN_PROFILE.",
    );
  }

  if (!options.skipBuild) {
    withReleaseVersions(version, () =>
      run("pnpm", ["build"], { cwd: repoRoot, env: { ...process.env, APP_VERSION: version } }),
    );
  }

  const workspace = parseYaml(
    NodeFS.readFileSync(NodePath.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
  );
  const catalog: Record<string, string> = workspace.catalog ?? {};
  const serverPackage = readJson("apps/server/package.json");
  const desktopPackage = readJson("apps/desktop/package.json");

  // The app (app.asar) and the server (Resources/server) each get only their own externals.
  const dependencies = pinInstalledVersions(
    selectDesktopRuntimeExternalDependencies(
      resolveCatalogDependencies(desktopPackage.dependencies, catalog),
    ),
    "apps/desktop",
  );
  const serverDependencies = {
    ...pinInstalledVersions(
      selectCliRuntimeExternalDependencies(
        resolveCatalogDependencies(serverPackage.dependencies, catalog),
      ),
      "apps/server",
    ),
    // fff-node loads its prebuilt binary from a platform package.
    [`@ff-labs/fff-bin-darwin-${arch}`]: serverPackage.dependencies["@ff-labs/fff-node"],
  };

  const stageRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "busyboy-release-stage-"));
  const stageApp = NodePath.join(stageRoot, "app");
  try {
    console.log(`[release] Staging ${PRODUCT_NAME} ${version} (${arch}) in ${stageApp}`);
    const copy = (from: string, to: string) =>
      NodeFS.cpSync(NodePath.join(repoRoot, from), NodePath.join(stageApp, to), {
        recursive: true,
      });
    copy("apps/desktop/dist-electron", "apps/desktop/dist-electron");
    copy("apps/desktop/resources", "apps/desktop/resources");
    // The window's UI is served from app.asar; the server keeps its own full copy.
    copy("apps/server/dist/client", "apps/server/dist/client");
    const serverStage = NodePath.join(stageApp, SERVER_STAGE_DIR, "server");
    copy("apps/server/dist", NodePath.join(SERVER_STAGE_DIR, "server/apps/server/dist"));
    copy(
      "apps/desktop/dist-electron/compileCache.cjs",
      NodePath.join(SERVER_STAGE_DIR, "server/compileCache.cjs"),
    );
    const resourcesDir = NodePath.join(stageApp, "apps/desktop/resources");
    stageIcons(resourcesDir);
    stageResourceMonitor(resourcesDir);
    if (release.computerUse) stageComputerUse(resourcesDir);
    // electron-builder drops buildResources from the packaged app; extraResources read this copy.
    NodeFS.cpSync(resourcesDir, NodePath.join(stageApp, "apps/desktop/prod-resources"), {
      recursive: true,
    });

    // pnpm refuses patches for packages a stage doesn't install, so each stage gets its own.
    const patchesFor = (stageDependencies: Record<string, string>) =>
      Object.fromEntries(
        Object.entries((workspace.patchedDependencies ?? {}) as Record<string, string>).filter(
          ([key]) => Object.hasOwn(stageDependencies, patchPackageName(key)),
        ),
      );
    const patchedDependencies = patchesFor(dependencies);
    const serverPatches = patchesFor(serverDependencies);
    if (Object.keys({ ...patchedDependencies, ...serverPatches }).length > 0)
      copy("patches", "patches");

    const rootPackage = readJson("package.json");
    NodeFS.writeFileSync(
      NodePath.join(stageApp, "package.json"),
      `${JSON.stringify(
        {
          name: "busyboy",
          productName: PRODUCT_NAME,
          version,
          private: true,
          description: "BusyBoy desktop app for coding agents.",
          author: "Jiwon Choi",
          license: "MIT",
          main: "apps/desktop/dist-electron/boot.cjs",
          packageManager: rootPackage.packageManager,
          build: createBuilderConfig(version, release, stageApp),
          dependencies,
          devDependencies: { electron: desktopPackage.dependencies.electron },
        },
        null,
        2,
      )}\n`,
    );
    const stageWorkspace = (patches: Record<string, string>) =>
      stringifyYaml({
        nodeLinker: "hoisted",
        supportedArchitectures: { os: ["darwin"], cpu: [arch] },
        allowBuilds: workspace.allowBuilds ?? {},
        overrides: resolveCatalogDependencies(workspace.overrides ?? {}, catalog),
        patchedDependencies: patches,
        // TypeScript is a typings-only peer; auto-installing it would ship a compiler.
        packageExtensions: {
          "electron-webauthn": { peerDependenciesMeta: { typescript: { optional: true } } },
          "@electron-webauthn/macos": { peerDependenciesMeta: { typescript: { optional: true } } },
        },
      });
    NodeFS.writeFileSync(
      NodePath.join(stageApp, "pnpm-workspace.yaml"),
      stageWorkspace(patchedDependencies),
    );
    run("pnpm", ["install", "--prod"], { cwd: stageApp });

    NodeFS.writeFileSync(
      NodePath.join(serverStage, "package.json"),
      `${JSON.stringify(
        {
          name: "busyboy-server",
          version,
          private: true,
          packageManager: rootPackage.packageManager,
          dependencies: serverDependencies,
        },
        null,
        2,
      )}\n`,
    );
    // Patch paths are relative to the project, so the server stage points two levels up.
    NodeFS.writeFileSync(
      NodePath.join(serverStage, "pnpm-workspace.yaml"),
      stageWorkspace(
        Object.fromEntries(
          Object.entries(serverPatches).map(([key, file]) => [key, `../../${file}`]),
        ),
      ),
    );
    run("pnpm", ["install", "--prod"], { cwd: serverStage });
    stageServerNode(serverStage, arch, stageRoot);

    run(
      "pnpm",
      [
        "exec",
        "electron-builder",
        "--projectDir",
        stageApp,
        "--mac",
        `--${arch}`,
        "--publish",
        "never",
      ],
      { cwd: NodePath.join(repoRoot, "apps/desktop") },
    );

    // Gatekeeper's own check that the packaged app is signed and notarized.
    const distDir = NodePath.join(stageApp, "dist");
    run("spctl", [
      "--assess",
      "--type",
      "execute",
      "-vv",
      // electron-builder puts x64 apps in mac/ and other arches in mac-<arch>/.
      NodePath.join(distDir, arch === "x64" ? "mac" : `mac-${arch}`, `${PRODUCT_NAME}.app`),
    ]);
    checkPackagedHardening(findPackagedApp(distDir));
    if (release.computerUse) {
      // The DMG and ZIP are made from this app, so its helper is the one users get.
      checkComputerUseHelper(
        NodePath.join(
          findPackagedApp(distDir),
          "Contents/Resources/computer-use",
          COMPUTER_USE_BUNDLE_NAME,
        ),
      );
    }

    NodeFS.mkdirSync(options.outputDir, { recursive: true });
    const artifacts: Array<string> = [];
    for (const entry of NodeFS.readdirSync(distDir)) {
      if (!/\.(dmg|zip|yml|blockmap)$/.test(entry)) continue;
      const to = NodePath.join(options.outputDir, entry);
      NodeFS.copyFileSync(NodePath.join(distDir, entry), to);
      artifacts.push(to);
    }
    if (!artifacts.some((file) => file.endsWith(macZipAssetName(version, arch)))) {
      throw new Error(`electron-builder did not produce ${macZipAssetName(version, arch)}.`);
    }
    console.log(`[release] Artifacts:\n${artifacts.map((file) => `  ${file}`).join("\n")}`);
    return artifacts;
  } finally {
    if (process.env.BUSYBOY_KEEP_STAGE === "1") {
      console.log(`[release] Kept stage at ${stageRoot}`);
    } else {
      NodeFS.rmSync(stageRoot, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      version: { type: "string" },
      out: { type: "string", default: "release" },
      arch: { type: "string", default: "arm64" },
      "skip-build": { type: "boolean", default: false },
      "computer-use": { type: "boolean", default: false },
    },
  });
  if (!values.version) {
    console.error(
      "usage: build-desktop-release.ts --version x.y.z [--out dir] [--arch arm64] [--skip-build] [--computer-use]",
    );
    process.exit(1);
  }
  buildDesktopRelease({
    version: values.version,
    outputDir: NodePath.resolve(repoRoot, values.out),
    skipBuild: values["skip-build"],
    arch: values.arch,
    release: { computerUse: values["computer-use"] },
  });
}
