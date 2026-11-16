import { readSettings, readSettingsAt, updateSettings } from './config'
import { DEFAULT_ALWAYS_ASK, ruleError } from './runner/always-ask'

// The user's always-ask list, kept in app-settings.json and edited in setup and settings.

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

const MAX_ALWAYS_ASK_LENGTH = 20_000

/** Why the list's text cannot be saved, or undefined when it can: too long, or a line that could never match. */
export function alwaysAskError(text: unknown) {
  if (typeof text !== 'string' || text.length > MAX_ALWAYS_ASK_LENGTH) return 'Keep the list under 20,000 characters.'
  return text.split('\n').map(ruleError).find(Boolean) ?? undefined
}
