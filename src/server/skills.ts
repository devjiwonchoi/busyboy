import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { isTestMode, dataFolder } from "./config";
import { getProject } from "./projects";
import type { ProviderId } from "./runner/contract";

// why: A skill is invoked as /name in a Claude message and $name in a Codex message.

export type ComposerSkill = {
  name: string;
  description: string;
  invocation: string;
};

const SKILL_FILE = "SKILL.md";

export function skillInvocation(provider: ProviderId | null, name: string) {
  return provider === "codex" ? `$${name}` : `/${name}`;
}

function oneLine(value: string | undefined) {
  const line = value?.replace(/\s+/g, " ").trim() ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

function skillSlug(raw: string) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function frontmatter(text: string) {
  const result: { name?: string; description?: string } = {};
  if (!text.startsWith("---")) return result;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return result;
  let key: "name" | "description" | null = null;
  const lines: string[] = [];
  const flush = () => {
    if (!key) return;
    const value = oneLine(lines.join(" ")).replace(/^["']|["']$/g, "");
    if (value) result[key] = value;
    lines.length = 0;
    key = null;
  };
  for (const raw of text.slice(3, end).split("\n")) {
    const match = /^(name|description):\s*(.*)$/.exec(raw.trim());
    if (match) {
      flush();
      key = match[1] as "name" | "description";
      if (match[2] && match[2] !== ">" && match[2] !== "|" && match[2] !== ">-")
        lines.push(match[2]);
      continue;
    }
    if (key && (raw.startsWith(" ") || raw.startsWith("\t"))) lines.push(raw.trim());
    else flush();
  }
  flush();
  return result;
}

async function skillsIn(root: string) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const found: { name: string; description: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const text = await readFile(join(root, entry.name, SKILL_FILE), "utf8").catch(() => "");
    if (!text) continue;
    const meta = frontmatter(text);
    const name = skillSlug(meta.name || entry.name);
    if (!name) continue;
    found.push({ name, description: oneLine(meta.description) || "Installed skill." });
  }
  return found;
}

async function skillsUnder(root: string) {
  const [nested, direct] = await Promise.all([skillsIn(join(root, "skills")), skillsIn(root)]);
  return [...nested, ...direct];
}

async function claudePluginRoots() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const text = await readFile(join(configDir, "plugins", "installed_plugins.json"), "utf8").catch(
    () => "",
  );
  const roots = [join(configDir, "skills")];
  if (!text) return roots;
  try {
    const plugins =
      (
        JSON.parse(text) as {
          plugins?: Record<string, { installPath?: unknown; path?: unknown }[]>;
        }
      ).plugins ?? {};
    for (const installs of Object.values(plugins)) {
      if (!Array.isArray(installs)) continue;
      for (const install of installs) {
        const folder = install?.installPath ?? install?.path;
        if (typeof folder === "string" && folder) roots.push(folder);
      }
    }
  } catch {
    // why: A broken plugin list is no skills, not a failed chat.
  }
  return roots;
}

async function codexRoots() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  return [join(codexHome, "skills"), join(homedir(), ".agents", "skills")];
}

export async function listSkills(
  project?: string,
): Promise<{ name: string; description: string }[]> {
  const projectPath = project ? (await getProject(project))?.path : undefined;
  const roots = [
    ...(await claudePluginRoots()),
    ...(await codexRoots()),
    ...(projectPath
      ? [join(projectPath, ".agents", "skills"), join(projectPath, ".claude", "skills")]
      : []),
    ...(isTestMode() ? [join(await dataFolder(), "harness-skills")] : []),
  ];
  const byName = new Map<string, { name: string; description: string }>();
  for (const root of roots) {
    for (const skill of await skillsUnder(root)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
