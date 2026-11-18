import { readSettings, readSettingsAt } from "./config";
import { DEFAULT_ALWAYS_ASK } from "./runner/always-ask";

export async function alwaysAskRulesAt(folder: string) {
  return (await readSettingsAt(folder)).alwaysAsk ?? DEFAULT_ALWAYS_ASK;
}

export async function alwaysAskRules() {
  return (await readSettings()).alwaysAsk ?? DEFAULT_ALWAYS_ASK;
}
