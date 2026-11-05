// @effect-diagnostics nodeBuiltinImport:off - Copies and verifies the helper bundle on disk.
/**
 * Keeps one copy of "BusyBoy Computer Use.app" at a stable path, so its TCC
 * grants survive BusyBoy moves, translocation, and updates. The copy is
 * refreshed when the bundled helper's build number or executable hash changes,
 * and its signature is checked before every launch.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

export const HELPER_BUNDLE_NAME = "BusyBoy Computer Use.app";
export const HELPER_BUNDLE_ID = "dev.jiwon.busyboy.computer-use";
export const HELPER_EXECUTABLE = "busyboy-computer-use";
export const HELPER_TEAM_ID = "5PA4R2B5FF";
/** Same as `HELPER_REQUIREMENT` in `apps/desktop/scripts/build-computer-use.mjs`. */
export const HELPER_REQUIREMENT = `anchor apple generic and identifier "${HELPER_BUNDLE_ID}" and certificate leaf[subject.OU] = "${HELPER_TEAM_ID}"`;

export type HelperInstallFailureReason =
  | "helper_missing"
  | "helper_not_bundled"
  | "helper_signature_invalid"
  | "helper_install_failed";

export class HelperInstallError extends Error {
  override readonly name = "HelperInstallError";
  readonly reason: HelperInstallFailureReason;
  constructor(reason: HelperInstallFailureReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  command: string,
  args: ReadonlyArray<string>,
) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(command, [...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
  });

export interface HelperFingerprint {
  readonly version: string | null;
  readonly executableSha256: string;
}

export interface HelperInstallInfo extends HelperFingerprint {
  readonly path: string;
  readonly copied: boolean;
}

export const helperExecutablePath = (bundle: string) =>
  NodePath.join(bundle, "Contents", "MacOS", HELPER_EXECUTABLE);

const BUNDLE_VERSION = /<key>CFBundleVersion<\/key>\s*<string>([^<]*)<\/string>/;

const exists = (path: string) =>
  NodeFS.access(path).then(
    () => true,
    () => false,
  );

/** `null` when the bundle has no executable. */
export async function readHelperFingerprint(bundle: string): Promise<HelperFingerprint | null> {
  const executable = await NodeFS.readFile(helperExecutablePath(bundle)).catch(() => null);
  if (executable === null) return null;
  const plist = await NodeFS.readFile(
    NodePath.join(bundle, "Contents", "Info.plist"),
    "utf8",
  ).catch(() => "");
  return {
    version: BUNDLE_VERSION.exec(plist)?.[1] ?? null,
    executableSha256: NodeCrypto.createHash("sha256").update(executable).digest("hex"),
  };
}

export interface HelperInstallerOptions {
  /**
   * The helper shipped with this BusyBoy build; `null` when the build has none
   * (release builds made without `--computer-use`, dev without the identity).
   */
  readonly bundledPath: string | null;
  /** `~/Library/Application Support/BusyBoy/ComputerUse`. */
  readonly installRoot: string;
  readonly run?: CommandRunner;
  readonly requirement?: string;
  /** For tests: `fs.rename`. */
  readonly rename?: (from: string, to: string) => Promise<void>;
}

export class HelperInstaller {
  readonly installedPath: string;
  readonly executablePath: string;
  private readonly run: CommandRunner;
  private readonly requirement: string;

  private readonly options: HelperInstallerOptions;

  constructor(options: HelperInstallerOptions) {
    this.options = options;
    this.installedPath = NodePath.join(options.installRoot, HELPER_BUNDLE_NAME);
    this.executablePath = helperExecutablePath(this.installedPath);
    this.run = options.run ?? runCommand;
    this.requirement = options.requirement ?? HELPER_REQUIREMENT;
  }

  /**
   * Copies the bundled helper into place when the installed one is missing or
   * differs. A copy that fails verification is discarded and the old install
   * stays. `beforeReplace` runs only when a copy is about to happen, so a
   * running helper can be stopped first.
   */
  async ensureInstalled(
    options: { readonly beforeReplace?: () => Promise<void> } = {},
  ): Promise<HelperInstallInfo> {
    if (this.options.bundledPath === null) {
      // Never fall back to an earlier install: this build cannot vouch for it.
      throw new HelperInstallError(
        "helper_not_bundled",
        "this BusyBoy build does not include Computer Use",
      );
    }
    const bundled = await readHelperFingerprint(this.options.bundledPath);
    const installed = await readHelperFingerprint(this.installedPath);
    if (bundled === null) {
      if (installed !== null) return { ...installed, path: this.installedPath, copied: false };
      throw new HelperInstallError(
        "helper_missing",
        "this BusyBoy build has no computer-use helper",
      );
    }
    if (
      installed !== null &&
      installed.version === bundled.version &&
      installed.executableSha256 === bundled.executableSha256
    ) {
      return { ...installed, path: this.installedPath, copied: false };
    }

    await options.beforeReplace?.();
    await NodeFS.mkdir(this.options.installRoot, { recursive: true });
    const suffix = NodeCrypto.randomBytes(6).toString("hex");
    const staging = NodePath.join(this.options.installRoot, `.${HELPER_BUNDLE_NAME}.${suffix}.tmp`);
    const previous = NodePath.join(
      this.options.installRoot,
      `.${HELPER_BUNDLE_NAME}.${suffix}.old`,
    );
    const rename = this.options.rename ?? NodeFS.rename;
    // `previous` is deleted only once the new copy is in place (or the old one
    // is back); otherwise it is the only copy left and stays for the next run.
    let previousDisposable = true;
    try {
      // --noqtn drops the quarantine attribute a downloaded BusyBoy carries.
      const copy = await this.run("ditto", ["--noqtn", this.options.bundledPath, staging]);
      if (copy.code !== 0) {
        throw new HelperInstallError(
          "helper_install_failed",
          `could not copy the helper: ${copy.stderr.trim()}`,
        );
      }
      await this.verify(staging);
      const hadInstall = await exists(this.installedPath);
      if (hadInstall) await rename(this.installedPath, previous);
      try {
        await rename(staging, this.installedPath);
      } catch (error) {
        if (hadInstall) {
          previousDisposable = await rename(previous, this.installedPath).then(
            () => true,
            () => false,
          );
        }
        throw new HelperInstallError(
          "helper_install_failed",
          `could not move the helper into place: ${String(error)}`,
        );
      }
    } finally {
      await NodeFS.rm(staging, { recursive: true, force: true });
      if (previousDisposable) await NodeFS.rm(previous, { recursive: true, force: true });
    }
    return { ...bundled, path: this.installedPath, copied: true };
  }

  /** Runs before every launch. */
  async verifyInstalled(): Promise<void> {
    if (!(await exists(this.executablePath))) {
      throw new HelperInstallError("helper_missing", "the computer-use helper is not installed");
    }
    await this.verify(this.installedPath);
  }

  private async verify(bundle: string): Promise<void> {
    const result = await this.run("codesign", [
      "--verify",
      "--strict",
      `-R=${this.requirement}`,
      bundle,
    ]);
    if (result.code !== 0) {
      throw new HelperInstallError(
        "helper_signature_invalid",
        `the helper signature does not match BusyBoy's: ${result.stderr.trim()}`,
      );
    }
  }
}
