import { randomBytes } from "node:crypto";

import { dataFolder, readSettingsAt, updateSettings, type ManagerEntry } from "./config";
import { pathKey } from "./paths";
import { addProject, getProject, ProjectError } from "./projects";

// why: A project has at most one manager, so a task's cards always have one chat to show in.

export type Manager = ManagerEntry;

export class ManagerError extends Error {}

const MAX_NAME_LENGTH = 40;

// why: Kept on globalThis so `next dev` reloads keep the listeners and the known ids.
const STORE_KEY = Symbol.for("busyboy.managers.v2");
type Store = { listeners: Map<string, Set<() => void>>; known: Map<string, Set<string>> };
const globalStore = globalThis as typeof globalThis & { [STORE_KEY]?: Store };
const store = (globalStore[STORE_KEY] ??= { listeners: new Map(), known: new Map() });

export async function listManagersAt(folder: string): Promise<Manager[]> {
  const { managers, projects } = await readSettingsAt(folder);
  const names = new Set(projects.map(({ name }) => name.toLowerCase()));
  const listed = managers.filter(({ project }) => names.has(project.toLowerCase()));
  store.known.set(pathKey(folder), new Set(listed.map(({ id }) => id)));
  return listed;
}

export async function listManagers() {
  return listManagersAt(await dataFolder());
}

export async function getManagerAt(folder: string, id: string) {
  return (await listManagersAt(folder)).find((manager) => manager.id === id);
}

export function isListedManager(folder: string, id: string) {
  return store.known.get(pathKey(folder))?.has(id) ?? true;
}

export function subscribeToManagers(folder: string, listener: () => void) {
  const key = pathKey(folder);
  let set = store.listeners.get(key);
  if (!set) store.listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => set.delete(listener);
}

function notify(folder: string) {
  for (const listener of store.listeners.get(pathKey(folder)) ?? []) listener();
}

export async function createManager(input: {
  name?: string;
  project?: string;
  folder?: string;
}): Promise<Manager> {
  const name = input.name?.trim() ?? "";
  if (name.length > MAX_NAME_LENGTH)
    throw new ManagerError(`Use at most ${MAX_NAME_LENGTH} characters for the name.`);
  let project = input.project?.trim() ? await getProject(input.project.trim()) : undefined;
  if (input.project?.trim() && !project)
    throw new ManagerError(`There is no project named ${input.project.trim()}.`);
  if (!project) {
    if (!input.folder?.trim())
      throw new ManagerError("Choose a project, or enter the path of a git repository.");
    try {
      project = await addProject(input.folder);
    } catch (error) {
      if (error instanceof ProjectError) throw new ManagerError(error.message);
      throw error;
    }
  }
  const projectName = project.name;
  const manager = await updateSettings((settings) => {
    const existing = settings.managers.find(
      (entry) => entry.project.toLowerCase() === projectName.toLowerCase(),
    );
    if (existing) throw new ManagerError(`${projectName} already has a manager, ${existing.name}.`);
    const entry: Manager = {
      id: randomBytes(6).toString("hex"),
      name: name || projectName,
      project: projectName,
      createdAt: new Date().toISOString(),
    };
    settings.managers.push(entry);
    return entry;
  });
  const folder = await dataFolder();
  await listManagersAt(folder);
  notify(folder);
  return manager;
}

export async function removeManager(id: string) {
  const folder = await dataFolder();
  await updateSettings((settings) => {
    settings.managers = settings.managers.filter((manager) => manager.id !== id);
  });
  await listManagersAt(folder);
  notify(folder);
}
