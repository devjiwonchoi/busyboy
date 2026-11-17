import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserContext } from "@playwright/test";

import { SETTINGS_FILE, TEST_HOME_COOKIE } from "@/server/config";
import { TEST_SIGN_IN_COOKIE } from "@/server/providers";

export function createTempFolder(prefix: string) {
  return mkdtempSync(join(tmpdir(), `busyboy-e2e-${prefix}-`));
}

export function createGitRepository(name = "repo") {
  const folder = join(createTempFolder(name), name);
  mkdirSync(folder);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(folder, "README.md"), `# ${name}\n`);
  git("add", ".");
  git(
    "-c",
    "user.name=BusyBoy Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "-m",
    "Initial commit",
  );
  return folder;
}

export function prepareDefaultHome(folder: string) {
  if (existsSync(join(folder, SETTINGS_FILE))) return;
  mkdirSync(folder, { recursive: true });
  const project = join(folder, "default-project");
  mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: project, stdio: "ignore" });
  const settings = {
    version: 1,
    setupCompletedAt: new Date(0).toISOString(),
    defaultProvider: null,
    projects: [{ name: "default-project", path: project, addedAt: new Date(0).toISOString() }],
  };
  writeFileSync(join(folder, SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`);
}

type SignIn = "signed-in" | "signed-out" | "not-installed" | "outdated";

export async function useTestHome(
  context: BrowserContext,
  baseURL: string,
  signIn: Partial<Record<"claude" | "codex" | "grok", SignIn>> = {},
) {
  const home = createTempFolder("home");
  const cookies = [{ name: TEST_HOME_COOKIE, value: encodeURIComponent(home), url: baseURL }];
  const states = Object.entries(signIn).map(([provider, state]) => `${provider}=${state}`);
  if (states.length)
    cookies.push({ name: TEST_SIGN_IN_COOKIE, value: states.join(","), url: baseURL });
  await context.addCookies(cookies);
  return home;
}

export function removeFolder(folder: string) {
  rmSync(folder, { recursive: true, force: true });
}
