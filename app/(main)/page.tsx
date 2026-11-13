import { connection } from 'next/server'
import { Suspense } from 'react'
import { MasterChat } from '@/components/chat/master-chat'
import { listProjects } from '@/server/projects'

// Chat area slot: the master chat.
export default function ChatPage() {
  return (
    <Suspense>
      <ChatWithProjects />
    </Suspense>
  )
}

async function ChatWithProjects() {
  await connection()
  const projects = (await listProjects()).map(({ name }) => name)
  return <MasterChat projects={projects} />
}
