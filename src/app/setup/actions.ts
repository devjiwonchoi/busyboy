"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import {
  assignRandomCompanion,
  CompanionImageError,
  removeCompanionImage,
  saveCompanionImage,
} from "@/server/companions";
import { updateSettings } from "@/server/config";
import { ensureHarnessSkills } from "@/server/link-skills";
import { addProject, ProjectError, removeProject } from "@/server/projects";
import {
  PROVIDERS,
  providerState,
  setDefaultProvider,
  signedInProviders,
} from "@/server/providers";
import type { ProviderId } from "@/server/runner/contract";

export type FormResult = { error?: string };

export async function setCompanionImageAction(
  _previous: FormResult,
  form: FormData,
): Promise<FormResult> {
  const file = form.get("image");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a picture first." };
  try {
    await saveCompanionImage(file);
  } catch (error) {
    if (error instanceof CompanionImageError) return { error: error.message };
    throw error;
  }
  refresh();
  return {};
}

export async function removeCompanionImageAction() {
  await removeCompanionImage();
  refresh();
}

export async function finishSetupAction(form: FormData) {
  const signedIn = await signedInProviders();
  if (signedIn.length === 0) redirect("/setup");
  const provider = form.get("defaultProvider");
  if (typeof provider === "string" && provider) {
    if (!PROVIDERS.some(({ id }) => id === provider)) throw new Error("Unknown provider.");
    if (!signedIn.includes(provider as ProviderId)) throw new Error("That agent is not signed in.");
    await setDefaultProvider(provider as ProviderId);
  }
  await assignRandomCompanion();
  await ensureHarnessSkills();
  await updateSettings((current) => {
    current.setupCompletedAt ??= new Date().toISOString();
  });
  redirect("/");
}

export async function recheckProvidersAction() {
  await Promise.all(PROVIDERS.map(({ id }) => providerState(id, { fresh: true })));
  refresh();
}

export type AddProjectsResult = { added: string[]; errors: string[] };

export async function addProjectsAction(folders: unknown): Promise<AddProjectsResult> {
  if (
    !Array.isArray(folders) ||
    folders.length > 100 ||
    !folders.every((folder) => typeof folder === "string")
  ) {
    throw new Error("Folders must be a list of paths.");
  }
  const result: AddProjectsResult = { added: [], errors: [] };
  for (const folder of folders) {
    try {
      result.added.push((await addProject(folder)).name);
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error;
      result.errors.push(error.message);
    }
  }
  refresh();
  return result;
}

export async function addTypedProjectAction(
  _previous: FormResult,
  form: FormData,
): Promise<FormResult> {
  const { errors } = await addProjectsAction([String(form.get("folder") ?? "")]);
  return errors.length ? { error: errors[0] } : {};
}

export async function removeProjectAction(name: string) {
  if (typeof name !== "string") throw new Error("The project name must be a string.");
  await removeProject(name);
  refresh();
}
