#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A plain build script that shells out to pnpm, cargo, and electron-builder.
// Packages BusyBoy for macOS as a DMG (for first installs) and a ZIP (for the
// in-app updater). A trimmed, mac-only port of t3code's build-desktop-artifact.
//
//   node scripts/build-desktop-release.ts --version 0.0.3 [--skip-build] [--out release]
//
// The build stages the bundled desktop and server output into a temporary
// directory, installs only their runtime-external packages there, and runs
// electron-builder against it. The app is ad-hoc signed, not notarized.
import * as NodeChildProcess from "node:child_process";
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

function createBuilderConfig(version: string) {
  return {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    artifactName: `${PRODUCT_NAME}-\${version}-\${arch}.\${ext}`,
    electronLanguages: ["en-US"],
    files: FILE_EXCLUSIONS,
    directories: { buildResources: "apps/desktop/resources" },
    extraResources: [
      { from: "apps/desktop/prod-resources/resource-monitor", to: "resource-monitor" },
    ],
    // Writes resources/app-update.yml, which turns the in-app updater on.
    publish: [{ provider: "github", ...UPDATE_REPOSITORY, releaseType: "release" }],
    mac: {
      target: ["dmg", "zip"],
      icon: "icon.icns",
      category: "public.app-category.developer-tools",
      // Ad-hoc signature: Apple Silicon needs one to run, and there is no Developer ID.
      identity: "-",
      hardenedRuntime: false,
      notarize: false,
      extendInfo: {
        NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac: true,
        NSScreenCaptureUsageDescription:
          "BusyBoy captures the active window when you use the snapshot shortcut.",
        NSDocumentsFolderUsageDescription:
          "BusyBoy reads project files you open in the desktop app.",
        NSLocalNetworkUsageDescription:
          "BusyBoy connects to devices on your local network for remote environments and commands run by terminals and coding agents.",
      },
      protocols: [{ name: PRODUCT_NAME, schemes: ["t3code"] }],
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
}) {
  const { version, arch } = options;
  if (!VERSION_PATTERN.test(version)) throw new Error(`Version '${version}' is not x.y.z.`);

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

  const dependencies = {
    ...pinInstalledVersions(
      selectCliRuntimeExternalDependencies(
        resolveCatalogDependencies(serverPackage.dependencies, catalog),
      ),
      "apps/server",
    ),
    ...pinInstalledVersions(
      selectDesktopRuntimeExternalDependencies(
        resolveCatalogDependencies(desktopPackage.dependencies, catalog),
      ),
      "apps/desktop",
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
    copy("apps/server/dist", "apps/server/dist");
    const resourcesDir = NodePath.join(stageApp, "apps/desktop/resources");
    stageIcons(resourcesDir);
    stageResourceMonitor(resourcesDir);
    // electron-builder drops buildResources from the packaged app; extraResources read this copy.
    NodeFS.cpSync(resourcesDir, NodePath.join(stageApp, "apps/desktop/prod-resources"), {
      recursive: true,
    });

    const patchedDependencies = Object.fromEntries(
      Object.entries((workspace.patchedDependencies ?? {}) as Record<string, string>).filter(
        ([key]) => Object.hasOwn(dependencies, patchPackageName(key)),
      ),
    );
    if (Object.keys(patchedDependencies).length > 0) copy("patches", "patches");

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
          build: createBuilderConfig(version),
          dependencies,
          devDependencies: { electron: desktopPackage.dependencies.electron },
        },
        null,
        2,
      )}\n`,
    );
    NodeFS.writeFileSync(
      NodePath.join(stageApp, "pnpm-workspace.yaml"),
      stringifyYaml({
        nodeLinker: "hoisted",
        supportedArchitectures: { os: ["darwin"], cpu: [arch] },
        allowBuilds: workspace.allowBuilds ?? {},
        overrides: resolveCatalogDependencies(workspace.overrides ?? {}, catalog),
        patchedDependencies,
        // TypeScript is a typings-only peer; auto-installing it would ship a compiler.
        packageExtensions: {
          "electron-webauthn": { peerDependenciesMeta: { typescript: { optional: true } } },
          "@electron-webauthn/macos": { peerDependenciesMeta: { typescript: { optional: true } } },
        },
      }),
    );

    run("pnpm", ["install", "--prod"], { cwd: stageApp });

    const env: NodeJS.ProcessEnv = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
    for (const key of ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_API_KEY"])
      delete env[key];
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
      { cwd: NodePath.join(repoRoot, "apps/desktop"), env },
    );

    NodeFS.mkdirSync(options.outputDir, { recursive: true });
    const artifacts: Array<string> = [];
    const distDir = NodePath.join(stageApp, "dist");
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
    },
  });
  if (!values.version) {
    console.error(
      "usage: build-desktop-release.ts --version x.y.z [--out dir] [--arch arm64] [--skip-build]",
    );
    process.exit(1);
  }
  buildDesktopRelease({
    version: values.version,
    outputDir: NodePath.resolve(repoRoot, values.out),
    skipBuild: values["skip-build"],
    arch: values.arch,
  });
}
