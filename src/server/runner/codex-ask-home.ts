import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveDataFolder } from "../config";

const LINKED = ["sessions", "skills", "memories"];
const COPIED = ["auth.json", "config.toml"];

async function copyIfPresent(from: string, to: string) {
  try {
    await copyFile(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function linkIfPresent(from: string, to: string) {
  try {
    await symlink(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

// why: The rules file has to be visible to this Codex process only, and a copy keeps a later write off the user's default.rules.
export async function prepareCodexAskHome({
  source,
  blocked,
}: {
  source: string;
  blocked?: string;
}) {
  const real = process.env.CODEX_HOME || join(homedir(), ".codex");
  const home = join(resolveDataFolder(), `codex-ask-${randomUUID()}`);
  const rulesDir = join(home, "rules");
  await mkdir(rulesDir, { recursive: true, mode: 0o700 });
  if (source) await writeFile(join(rulesDir, "busyboy.rules"), source, { mode: 0o600 });
  if (blocked) await writeFile(join(rulesDir, "blocked.txt"), blocked, { mode: 0o600 });
  let names: string[] = [];
  try {
    names = await readdir(join(real, "rules"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".rules") || name === "busyboy.rules") continue;
    await copyIfPresent(join(real, "rules", name), join(rulesDir, name));
  }
  for (const name of COPIED) await copyIfPresent(join(real, name), join(home, name));
  for (const name of LINKED) await linkIfPresent(join(real, name), join(home, name));
  return home;
}
