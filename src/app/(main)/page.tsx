import { redirect } from 'next/navigation'
import { connection } from 'next/server'
import { Suspense } from 'react'
import { DirectorChat } from '@/components/chat/director-chat'
import { managerPersona } from '@/components/chat/persona'
import { currentCompanion, directorPersona } from '@/server/companions'
import { listManagers } from '@/server/managers'
import { listProjects } from '@/server/projects'

type Search = Promise<{ manager?: string | string[] }>

// Chat area slot: the Director's chat, or the chat of the manager `?manager=<id>`.
export default function ChatPage({ searchParams }: { searchParams: Search }) {
  return (
    <Suspense>
      <Chat searchParams={searchParams} />
    </Suspense>
  )
}

async function Chat({ searchParams }: { searchParams: Search }) {
  await connection()
  const { manager: asked } = await searchParams
  if (typeof asked === 'string') return <ManagerChat id={asked} />
  const [projects, companion, persona] = await Promise.all([listProjects(), currentCompanion(), directorPersona()])
  return (
    <DirectorChat
      key="director"
      projects={projects.map(({ name }) => name)}
      persona={persona}
      header={companion ? `${companion.name}, your director` : undefined}
      greeting={companion?.greeting ?? 'BusyBoy is ready. What should we work on?'}
    />
  )
}

async function ManagerChat({ id }: { id: string }) {
  const manager = (await listManagers()).find((entry) => entry.id === id)
  // A removed manager, or a link from before its project was removed.
  if (!manager) redirect('/')
  return (
    <DirectorChat
      key={manager.id}
      chat={manager.id}
      // A manager works in one project, so the composer offers no project mentions.
      projects={[]}
      persona={managerPersona(manager.name)}
      header={`${manager.name}, manager of ${manager.project}`}
      greeting={`I look after ${manager.project}. What should we work on?`}
    />
  )
}
