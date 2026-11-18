import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import builder from "electron-builder";

import { standaloneServerPath } from "../standalone-server.ts";
import { checkPackagedServer } from "./check-packaged-server.mts";
import { installServerPackages } from "./install-server-packages.mts";
import { materializeWindowsServer } from "./materialize-windows-server.mts";

const nativeRoot = join(import.meta.dirname, "..");
const repoRoot = join(nativeRoot, "..", "..");
const webRoot = join(repoRoot, "apps", "web");
const argv = process.argv.slice(2);
const args = new Set(argv);
const manifest = JSON.parse(readFileSync(join(nativeRoot, "package.json"), "utf8"));

function releaseVersion(): string {
  const index = argv.findIndex((arg) => arg === "--version" || arg.startsWith("--version="));
  if (index === -1) return manifest.version;
  const value = argv[index].includes("=")
    ? argv[index].slice("--version=".length)
    : argv[index + 1];
  if (!value || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`--version needs a version such as 0.0.23, got ${value ?? "nothing"}.`);
  }
  return value;
}
const standalone = join(webRoot, ".next", "standalone");
const outputDir = join(repoRoot, "release");

function run(command: string, commandArgs: string[]) {
  execFileSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

function targetPlatform() {
  const requested = args.has("--mac")
    ? "darwin"
    : args.has("--win")
      ? "win32"
      : args.has("--linux")
        ? "linux"
        : null;
  if (requested && requested !== process.platform) {
    throw new Error(
      `Cannot package for ${requested} on ${process.platform}; build on that platform instead.`,
    );
  }
  return builder.Platform.current();
}

const platform = targetPlatform();
const version = releaseVersion();
const release = args.has("--release");
const mac = process.platform === "darwin";

const APP_ID = "dev.jiwon.busyboy";
const DEVELOPER_TEAM = "5PA4R2B5FF";
const SIGNATURE_REQUIREMENT = `anchor apple generic and identifier "${APP_ID}" and certificate leaf[subject.OU] = "${DEVELOPER_TEAM}"`;

if (release && mac) {
  const missing = ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0)
    throw new Error(`A macOS release needs ${missing.join(", ")} to notarize the app.`);
}
if (release && process.platform === "linux")
  throw new Error("Releases are built for macOS and Windows only.");

if (!args.has("--skip-next")) run("pnpm", ["--filter", "@busyboy/web", "build"]);
if (!existsSync(standaloneServerPath(standalone))) {
  throw new Error("No apps/web/.next/standalone/apps/web/server.js. Run `pnpm build` first.");
}
if (!args.has("--skip-electron")) run("pnpm", ["--filter", "@busyboy/native", "build"]);
else if (!existsSync(join(nativeRoot, "dist-electron", "main.cjs"))) {
  throw new Error("No apps/native/dist-electron/main.cjs. Run `pnpm build:electron` first.");
}

rmSync(outputDir, { recursive: true, force: true });

const packagePath = join(nativeRoot, "package.json");
const packageBackup = args.has("--skip-next") ? readFileSync(packagePath) : null;
if (packageBackup) {
  const packaged = JSON.parse(packageBackup.toString("utf8")) as Record<string, unknown>;
  delete packaged.dependencies;
  delete packaged.optionalDependencies;
  writeFileSync(packagePath, `${JSON.stringify(packaged, null, 2)}\n`);
}

let packagedServer: string | undefined;
let executable: string | undefined;

const entitlements = join(nativeRoot, "entitlements.mac.plist");

try {
  process.chdir(nativeRoot);
  await builder.build({
    targets: platform.createTarget(release ? (mac ? ["dmg", "zip"] : ["nsis"]) : "dir"),
    publish: "never",
    config: {
      appId: APP_ID,
      productName: manifest.productName,
      ...(release
        ? {
            artifactName: "${productName}-${version}-${arch}.${ext}",
            publish: [
              {
                provider: "github" as const,
                owner: "devjiwonchoi",
                repo: "busyboy",
                releaseType: "release" as const,
              },
            ],
            forceCodeSigning: mac,
            nsis: {
              artifactName: "${productName}-Setup-${version}-${arch}.${ext}",
              differentialPackage: true,
            },
            dmg: {
              title: `${manifest.productName} ${version}`,
              contents: [
                { x: 166, y: 214, type: "file" as const },
                { x: 474, y: 214, type: "link" as const, path: "/Applications" },
              ],
            },
          }
        : {}),
      extraMetadata: { version },
      directories: { output: outputDir },
      files: ["dist-electron/**/*", "package.json", "!node_modules/**/*"],
      asar: true,
      npmRebuild: false,
      nodeGypRebuild: false,
      electronLanguages: ["en"],
      win: { icon: join(nativeRoot, "icons", "icon.ico") },
      linux: { icon: join(nativeRoot, "icons", "icon.png") },
      mac: {
        icon: join(nativeRoot, "icons", "icon.png"),
        category: "public.app-category.developer-tools",
        ...(release
          ? {
              hardenedRuntime: true,
              entitlements,
              entitlementsInherit: entitlements,
              notarize: true,
            }
          : { identity: null }),
      },
      afterPack: async (context) => {
        if (packageBackup) writeFileSync(packagePath, packageBackup);
        const { productFilename } = context.packager.appInfo;
        const mac = context.electronPlatformName === "darwin";
        const resources = mac
          ? join(context.appOutDir, `${productFilename}.app`, "Contents", "Resources")
          : join(context.appOutDir, "resources");
        executable = mac
          ? join(context.appOutDir, `${productFilename}.app`, "Contents", "MacOS", productFilename)
          : join(
              context.appOutDir,
              context.electronPlatformName === "win32"
                ? `${productFilename}.exe`
                : context.packager.appInfo.sanitizedName.toLowerCase(),
            );
        packagedServer = join(resources, "server");
        if (context.electronPlatformName === "win32")
          materializeWindowsServer(standalone, packagedServer);
        else cpSync(standalone, packagedServer, { recursive: true, verbatimSymlinks: true });
        const strays = [".git", "tests", "release", "scripts", "electron"].filter((name) =>
          existsSync(join(packagedServer as string, name)),
        );
        if (strays.length > 0)
          throw new Error(`The packaged server contains repository files: ${strays.join(", ")}.`);
        installServerPackages(
          packagedServer,
          context.electronPlatformName,
          builder.Arch[context.arch],
        );
      },
    },
  });
} finally {
  if (packageBackup) writeFileSync(packagePath, packageBackup);
}

if (!packagedServer || !executable)
  throw new Error("electron-builder did not run the afterPack step.");
await checkPackagedServer(packagedServer);

if (release && mac) {
  const appBundle = join(executable, "..", "..", "..");
  if (APP_ID !== "dev.jiwon.busyboy" || DEVELOPER_TEAM !== "5PA4R2B5FF") {
    throw new Error(
      "Installed apps only accept the bundle id dev.jiwon.busyboy signed by team 5PA4R2B5FF.",
    );
  }
  execFileSync("spctl", ["--assess", "--type", "execute", "-vv", appBundle], { stdio: "inherit" });
  const signed = spawnSync("codesign", ["-d", "--verbose=2", appBundle], { encoding: "utf8" });
  const details = `${signed.stdout ?? ""}\n${signed.stderr ?? ""}`;
  if (
    !details.includes(`Identifier=${APP_ID}`) ||
    !details.includes(`TeamIdentifier=${DEVELOPER_TEAM}`)
  ) {
    throw new Error(`The signed app is not ${APP_ID} from team ${DEVELOPER_TEAM}.\n${details}`);
  }
  const zip = join(
    outputDir,
    `${manifest.productName}-${version}-${builder.Arch[builder.archFromString(process.arch)]}.zip`,
  );
  const unpacked = mkdtempSync(join(tmpdir(), "busyboy-update-check-"));
  try {
    execFileSync("ditto", ["-x", "-k", zip, unpacked], { stdio: "inherit" });
    execFileSync(
      "codesign",
      [
        "--verify",
        "--deep",
        "--strict",
        `-R=${SIGNATURE_REQUIREMENT}`,
        join(unpacked, basename(appBundle)),
      ],
      {
        stdio: "inherit",
      },
    );
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
}
writeFileSync(
  join(outputDir, "desktop-build.json"),
  `${JSON.stringify({ productName: manifest.productName, version, executable, server: packagedServer }, null, 2)}\n`,
);

console.log(`[build-desktop] Packaged into ${outputDir}`);
