import { readSettings, readSettingsAt, updateSettings } from './config'
import { DEFAULT_ALWAYS_ASK, ruleError } from './runner/always-ask'


export async function alwaysAskRulesAt(folder: string) {
  return (await readSettingsAt(folder)).alwaysAsk ?? DEFAULT_ALWAYS_ASK
}

export async function alwaysAskRules() {
  return (await readSettings()).alwaysAsk ?? DEFAULT_ALWAYS_ASK
}

export async function saveAlwaysAsk(text: string) {
  const rules = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  await updateSettings((settings) => {
    settings.alwaysAsk = rules
  })
}

export async function resetAlwaysAsk() {
  await updateSettings((settings) => {
    settings.alwaysAsk = null
  })
}

const MAX_ALWAYS_ASK_LENGTH = 20_000

export function alwaysAskError(text: unknown) {
  if (typeof text !== 'string' || text.length > MAX_ALWAYS_ASK_LENGTH) return 'Keep the list under 20,000 characters.'
  return text.split('\n').map(ruleError).find(Boolean) ?? undefined
}
