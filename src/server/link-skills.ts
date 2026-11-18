import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { dataFolder, isTestMode } from "./config";

// why: The harnesses load skills from these folders. Linking a checkout there is the install the setup step used to ask the user to copy.

const SKILLS_REPO = "https://github.com/devjiwonchoi/skills.git";
const PLUGIN_KEY = "jwn@jwn";
const PLUGIN_TABLE = `[plugins."${PLUGIN_KEY}"]`;
const CLONE_TIMEOUT_MS = 60_000;
const RETRY_MS = 5 * 60_000;

const run = promisify(execFile);

const JOBS_KEY = Symbol.for("busyboy.link-skills");
type Jobs = Map<string, { at: number; failed: boolean }>;
const jobs = ((globalThis as typeof globalThis & { [JOBS_KEY]?: Jobs })[JOBS_KEY] ??= new Map());

async function isCheckout(folder: string) {
  try {
    const [plugin, skills] = await Promise.all([
      lstat(join(folder, ".claude-plugin", "plugin.json")),
      lstat(join(folder, "skills")),
    ]);
    return plugin.isFile() && skills.isDirectory();
  } catch {
    return false;
  }
}

async function existingSource(folder: string) {
  const given = process.env.BUSYBOY_SKILLS_PATH;
  if (given && (await isCheckout(given))) return given;
  const local = join(folder, isTestMode() ? "skills-source" : "linked-skills");
  if (await isCheckout(local)) return local;
  return null;
}

function safeSkillName(name: string) {
  return Boolean(name) && !name.startsWith(".") && !name.includes("/") && !name.includes("\\");
}

async function linkSkillDirs(from: string, to: string) {
  const entries = await readdir(from, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return;
  await mkdir(to, { recursive: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeSkillName(entry.name)) continue;
    const dest = join(to, entry.name);
    try {
      await lstat(dest);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
    // why: Windows rejects a directory symlink without a privilege the app does not have.
    await symlink(join(from, entry.name), dest, process.platform === "win32" ? "junction" : "dir");
  }
}

async function registerClaude(configDir: string, source: string) {
  const file = join(configDir, "plugins", "installed_plugins.json");
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    data = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  const current = data.plugins;
  const plugins: Record<string, unknown> =
    typeof current === "object" && current !== null && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  const installed = Object.entries(plugins).some(
    ([key, value]) => key.split("@")[0] === "jwn" && Array.isArray(value) && value.length > 0,
  );
  if (installed) return;
  plugins[PLUGIN_KEY] = [{ scope: "user", installPath: source }];
  data.plugins = plugins;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

async function registerToml(file: string) {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  if (/^\[plugins\."jwn@[^"]+"\]/m.test(text)) return;
  const next =
    text.length > 0 && !text.endsWith("\n")
      ? `${text}\n${PLUGIN_TABLE}\n`
      : `${text}${PLUGIN_TABLE}\n`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, next);
}

async function linkInto(folder: string, source: string) {
  const skills = join(source, "skills");
  // why: Journeys share one CLAUDE_CONFIG_DIR, so a link there would show up in every other test.
  if (isTestMode()) {
    await linkSkillDirs(skills, join(folder, "harness-skills"));
    return;
  }
  const claude = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const codex = process.env.CODEX_HOME || join(homedir(), ".codex");
  const grok = process.env.GROK_HOME || join(homedir(), ".grok");
  await Promise.all([
    linkSkillDirs(skills, join(claude, "skills")),
    linkSkillDirs(skills, join(codex, "skills")),
    linkSkillDirs(skills, join(grok, "skills")),
    linkSkillDirs(skills, join(homedir(), ".agents", "skills")),
    registerClaude(claude, source),
    registerToml(join(codex, "config.toml")),
    registerToml(join(grok, "config.toml")),
  ]);
}

async function cloneCheckout(folder: string) {
  const dest = join(folder, "linked-skills");
  if (await isCheckout(dest)) return dest;
  const staging = join(folder, `linked-skills.${process.pid}.tmp`);
  await rm(staging, { recursive: true, force: true });
  await run("git", ["clone", "--depth", "1", SKILLS_REPO, staging], { timeout: CLONE_TIMEOUT_MS });
  await rm(dest, { recursive: true, force: true });
  await rename(staging, dest);
  return (await isCheckout(dest)) ? dest : null;
}

function scheduleClone(folder: string) {
  const previous = jobs.get(folder);
  if (previous && !previous.failed) return;
  if (previous?.failed && Date.now() - previous.at < RETRY_MS) return;
  jobs.set(folder, { at: Date.now(), failed: false });
  void cloneCheckout(folder)
    .then(async (source) => {
      if (source) await linkInto(folder, source);
    })
    .catch((error: unknown) => {
      jobs.set(folder, { at: Date.now(), failed: true });
      const message = error instanceof Error ? error.message : String(error);
      console.error(`busyboy: could not link skills. ${message}`);
    });
}

export async function ensureHarnessSkills() {
  const folder = await dataFolder();
  const source = await existingSource(folder);
  if (source) {
    await linkInto(folder, source);
    return;
  }
  // why: A journey must not clone from GitHub. It links a checkout it placed in the test home, or it links nothing.
  if (isTestMode()) return;
  scheduleClone(folder);
}
