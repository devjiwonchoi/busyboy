'use client'

import { Download } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { desktopBridge } from '@/lib/desktop-bridge'

// In a plain browser there is no updater, so the button never shows.
export function UpdateButton() {
  const [version, setVersion] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    const bridge = desktopBridge()
    if (!bridge?.onUpdateReady) return
    let stopped = false
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
