import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Reading a draft ALIGN.md. The plan follow-up fills `criteria` from the same
// document; the card shows `summary` while `criteria` is empty.

/**
 * The plan's own status, at the start of a line or after `Version: <n> ·` as the
 * align template writes it, so prose that mentions an approval never counts.
 */
const APPROVED = /^(?:\W*Version:[^·\n]*·)?\W*Status:\s*approved\b/im

type PlanTask = { id: string; title: string; worktree: string }

/**
 * The body of a top-level `# <name>` section, up to the next top-level heading.
 * Code fences are not tracked, so a `# comment` line in a fence ends the
 * section early; that only shortens the card's summary, and View details shows the whole plan.
 */
function topSection(text: string, name: string) {
  const match = new RegExp(`^#\\s+${name}\\s*$([\\s\\S]*?)(?=^#\\s|(?![\\s\\S]))`, 'im').exec(text)
  return match?.[1] ?? ''
}

/**
 * Two or three sentences for the plan card: the Goal's prose and the
 * Summary's "What" line, which the align template states in both forms.
 */
export function alignSummary(plan: string) {
  const goal = topSection(plan, 'Goal')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph && !/^(intention:|---)/i.test(paragraph))
    .join(' ')
  const what = /^\s*-\s*What:\s*(.+)$/im.exec(topSection(plan, 'Summary'))?.[1].trim()
  const sentences = [goal, what ? `When done: ${what}` : '']
    .join(' ')
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
  const summary = sentences.slice(0, 3).join(' ')
  return /[.!?]$/.test(summary) || !summary ? summary : `${summary}.`
}

/** A draft plan waiting for approval. Null when there is none or it is already approved. */
export async function readDraftPlan(task: PlanTask) {
  const plan = await readFile(join(task.worktree, '.jwn', task.id, 'ALIGN.md'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  if (plan === null || APPROVED.test(plan)) {
    return null
  }

  const title = /^#\s+ALIGN:\s*(.+?)\s*$/m.exec(plan)?.[1] ?? task.title
  return { title, plan, summary: alignSummary(plan), criteria: [] as string[] }
}
