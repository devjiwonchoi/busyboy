'use client'

import { useOptimistic, useTransition } from 'react'
import { setCompanionAction } from '@/app/settings/actions'
import { CharacterNote, CompanionChoices } from '@/components/setup/companion-step'
import type { Companion } from '@/server/companions'

export function CompanionSettings({ companions, selected, imageUrl }: { companions: Companion[]; selected?: string; imageUrl?: string }) {
  const [value, setValue] = useOptimistic(selected)
  const [, startTransition] = useTransition()
  const chosen = companions.find((companion) => companion.id === value)
  return (
    <div className="space-y-6">
      <CompanionChoices
        companions={companions}
        value={value}
        imageUrl={imageUrl}
        onChange={(id) =>
          startTransition(async () => {
            setValue(id)
            await setCompanionAction(id)
          })
        }
      />
      {chosen && (
        <dl className="divide-y border-y text-sm">
          <div className="flex items-center justify-between gap-4 py-3">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{chosen.name}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-3">
            <dt className="text-muted-foreground">Speech</dt>
            <dd>{chosen.speech}</dd>
          </div>
        </dl>
      )}
      <CharacterNote />
    </div>
  )
}
