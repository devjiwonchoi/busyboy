'use client'

import { useEffect } from 'react'
import { desktopBridge } from '@/lib/desktop-bridge'
import { FOCUS_PARAM, parseFocusTarget } from '@/lib/focus-target'

/**
 * Opens what the user picked in the tray or a notification. The Director's
 * chat gets the composer's focus. A task target used to highlight that task
 * in the project graph; that panel is gone, so a task target is ignored.
 * A fresh window gets the target as `?focus=`; an open one gets it from the
 * desktop bridge, so nothing on the page reloads.
 */
export function FocusHandler() {
  useEffect(() => {
    const show = (value: string | null) => {
      const target = parseFocusTarget(value)
      if (target?.kind !== 'director') return
      document.querySelector<HTMLElement>('[role="textbox"][aria-label="Message"]')?.focus()
    }
    const url = new URL(window.location.href)
    const initial = url.searchParams.get(FOCUS_PARAM)
    if (initial) {
      // A reload should not jump back to it.
      url.searchParams.delete(FOCUS_PARAM)
      window.history.replaceState(window.history.state, '', url)
      show(initial)
    }
    // A browser without the desktop app, or an older preload, has no onFocus.
    return desktopBridge()?.onFocus?.(show)
  }, [])

  return null
}
