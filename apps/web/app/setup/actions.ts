"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { updateSettings } from "@/server/config";
import {
  PROVIDERS,
  providerState,
  setDefaultProvider,
  signedInProviders,
} from "@/server/providers";
import type { ProviderId } from "@/server/runner/contract";
import { requireTrustedRequest } from "@/server/trusted-request";

export async function finishSetupAction(form: FormData) {
  await requireTrustedRequest();
  const signedIn = await signedInProviders();
  if (signedIn.length === 0) redirect("/setup");
  const provider = form.get("defaultProvider");
  if (typeof provider === "string" && provider) {
    if (!PROVIDERS.some(({ id }) => id === provider)) throw new Error("Unknown provider.");
    if (!signedIn.includes(provider as ProviderId)) throw new Error("That agent is not signed in.");
    await setDefaultProvider(provider as ProviderId);
  }
  await updateSettings((current) => {
    current.setupCompletedAt ??= new Date().toISOString();
  });
  redirect("/");
}

export async function recheckProvidersAction() {
  await requireTrustedRequest();
  await Promise.all(PROVIDERS.map(({ id }) => providerState(id, { fresh: true })));
  refresh();
}
