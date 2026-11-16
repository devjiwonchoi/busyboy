'use client'

import { useOptimistic, useTransition } from 'react'
import { setCompanionAction } from '@/app/settings/actions'
import { CompanionChoices } from '@/components/setup/companion-step'
import type { Companion } from '@/server/companions'

/** The companion grid, saved the moment one is chosen. */
export function CompanionSettings({ companions, selected, imageUrl }: { companions: Companion[]; selected?: string; imageUrl?: string }) {
  const [value, setValue] = useOptimistic(selected)
  const [, startTransition] = useTransition()
  return (
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
  )
}
