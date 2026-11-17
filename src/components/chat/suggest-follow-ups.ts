const GENERIC = ['Tell me more', 'Make it shorter', 'What should I do next?']

/**
 * Up to three short follow-ups drawn from a finished reply. Heuristics only:
 * a side session would be another model turn, and these stay free and deterministic.
 */
export function suggestFollowUps(reply: string): string[] {
  const text = reply.replace(/\s+/g, ' ').trim()
  if (!text) return []
  const chips: string[] = []
  if (text.includes('?')) chips.push('Yes', 'No, let me explain')
  if (/\btasks?\b/i.test(text)) chips.push('How is that task going?')
  if (reply.includes('```')) chips.push('Explain that code')
  for (const chip of GENERIC) {
    if (chips.length >= 3) break
    if (!chips.includes(chip)) chips.push(chip)
  }
  return chips.slice(0, 3)
}
