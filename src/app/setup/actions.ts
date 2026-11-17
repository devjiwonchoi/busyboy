"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { alwaysAskError, resetAlwaysAsk, saveAlwaysAsk } from "@/server/always-ask-list";
import {
  chooseCompanion,
  CompanionImageError,
  findCompanion,
  removeCompanionImage,
  saveCompanionImage,
} from "@/server/companions";
import { readSettings, updateSettings } from "@/server/config";
import { addProject, ProjectError, removeProject } from "@/server/projects";
import {
  providerState,
  PROVIDERS,
  setDefaultProvider,
  signedInProviders,
} from "@/server/providers";
import type { ProviderId } from "@/server/runner/contract";

import { stepHref } from "./steps";

export type FormResult = { error?: string };

export async function chooseCompanionAction(
  _previous: FormResult,
  form: FormData,
): Promise<FormResult> {
  const id = form.get("companion");
  if (typeof id !== "string" || !findCompanion(id))
    return { error: "Choose a director to continue." };
  await chooseCompanion(id);
  redirect(stepHref("agents"));
}

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

export async function continueFromAgentsAction(form: FormData) {
  const provider = form.get("defaultProvider");
  if (typeof provider === "string") {
    if (!PROVIDERS.some(({ id }) => id === provider)) throw new Error("Unknown provider.");
    await setDefaultProvider(provider as ProviderId);
  }
  redirect(stepHref("skills"));
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

export async function startChattingAction() {
  const [settings, signedIn] = await Promise.all([readSettings(), signedInProviders()]);
  if (!findCompanion(settings.companion)) redirect(stepHref("companion"));
  if (signedIn.length === 0) redirect(stepHref("agents"));
  await updateSettings((current) => {
    current.setupCompletedAt ??= new Date().toISOString();
  });
  redirect("/");
}

export async function continueFromApprovalsAction(
  _previous: FormResult,
  form: FormData,
): Promise<FormResult> {
  const text = form.get("rules");
  const error = alwaysAskError(text);
  if (error) {
    return { error };
  }
  await saveAlwaysAsk(text as string);
  redirect(stepHref("start"));
}

export async function restoreAlwaysAskAction() {
  await resetAlwaysAsk();
  refresh();
}
