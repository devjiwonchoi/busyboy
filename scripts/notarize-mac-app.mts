import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`A macOS release needs ${name} to notarize the app.`);
  return value;
}

function notaryKeyArgs(): string[] {
  return [
    "--key",
    requiredEnv("APPLE_API_KEY"),
    "--key-id",
    requiredEnv("APPLE_API_KEY_ID"),
    "--issuer",
    requiredEnv("APPLE_API_ISSUER"),
  ];
}

function run(command: string, args: string[], cwd?: string) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function spawnOk(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`${command} exited with ${code ?? signal ?? "none"}.`));
    });
  });
}

// why: @electron/notarize refuses to upload an app whose deep signature does not already verify.
async function verifyDeepSignature(appPath: string) {
  const cwd = dirname(appPath);
  const name = basename(appPath);
  await Promise.all([
    spawnOk("codesign", ["-vvv", "--deep", "--strict", name], cwd),
    spawnOk("codesign", ["-dv", "-vvvv", "--deep", name], cwd),
  ]);
}

function startNotarytool(zipPath: string): { done: Promise<void>; stop: () => void } {
  const child: ChildProcess = spawn(
    "xcrun",
    ["notarytool", "submit", zipPath, ...notaryKeyArgs(), "--wait", "--output-format", "json"],
    { stdio: "inherit" },
  );
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`notarytool exited with ${code ?? signal ?? "none"}.`));
    });
  });
  return {
    done,
    stop() {
      child.kill("SIGTERM");
    },
  };
}

async function stapleApp(appPath: string) {
  const args = ["stapler", "staple", "-v", basename(appPath)];
  const cwd = dirname(appPath);
  let lastError: unknown;
  // why: The ticket is sometimes not downloadable on the first staple, which is why @electron/notarize tries again.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      run("xcrun", args, cwd);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not staple the app.");
}

// why: electron-builder notarizes before afterSign returns, so checks would sit idle until Apple finishes.
export async function notarizeAndStaple(appPath: string, onSubmitted: () => void): Promise<void> {
  await verifyDeepSignature(appPath);
  const dir = mkdtempSync(join(tmpdir(), "busyboy-notary-"));
  const zip = join(dir, `${basename(appPath, ".app")}.zip`);
  let stop = () => {};
  try {
    run(
      "ditto",
      ["-c", "-k", "--sequesterRsrc", "--keepParent", basename(appPath), zip],
      dirname(appPath),
    );
    const notary = startNotarytool(zip);
    stop = notary.stop;
    console.log(
      "[build-desktop] Submitted the signed app to Apple. Packaged checks run during the wait.",
    );
    onSubmitted();
    await notary.done;
  } catch (error) {
    stop();
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await stapleApp(appPath);
  console.log("[build-desktop] Notarization successful.");
}
