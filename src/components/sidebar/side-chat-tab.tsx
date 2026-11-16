import { connection } from 'next/server'
import { Suspense } from 'react'
import type { SidebarTabMeta } from '@/components/shell/sidebar-tab-registry'
import { companionImageUrl, currentCompanion } from '@/server/companions'
import { SideChat } from './side-chat'

export const tab: SidebarTabMeta = { id: 'side-chat', title: 'Side chat', order: 20 }

export default function SideChatTab() {
  return (
    <Suspense>
      <SideChatWithPersona />
    </Suspense>
  )
}

// Answers come from the companion the user picked, like the main chat's.
async function SideChatWithPersona() {
  await connection()
  const [companion, imageUrl] = await Promise.all([currentCompanion(), companionImageUrl()])
  return <SideChat persona={{ companion: companion ?? null, imageUrl }} />
}
