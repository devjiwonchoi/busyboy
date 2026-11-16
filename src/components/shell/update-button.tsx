'use client'

import { Download } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { desktopBridge } from '@/lib/desktop-bridge'

/**
 * Shown in the title bar once the desktop app has downloaded a newer version.
 * Pressing it restarts BusyBoy into that version; tasks that were working
 * carry on when it is back. In a plain browser there is no updater and it never shows.
 */
export function UpdateButton() {
  const [version, setVersion] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    const bridge = desktopBridge()
    // An app from before the updater existed has no update methods on its bridge.
    if (!bridge?.onUpdateReady) return
    let stopped = false
    // The download may have finished before this page opened.
    void bridge.readyUpdate().then(
      (ready) => {
        if (ready && !stopped) setVersion(ready)
      },
      () => {},
    )
    const stop = bridge.onUpdateReady(setVersion)
    return () => {
      stopped = true
      stop()
    }
  }, [])

  if (!version) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            disabled={restarting}
            onClick={() => {
              // The app closes when this works, and starts over by itself when it does not,
              // so the button is not offered a second time on this page.
              setRestarting(true)
              void desktopBridge()
                ?.installUpdate()
                .catch(() => setRestarting(false))
            }}
          />
        }
      >
        <Download />
        {restarting ? 'Restarting…' : 'Restart to update'}
      </TooltipTrigger>
      <TooltipContent>BusyBoy {version} is downloaded. Working tasks carry on after the restart.</TooltipContent>
    </Tooltip>
  )
}
