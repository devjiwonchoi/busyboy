// Where the app opens when the user picks an item in the tray or clicks a
// notification. The desktop app passes it as `?focus=` on a fresh window, or
// through the preload bridge to a window that is already open.

export type FocusTarget = { kind: 'task'; project: string; taskId: string } | { kind: 'director' }

/** Query parameter that carries a focus target on the main screen. */
export const FOCUS_PARAM = 'focus'

export function formatFocusTarget(target: FocusTarget) {
  return target.kind === 'director' ? 'director' : `task:${target.project}/${target.taskId}`
}

export function parseFocusTarget(value: string | null | undefined): FocusTarget | null {
  if (!value) return null
  if (value === 'director') return { kind: 'director' }
  // Task ids never contain a slash (a slug plus hex); project names might, so split at the last one.
  const match = /^task:(.+)\/([^/]+)$/.exec(value)
  return match ? { kind: 'task', project: match[1], taskId: match[2] } : null
}
