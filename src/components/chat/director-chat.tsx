'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { messageTaskAction, replyToCardAction, sendToDirectorAction, stopDirectorAction } from '@/app/(main)/director-actions'
import { cn } from '@/lib/utils'
import type { ChatEntry, DirectorStatus, DirectorUpdate } from '@/server/director/chat'
import type { TaskCard } from '@/server/cards/model'
import type { TaskView } from '@/server/tasks'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from '@/components/ui/message'
import { ClosedCard } from './cards/closed-card'
import { OpenCard } from './cards/open-card'
import { mergeTimeline } from './cards/timeline'
import { ChatComposer } from './composer'
import { Markdown } from './markdown'
import { PersonaAvatar, type Persona } from './persona'
import { ReplyTarget } from './reply-target'
import { TaskGroup } from './task-group'

type View = {
  entries: ChatEntry[]
  tasks: Map<string, TaskView>
  /** Open task agent cards, oldest first. */
  cards: TaskCard[]
  status: DirectorStatus
  draft: string
  connected: boolean
  sendError?: string
}

const initialView: View = { entries: [], tasks: new Map(), cards: [], status: 'idle', draft: '', connected: false }

function apply(view: View, update: DirectorUpdate): View {
  switch (update.type) {
    case 'reset':
      return {
        entries: update.entries,
        tasks: new Map(update.tasks.map((task) => [task.id, task])),
        cards: update.cards,
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
    case 'card-opened':
      return { ...view, cards: [...view.cards.filter(({ id }) => id !== update.card.id), update.card] }
    case 'card-closed':
      return { ...view, cards: view.cards.filter(({ id }) => id !== update.cardId) }
  }
}

/**
 * A chat with the Director, or with the manager `chat`: the greeting, the
 * transcript, the reply being written, and the composer. The page gives each
 * chat its own key, so switching chats starts this component over.
 */
export function DirectorChat({
  projects,
  persona,
  chat = null,
  header,
  greeting,
}: {
  projects: string[]
  persona: Persona
  /** The manager's id; null for the Director. */
  chat?: string | null
  /** Shown above the greeting in place of the name. */
  header?: string
  greeting: string
}) {
  const [view, setView] = useState(initialView)
  // The card the composer replies to, picked only by the user with a card's Reply. A card
  // never takes the composer by itself: a message typed for the Director must not reach a
  // task agent because a card opened meanwhile. The choice ends when its card closes.
  const [replyChoice, setReplyChoice] = useState<string | null>(null)
  // Set when the chosen card closed before the reply was sent. The reply is then refused, not sent
  // to the Director: "yes, delete it" meant for a task agent must not become a Director prompt.
  const [replyLost, setReplyLost] = useState(false)
  const choice = useRef(replyChoice)
  useEffect(() => {
    choice.current = replyChoice
  }, [replyChoice])
  // The task the composer messages, picked only by the user with a task's Message, for one message.
  // Like a card, a task never takes the composer by itself.
  const [messageChoice, setMessageChoice] = useState<string | null>(null)
  // Set when the chosen task stopped taking messages (it opened a card, or was archived) before
  // the message was sent. Like a lost card reply, that message is refused, not sent to the Director.
  const [messageLost, setMessageLost] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const name = persona.name

  useEffect(() => {
    const source = new EventSource(chat ? `/api/director/events?chat=${encodeURIComponent(chat)}` : '/api/director/events')
    source.onmessage = (message) => {
      const update = JSON.parse(message.data) as DirectorUpdate
      setView((current) => apply(current, update))
      // The reply choice ends with its card. It is checked per update, not per render: a plan card
      // that closes and opens again keeps its id, and both updates can land in the same render.
      const lost =
        choice.current !== null &&
        ((update.type === 'card-closed' && update.cardId === choice.current) ||
          (update.type === 'reset' && !update.cards.some(({ id }) => id === choice.current)))
      if (lost) {
        choice.current = null
        setReplyChoice(null)
        setReplyLost(true)
      }
    }
    source.onerror = () => setView((current) => ({ ...current, connected: false }))
    return () => source.close()
  }, [chat])

  // Keep the newest message in view. Set scrollTop directly (scrollIntoView
  // returns a Promise in this Chromium, which an effect must not return).
  useLayoutEffect(() => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [view.entries, view.draft, view.tasks, view.cards])

  const thinking = view.status === 'answering' && !view.draft
  const replyCard = view.cards.find(({ id }) => id === replyChoice)
  const replyCardId = replyCard?.id ?? null
  // A task that started waiting on a card is answered on that card, so the choice no longer applies.
  const chosenTask = messageChoice && !replyCard ? view.tasks.get(messageChoice) : undefined
  const messageTask =
    chosenTask && !chosenTask.subagent && !chosenTask.archived && chosenTask.status !== 'needs-you' ? chosenTask : undefined
  // The choice ends when it stops applying, so the composer never points back at the task by itself later.
  const choiceEnded = messageChoice !== null && view.connected && !messageTask && !replyCard
  useEffect(() => {
    if (!choiceEnded) return
    setMessageChoice(null)
    setMessageLost(true)
  }, [choiceEnded])
  const target = replyCard
    ? `${replyCard.project} · ${replyCard.taskTitle}`
    : messageTask
      ? `${messageTask.project} · ${messageTask.title}`
      : null

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
          <DirectorMessage persona={persona} header={header}>
            <Bubble variant="muted">
              <BubbleContent>{greeting}</BubbleContent>
            </Bubble>
          </DirectorMessage>
          {mergeTimeline(view.entries, view.cards).map((row) =>
            row.type === 'card' ? (
              <OpenCard
                key={row.key}
                card={row.card}
                replying={row.card.id === replyCardId}
                onReplyChange={(replying) => {
                  choice.current = replying ? row.card.id : null
                  setReplyLost(false)
                  setReplyChoice(choice.current)
                  setMessageLost(false)
                  if (replying) setMessageChoice(null)
                }}
              />
            ) : (
              <EntryView
                key={row.key}
                entry={row.entry}
                tasks={view.tasks}
                persona={persona}
                messaging={messageTask?.id ?? null}
                onMessage={(taskId) => {
                  // One target at a time: a task replaces a card reply.
                  choice.current = null
                  setReplyChoice(null)
                  setReplyLost(false)
                  setMessageLost(false)
                  setMessageChoice(taskId)
                }}
              />
            ),
          )}
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
          leading={
            target ? (
              <ReplyTarget
                mode={replyCard ? 'reply' : 'message'}
                target={target}
                directorName={name}
                onClear={() => {
                  setReplyChoice(null)
                  setMessageChoice(null)
                  setMessageLost(false)
                }}
              />
            ) : undefined
          }
          placeholder={target ? `${replyCard ? 'Reply to' : 'Message'} ${target}` : `Message ${name}`}
          onStop={
            view.status === 'answering'
              ? () =>
                  void stopDirectorAction(chat).catch(() =>
                    setView((current) => ({ ...current, sendError: 'The reply could not be stopped. Try again.' })),
                  )
              : undefined
          }
          onSend={(text) => {
            if (replyLost) {
              setReplyLost(false)
              setView((current) => ({
                ...current,
                sendError: `The card you were replying to closed, so this was not sent. Send again to message ${name}.`,
              }))
              return Promise.reject(new Error('The reply card closed.'))
            }
            // Also when the choice ended in this very render, before the effect above ran.
            if (messageLost || choiceEnded) {
              setMessageLost(false)
              setMessageChoice(null)
              setView((current) => ({
                ...current,
                sendError: `The task you were messaging stopped taking messages, so this was not sent. Send again to message ${name}.`,
              }))
              return Promise.reject(new Error('The task stopped taking messages.'))
            }
            if (replyCard) {
              // A delivered reply closes its card; that close must not count as a lost reply.
              return replyToCardAction(replyCard.id, text).then(
                () => {
                  choice.current = null
                  setReplyChoice(null)
                  setReplyLost(false)
                },
                (error: unknown) => {
                  setView((current) => ({ ...current, sendError: 'The message could not be sent. Try again.' }))
                  throw error
                },
              )
            }
            if (messageTask) {
              return messageTaskAction(messageTask.id, text).then(
                ({ error }) => {
                  if (error) {
                    setView((current) => ({ ...current, sendError: error }))
                    throw new Error(error)
                  }
                  setMessageChoice(null)
                },
                (error: unknown) => {
                  setView((current) => ({ ...current, sendError: 'The message could not be sent. Try again.' }))
                  throw error
                },
              )
            }
            return sendToDirectorAction(text, chat).catch((error: unknown) => {
              setView((current) => ({ ...current, sendError: 'The message could not be sent. Try again.' }))
              throw error
            })
          }}
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

/** A message from the Director or a manager, shown with its picture and name. */
export function DirectorMessage({ persona, header, children }: { persona: Persona; header?: string; children: React.ReactNode }) {
  return (
    <Message>
      {persona.mark && (
        <MessageAvatar>
          <PersonaAvatar persona={persona} />
        </MessageAvatar>
      )}
      <MessageContent>
        <MessageHeader>{header ?? persona.name}</MessageHeader>
        {children}
      </MessageContent>
    </Message>
  )
}

function EntryView({
  entry,
  tasks,
  persona,
  messaging,
  onMessage,
}: {
  entry: ChatEntry
  tasks: Map<string, TaskView>
  persona: Persona
  messaging: string | null
  onMessage: (taskId: string | null) => void
}) {
  switch (entry.kind) {
    case 'user':
      return (
        <Message align="end">
          <MessageContent>
            {entry.to && <MessageHeader>To {entry.to}</MessageHeader>}
            <Bubble role="group" aria-label={entry.to ? `Your reply to ${entry.to}` : 'Your message'}>
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
      return <TaskGroup taskIds={entry.taskIds} tasks={tasks} messaging={messaging} onMessage={onMessage} />
    case 'card':
      return <ClosedCard entry={entry} />
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
