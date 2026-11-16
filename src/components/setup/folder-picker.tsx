'use client'

import { FolderPlus } from 'lucide-react'
import { useState, useSyncExternalStore, useTransition } from 'react'
import { addProjectsAction } from '@/app/setup/actions'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { FieldError } from '@/components/ui/field'
import { desktopBridge } from '@/lib/desktop-bridge'

function subscribeNothing() {
  return () => {}
}

/**
 * Adds projects with the native folder picker or by dropping folders. Both need
 * the desktop app's bridge, which a plain browser lacks; there the typed path
 * form below is the way in.
 */
export function FolderPicker() {
  // Read after hydration: the server never has the bridge, so the first render matches it.
  const bridge = useSyncExternalStore(subscribeNothing, desktopBridge, () => undefined)
  const [errors, setErrors] = useState<string[]>([])
  const [dragging, setDragging] = useState(false)
  const [pending, startTransition] = useTransition()

  const add = (folders: string[]) => {
    if (folders.length === 0) return
    startTransition(async () => {
      try {
        setErrors((await addProjectsAction(folders)).errors)
      } catch {
        // Stay on the page: an unexpected failure must not replace setup with an error screen.
        setErrors(['Those folders could not be added. Try again, or type a path below.'])
      }
    })
  }

  const pick = () =>
    startTransition(async () => {
      try {
        add(await bridge!.pickFolders())
      } catch {
        setErrors(['The folder picker could not open. Type the folder path below instead.'])
      }
    })

  return (
    <div className="space-y-2">
      <Empty
        data-dragging={dragging || undefined}
        className="border border-dashed data-dragging:border-primary data-dragging:bg-muted/50"
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          if (!bridge) {
            setErrors(['Dropping folders works in the desktop app. Type the folder path below instead.'])
            return
          }
          add(Array.from(event.dataTransfer.files, (file) => bridge.pathForFile(file)).filter(Boolean))
        }}
      >
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderPlus />
          </EmptyMedia>
          <EmptyTitle>Drop project folders here</EmptyTitle>
          <EmptyDescription>Each folder must be a git repository.</EmptyDescription>
        </EmptyHeader>
        {bridge && (
          <Button variant="outline" disabled={pending} onClick={pick}>
            Choose folders…
          </Button>
        )}
      </Empty>
      {errors.length > 0 && <FieldError errors={errors.map((message) => ({ message }))} />}
    </div>
  )
}
