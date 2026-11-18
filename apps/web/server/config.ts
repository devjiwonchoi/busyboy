import { access, mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { pathKey } from "./paths";
import type { ProviderId } from "./runner/contract";

// why: The data folder is shared with the legacy app, which keeps its own files there.

export const HOME_ENV = "BUSYBOY_HOME";

/*why: * Named so it never collides with the legacy app's `settings.json`. */
export const SETTINGS_FILE = "app-settings.json";

export type Settings = {
  version: number;
  setupCompletedAt: string | null;
  defaultProvider: ProviderId | null;
  [unknownKey: string]: unknown;
};

const EMPTY_SETTINGS: Settings = {
  version: 1,
  setupCompletedAt: null,
  defaultProvider: null,
};

export function dataFolder() {
  return process.env[HOME_ENV] || join(homedir(), ".busyboy");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettings(text: string): Settings | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  return {
    ...value,
    version: typeof value.version === "number" && value.version > 1 ? value.version : 1,
    setupCompletedAt: typeof value.setupCompletedAt === "string" ? value.setupCompletedAt : null,
    defaultProvider:
      value.defaultProvider === "claude" ||
      value.defaultProvider === "codex" ||
      value.defaultProvider === "grok"
        ? value.defaultProvider
        : null,
  };
}

async function readSettingsFile(file: string) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const WRITE_QUEUE_KEY = Symbol.for("busyboy.settings-writes");
const globalStore = globalThis as typeof globalThis & {
  [WRITE_QUEUE_KEY]?: Map<string, Promise<unknown>>;
};
const writeQueues = (globalStore[WRITE_QUEUE_KEY] ??= new Map());

function queued<T>(file: string, work: () => Promise<T>): Promise<T> {
  const key = pathKey(file);
  const next = (writeQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
  writeQueues.set(key, next);
  return next;
}

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function moveAsideIfCorrupt(folder: string) {
  const file = join(folder, SETTINGS_FILE);
  const text = await readSettingsFile(file);
  if (text === undefined || parseSettings(text)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let aside = join(folder, `app-settings.corrupt-${stamp}.json`);
  for (let n = 2; await exists(aside); n++)
    aside = join(folder, `app-settings.corrupt-${stamp}-${n}.json`);
  await rename(file, aside);
}

async function readSettingsAt(folder: string): Promise<Settings> {
  const text = await readSettingsFile(join(folder, SETTINGS_FILE));
  const settings = text === undefined ? undefined : parseSettings(text);
  if (settings) return settings;
  if (text !== undefined) {
    const file = join(folder, SETTINGS_FILE);
    await queued(file, () => moveAsideIfCorrupt(folder));
  }
  return structuredClone(EMPTY_SETTINGS);
}

export async function readSettings() {
  return readSettingsAt(dataFolder());
}

export async function updateSettings<T>(
  change: (settings: Settings) => T | Promise<T>,
): Promise<T> {
  const folder = dataFolder();
  const file = join(folder, SETTINGS_FILE);
  return queued(file, async () => {
    await moveAsideIfCorrupt(folder);
    const text = await readSettingsFile(file);
    const settings =
      (text === undefined ? undefined : parseSettings(text)) ?? structuredClone(EMPTY_SETTINGS);
    const result = await change(settings);
    await mkdir(folder, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    return result;
  });
}

export function isSetupComplete(settings: Settings) {
  return Boolean(settings.setupCompletedAt);
}
