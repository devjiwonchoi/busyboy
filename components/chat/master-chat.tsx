'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { sendToMasterAction } from '@/app/(main)/master-actions'
import { cn } from '@/lib/utils'
import type { ChatEntry, MasterStatus, MasterUpdate } from '@/server/master-chat'
import type { TaskView } from '@/server/tasks'
import { Bubble } from './bubble'
import { Composer } from './composer'
import { Markdown } from './markdown'
import { TaskGroup } from './task-group'

type View = {
  entries: ChatEntry[]
  tasks: Map<string, TaskView>
  status: MasterStatus
  draft: string
  connected: boolean
  sendError?: string
}

const initialView: View = { entries: [], tasks: new Map(), status: 'idle', draft: '', connected: false }

function apply(view: View, update: MasterUpdate): View {
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

/** The master chat: transcript of bubbles, the reply being written, and the composer. */
export function MasterChat({ projects }: { projects: string[] }) {
  const [view, setView] = useState(initialView)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const source = new EventSource('/api/master/events')
    source.onmessage = (message) => setView((current) => apply(current, JSON.parse(message.data) as MasterUpdate))
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
          {view.connected && view.entries.length === 0 && (
            <p className="text-muted-foreground py-12 text-center text-sm">
              Ask a question, or ask for work in a project. Type @ to name one.
            </p>
          )}
          {view.entries.map((entry) => (
            <EntryView key={entry.id} entry={entry} tasks={view.tasks} />
          ))}
          {view.draft && (
            <Bubble aria-label="Reply in progress" aria-busy>
              <Markdown text={view.draft} streaming />
            </Bubble>
          )}
          {(thinking || view.status === 'compacting') && (
            <p role="status" className="text-muted-foreground animate-pulse text-xs">
              {thinking ? 'Thinking…' : 'Compacting context…'}
            </p>
          )}
        </section>
      </div>
      <div className="mx-auto w-full max-w-3xl px-6 pb-4">
        <Composer
          projects={projects}
          onSend={(text) =>
            sendToMasterAction(text).catch(() =>
              setView((current) => ({ ...current, sendError: 'The message could not be sent. Try again.' })),
            )
          }
        />
        {view.sendError && (
          <p role="alert" className="text-destructive mt-2 text-xs">
            {view.sendError}
          </p>
        )}
      </div>
    </div>
  )
}

function EntryView({ entry, tasks }: { entry: ChatEntry; tasks: Map<string, TaskView> }) {
  switch (entry.kind) {
    case 'user':
      return (
        <Bubble from="user" aria-label="Your message">
          {entry.text}
        </Bubble>
      )
    case 'master':
      return (
        <div className="flex flex-col gap-1">
          <Bubble aria-label="Master reply" data-interrupted={entry.interrupted || undefined}>
            <Markdown text={entry.text} />
          </Bubble>
          {entry.interrupted && <span className="text-muted-foreground text-xs">Interrupted</span>}
        </div>
      )
    case 'tasks':
      return <TaskGroup taskIds={entry.taskIds} tasks={tasks} />
    case 'note':
      return (
        <p
          role="note"
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
