import { Notification } from 'electron'
import type { FocusTarget } from '../src/lib/focus-target'
import type { AttentionEvent } from '../src/server/attention'
import { shorten } from './tray'

export type NotificationContent = { title: string; body: string; target: FocusTarget }

/**
 * What a notification says about an event: the task's project and title and a
 * fixed word or two, never a reply or tool output, which could hold a secret the
 * agent printed and would sit on the lock screen and in Notification Center.
 * The title is the one the Director gave the task: short, but still written by
 * an agent, so it is the one agent text shown.
 */
export function notificationFor(event: AttentionEvent): NotificationContent {
  if (event.kind === 'director-replied') return { title: 'The Director replied', body: '', target: { kind: 'director' } }
  const target: FocusTarget = { kind: 'task', project: event.project, taskId: event.taskId }
  return {
    title: shorten(`${event.project} · ${event.title}`, 64),
    body: event.kind === 'task-done' ? 'Finished' : 'Needs you',
    target,
  }
}

// Electron drops a Notification's click handler once the object is garbage
// collected, so each one is held until it is clicked or closed.
const shown = new Set<Notification>()

/** Shows the notification; clicking it calls `open` with its target. Returns false where notifications are unsupported. */
export function showNotification(content: NotificationContent, open: (target: FocusTarget) => void) {
  if (!Notification.isSupported()) return false
  const notification = new Notification({ title: content.title, body: content.body })
  shown.add(notification)
  notification.on('click', () => {
    shown.delete(notification)
    open(content.target)
  })
  notification.on('close', () => shown.delete(notification))
  notification.show()
  return true
}
