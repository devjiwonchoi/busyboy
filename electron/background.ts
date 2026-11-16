import type { FocusTarget } from '../src/lib/focus-target'
import type { AttentionUpdate } from '../src/server/attention'
import { followAttention } from './attention-stream'
import { notificationFor, showNotification } from './notifications'
import type { ServerHandle } from './server-process'
import { attentionCount, createTray, setBadge } from './tray'

export type BackgroundOptions = {
  open: (target?: FocusTarget) => void
  quit: () => void
  /** Whether the user is looking at the window now; notifications are only for when they are not. */
  windowInFront: () => boolean
  /** The self-check observes updates without showing notifications on the machine it runs on. */
  notify?: boolean
}

/**
 * Keeps the user informed while BusyBoy works in the background: the tray
 * shows what needs them, and a notification says when something new does.
 */
export function startBackground(server: ServerHandle, options: BackgroundOptions) {
  const tray = createTray({ open: options.open, quit: options.quit })
  let updates = 0

  const refreshBadge = () => setBadge(options.windowInFront() ? 0 : attentionCount(tray.state()))

  const onUpdate = (update: AttentionUpdate) => {
    updates++
    if (update.type === 'state') {
      tray.update({ tasks: update.tasks })
      refreshBadge()
      return
    }
    const inFront = options.windowInFront()
    // A reply the user saw arrive needs nothing more from them.
    if (update.event.kind === 'director-replied' && !inFront) {
      tray.update({ directorReplied: true })
      refreshBadge()
    }
    if (!inFront && options.notify !== false) showNotification(notificationFor(update.event), options.open)
  }

  const stopFollowing = followAttention(server, onUpdate)

  return {
    tray,
    /** How many updates arrived, for the self-check. */
    updates: () => updates,
    /** The user is looking at the window: an unseen Director reply is now seen. */
    windowFocused() {
      if (tray.state().directorReplied) tray.update({ directorReplied: false })
      setBadge(0)
    },
    /** The window went to the background: what waits shows on the dock again. */
    // Electron may still report the window as focused while it emits the blur.
    windowBlurred: () => void setImmediate(refreshBadge),
    stop() {
      stopFollowing()
      setBadge(0)
      tray.destroy()
    },
  }
}

export type Background = ReturnType<typeof startBackground>
