import { join } from 'node:path'
import { redirect } from 'next/navigation'
import { connection } from 'next/server'
import { Suspense } from 'react'
import { DirectorChat } from '@/components/chat/director-chat'
import { managerPersona } from '@/components/chat/persona'
import { readChatHarness, type ChatHarness } from '@/server/chat-harness'
import { currentCompanion, directorPersona } from '@/server/companions'
import { dataFolder, readSettings } from '@/server/config'
import { DIRECTOR_FOLDER, MANAGERS_FOLDER } from '@/server/director/chat'
import { listManagers } from '@/server/managers'
import { listProjects } from '@/server/projects'
import type { ProviderId } from '@/server/runner/contract'

type Search = Promise<{ manager?: string | string[] }>

// Chat area slot: the Director's chat, or the chat of the manager `?manager=<id>`.
export default function ChatPage({ searchParams }: { searchParams: Search }) {
  return (
    <Suspense>
      <Chat searchParams={searchParams} />
    </Suspense>
  )
}

async function harnessFor(chat: string | null): Promise<{ fallback: ProviderId; choice: ChatHarness | null }> {
  const folder = await dataFolder()
  const [settings, choice] = await Promise.all([
    readSettings(),
    readChatHarness(chat ? join(folder, MANAGERS_FOLDER, chat) : join(folder, DIRECTOR_FOLDER)),
  ])
  return { fallback: settings.defaultProvider ?? 'claude', choice }
}

async function Chat({ searchParams }: { searchParams: Search }) {
  await connection()
  const { manager: asked } = await searchParams
  if (typeof asked === 'string') return <ManagerChat id={asked} />
  const [projects, companion, persona, harness] = await Promise.all([
    listProjects(),
    currentCompanion(),
    directorPersona(),
    harnessFor(null),
  ])
  return (
    <DirectorChat
      key="director"
      projects={projects.map(({ name }) => name)}
      persona={persona}
      header={companion ? `${companion.name}, your director` : undefined}
      greeting={companion?.greeting ?? 'BusyBoy is ready. What should we work on?'}
      harnessFallback={harness.fallback}
      initialHarness={harness.choice}
    />
  )
}

async function ManagerChat({ id }: { id: string }) {
  const [manager, harness] = await Promise.all([
    listManagers().then((managers) => managers.find((entry) => entry.id === id)),
    harnessFor(id),
  ])
  // A removed manager, or a link from before its project was removed.
  if (!manager) redirect('/')
  return (
    <DirectorChat
      key={manager.id}
      chat={manager.id}
      // A manager works in one project, so `@` offers that project's files.
      projects={[]}
      managedProject={manager.project}
      persona={managerPersona(manager.name)}
      header={`${manager.name}, manager of ${manager.project}`}
      greeting={`I look after ${manager.project}. What should we work on?`}
      harnessFallback={harness.fallback}
      initialHarness={harness.choice}
    />
  )
}
