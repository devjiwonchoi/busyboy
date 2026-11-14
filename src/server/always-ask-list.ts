import { readSettings, readSettingsAt, updateSettings } from './config'
import { DEFAULT_ALWAYS_ASK } from './runner/always-ask'

// The user's always-ask list, kept in app-settings.json and edited in Setup.

/** The rules in `folder`'s settings, or the defaults while the user has not edited them. */
export async function alwaysAskRulesAt(folder: string) {
  return (await readSettingsAt(folder)).alwaysAsk ?? DEFAULT_ALWAYS_ASK
}

export async function alwaysAskRules() {
  return (await readSettings()).alwaysAsk ?? DEFAULT_ALWAYS_ASK
}

/** Saves the list from its text, one rule per line. Blank lines are dropped. */
export async function saveAlwaysAsk(text: string) {
  const rules = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  await updateSettings((settings) => {
    settings.alwaysAsk = rules
  })
}

/** Forgets the user's edits, so the defaults (and later BusyBoy's new defaults) apply. */
export async function resetAlwaysAsk() {
  await updateSettings((settings) => {
    settings.alwaysAsk = null
  })
}
