import { userInfo } from 'node:os'
import { connection } from 'next/server'
import { Suspense } from 'react'
import { directorPersona } from '@/server/companions'
import { listProjects } from '@/server/projects'
import { listRooms } from '@/server/rooms'
import { ChatSidebar } from './chat-sidebar'

/** The left chat list, with who the Director is and the projects a new manager can take. */
export function ChatSidebarSlot() {
  return (
    // The list reads the open chat from the URL, which needs a boundary of its own.
    <Suspense>
      <ChatSidebarData />
    </Suspense>
  )
}

async function ChatSidebarData() {
  await connection()
  const [director, projects, rooms] = await Promise.all([directorPersona(), listProjects(), listRooms()])
  return (
    <ChatSidebar
      director={director}
      projects={projects.map(({ name }) => name)}
      rooms={rooms}
      userName={userInfo().username.trim() || 'You'}
    />
  )
}
