'use client'

import { useEffect } from 'react'
import { desktopBridge } from '@/lib/desktop-bridge'
import { FOCUS_PARAM, parseFocusTarget } from '@/lib/focus-target'
import { useShellState } from './shell-state'

/**
 * Opens what the user picked in the tray or a notification: a task shows in
 * the Projects tab with its path highlighted, the Director's chat gets the
 * composer's focus. A fresh window gets the target as `?focus=`; an open one
 * gets it from the desktop bridge, so nothing on the page reloads.
 */
export function FocusHandler() {
  const { setSidebarOpen, setSidebarTab, setFocusedTask } = useShellState()

  useEffect(() => {
    const show = (value: string | null) => {
      const target = parseFocusTarget(value)
      if (!target) return
      if (target.kind === 'task') {
        setSidebarOpen(true)
        setSidebarTab('projects')
        setFocusedTask(`${target.project}/${target.taskId}`)
      } else {
        setFocusedTask(null)
        document.querySelector<HTMLElement>('[role="textbox"][aria-label="Message"]')?.focus()
      }
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
  }, [setSidebarOpen, setSidebarTab, setFocusedTask])

  return null
}
