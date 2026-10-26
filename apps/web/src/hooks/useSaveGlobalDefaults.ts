import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import * as Equal from "effect/Equal";

import {
  globalDefaultsPatch,
  type GlobalDefaultsPatch,
} from "../components/settings/scopedSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Saves a model, effort, or permission picked in the composer as the
 * environment's default, so the next new thread in any project starts with it.
 */
export function useSaveGlobalDefaults() {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "Save default");

  return ({
    environmentId,
    patch,
  }: {
    environmentId: EnvironmentId;
    patch: GlobalDefaultsPatch;
  }) => {
    // A connection that cannot write settings still changes the thread itself.
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      return;
    }
    const settings = appAtomRegistry.get(
      serverEnvironment.configValueAtom(environmentId),
    )?.settings;
    if (!settings) {
      return;
    }

    const nextPatch = globalDefaultsPatch({ settings, patch });
    const isUnchanged =
      nextPatch.projectSettingsOverrides === undefined &&
      Object.entries(patch).every(([key, value]) =>
        Equal.equals(settings[key as keyof GlobalDefaultsPatch], value),
      );
    if (isUnchanged) {
      return;
    }

    void updateSettings({ environmentId, input: { patch: nextPatch } });
  };
}
