import { connection } from 'next/server'
import { dataFolder } from '@/server/config'
import { readEndStateAchievement } from '@/server/records/end-state'
import { syncEndStateCards } from '@/server/records/end-state-cards'

/**
 * End state achievement from the records on main, and the done cards that show it.
 * A short response, not a held stream: the window already keeps several event
 * streams open, and another one would leave no connection for the terminal.
 */
export async function GET() {
  await connection()
  const folder = await dataFolder()
  const result = await readEndStateAchievement(folder)
  if (result.ok) await syncEndStateCards(folder, result.tasks).catch((error: unknown) => console.error('[achievement] cards', error))
  return Response.json(result.ok ? { weeks: result.weeks } : { error: result.error })
}
