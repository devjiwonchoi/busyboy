'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { sendToDirectorAction, stopDirectorAction } from '@/app/(main)/director-actions'
import { cn } from '@/lib/utils'
import type { Companion } from '@/server/companions'
import type { ChatEntry, DirectorStatus, DirectorUpdate } from '@/server/director/chat'
import type { TaskView } from '@/server/tasks'
import { CompanionAvatar } from '@/components/companion/companion-avatar'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from '@/components/ui/message'
import { ChatComposer } from './composer'
import { Markdown } from './markdown'
import { TaskGroup } from './task-group'

type View = {
  entries: ChatEntry[]
  tasks: Map<string, TaskView>
  status: DirectorStatus
  draft: string
  connected: boolean
  sendError?: string
}

const initialView: View = { entries: [], tasks: new Map(), status: 'idle', draft: '', connected: false }

function apply(view: View, update: DirectorUpdate): View {
  switch (update.type) {
    case 'reset':
      return {
        entries: update.entries,
        tasks: new Map(update.tasks.map((task) => [task.id, task])),
        status: update.status,
        draft: update.draft,
        connected: true,
      }
    case 'entry': {
      const index = view.entries.findIndex(({ id }) => id === update.entry.id)
      const entries = [...view.entries]
      if (index === -1) entries.push(update.entry)
      else entries[index] = update.entry
      return { ...view, entries, sendError: update.entry.kind === 'user' ? undefined : view.sendError }
    }
    case 'draft':
      return { ...view, draft: update.text }
    case 'status':
      return { ...view, status: update.status }
    case 'task':
      return { ...view, tasks: new Map(view.tasks).set(update.task.id, update.task) }
  }
}

/** Who the Director appears as: the companion chosen in setup, or BusyBoy itself before one is chosen. */
export type Persona = { companion: Companion | null; imageUrl?: string }

/** The Director chat: the companion's greeting, the transcript, the reply being written, and the composer. */
export function DirectorChat({ projects, persona }: { projects: string[]; persona: Persona }) {
  const [view, setView] = useState(initialView)
  const scroller = useRef<HTMLDivElement>(null)
  const name = persona.companion?.name ?? 'BusyBoy'

  useEffect(() => {
    const source = new EventSource('/api/director/events')
    source.onmessage = (message) => setView((current) => apply(current, JSON.parse(message.data) as DirectorUpdate))
    source.onerror = () => setView((current) => ({ ...current, connected: false }))
    return () => source.close()
  }, [])

  // Keep the newest message in view. Set scrollTop directly (scrollIntoView
  // returns a Promise in this Chromium, which an effect must not return).
  useLayoutEffect(() => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [view.entries, view.draft, view.tasks])

  const thinking = view.status === 'answering' && !view.draft

  return (
    <div className="flex h-full flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <section
          role="log"
          aria-label="Transcript"
          data-connected={view.connected}
          data-status={view.status}
          className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-6"
        >
          <DirectorMessage persona={persona} header={persona.companion ? `${name}, your director` : undefined}>
            <Bubble variant="muted">
              <BubbleContent>{persona.companion?.greeting ?? 'BusyBoy is ready. What should we work on?'}</BubbleContent>
            </Bubble>
          </DirectorMessage>
          {view.entries.map((entry) => (
            <EntryView key={entry.id} entry={entry} tasks={view.tasks} persona={persona} />
          ))}
          {view.draft && (
            <DirectorMessage persona={persona}>
              <Bubble variant="muted" role="group" aria-label="Reply in progress" aria-busy>
                <BubbleContent>
                  <Markdown text={view.draft} streaming />
                </BubbleContent>
              </Bubble>
            </DirectorMessage>
          )}
          {(thinking || view.status === 'compacting') && (
            <p role="status" className="text-muted-foreground animate-pulse text-xs">
              {thinking ? `${name} is thinking…` : 'Compacting context…'}
            </p>
          )}
        </section>
      </div>
      <div className="mx-auto w-full max-w-3xl px-6 pb-4">
        <ChatComposer
          projects={projects}
          placeholder={`Message ${name}`}
          onStop={
            view.status === 'answering'
              ? () =>
                  void stopDirectorAction().catch(() =>
                    setView((current) => ({ ...current, sendError: 'The reply could not be stopped. Try again.' })),
                  )
              : undefined
          }
          onSend={(text) =>
            sendToDirectorAction(text).catch((error: unknown) => {
              setView((current) => ({ ...current, sendError: 'The message could not be sent. Try again.' }))
              throw error
            })
          }
        />
        {view.sendError && (
          <Alert variant="destructive" className="mt-2">
            <AlertDescription>{view.sendError}</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  )
}

/** A message from the Director, shown with the companion's picture and name. */
export function DirectorMessage({ persona, header, children }: { persona: Persona; header?: string; children: React.ReactNode }) {
  return (
    <Message>
      {persona.companion && (
        <MessageAvatar>
          <CompanionAvatar companion={persona.companion} imageUrl={persona.imageUrl} className="size-8 text-base" />
        </MessageAvatar>
      )}
      <MessageContent>
        <MessageHeader>{header ?? persona.companion?.name ?? 'BusyBoy'}</MessageHeader>
        {children}
      </MessageContent>
    </Message>
  )
}

function EntryView({ entry, tasks, persona }: { entry: ChatEntry; tasks: Map<string, TaskView>; persona: Persona }) {
  switch (entry.kind) {
    case 'user':
      return (
        <Message align="end">
          <MessageContent>
            <Bubble role="group" aria-label="Your message">
              <BubbleContent className="whitespace-pre-wrap">{entry.text}</BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      )
    case 'director':
      return (
        <DirectorMessage persona={persona}>
          <Bubble variant="muted" role="group" aria-label="Reply" data-interrupted={entry.interrupted || undefined}>
            <BubbleContent>
              <Markdown text={entry.text} />
            </BubbleContent>
          </Bubble>
          {entry.interrupted && <MessageFooter>Interrupted</MessageFooter>}
        </DirectorMessage>
      )
    case 'tasks':
      return <TaskGroup taskIds={entry.taskIds} tasks={tasks} />
    case 'note':
      return (
        <p
          // Errors are announced; other notes are read in place.
          role={entry.tone === 'error' ? 'alert' : 'note'}
          className={cn(
            'text-xs',
            entry.tone === 'error' ? 'text-destructive' : 'text-muted-foreground self-center',
          )}
        >
          {entry.text}
        </p>
      )
  }
}
