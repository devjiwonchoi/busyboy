import { connection } from 'next/server'
import { Suspense } from 'react'
import { DirectorChat } from '@/components/chat/director-chat'
import { companionImageUrl, currentCompanion } from '@/server/companions'
import { listProjects } from '@/server/projects'

// Chat area slot: the Director's chat.
export default function ChatPage() {
  return (
    <Suspense>
      <ChatWithProjects />
    </Suspense>
  )
}

async function ChatWithProjects() {
  await connection()
  const [projects, companion, imageUrl] = await Promise.all([listProjects(), currentCompanion(), companionImageUrl()])
  return (
    <DirectorChat projects={projects.map(({ name }) => name)} persona={{ companion: companion ?? null, imageUrl }} />
  )
}
