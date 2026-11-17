'use client'

import { useActionState } from 'react'
import { CopyCommand } from '@/components/setup/copy-command'
import { Button } from '@/components/ui/button'
import { addConnectorAction, type AddConnectorResult } from '@/app/settings/actions'

export function ConnectorAddForm({
  provider,
  name,
  title,
  command,
}: {
  provider: 'claude' | 'codex'
  name: string
  title: string
  command: string
}) {
  const [state, action, pending] = useActionState(addConnectorAction, {} as AddConnectorResult)
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="provider" value={provider} />
      <input type="hidden" name="name" value={name} />
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{title}</p>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          Add
        </Button>
      </div>
      <CopyCommand label={`Add ${title}`} command={command} />
      {state.error && (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      )}
    </form>
  )
}
