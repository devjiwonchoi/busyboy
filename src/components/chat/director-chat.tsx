'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  archiveTaskAction,
  messageTaskAction,
  replyToCardAction,
  reviseDirectorMessageAction,
  sendDirectorQueueNowAction,
  sendToDirectorAction,
  stopDirectorAction,
} from '@/app/(main)/director-actions'
import { EscapeShortcut } from '@/components/shell/shortcut-registry'
import { cn } from '@/lib/utils'
import type { ChatEntry, DirectorStatus, DirectorUpdate } from '@/server/director/chat'
import type { TaskCard } from '@/server/cards/model'
import type { TaskView } from '@/server/tasks'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader } from '@/components/ui/message'
import { ClosedCard } from './cards/closed-card'
import { OpenCard } from './cards/open-card'
import { mergeTimeline } from './cards/timeline'
import { ContextMeter, type ContextUsage } from './context-meter'
import { ChatComposer, type ChatComposerHandle, type ComposerMessage } from './composer'
import { Markdown } from './markdown'
import { MessageActions } from './message-actions'
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
  queue: string[]
  usage: ContextUsage | null
  connected: boolean
  sendError?: string
}

const initialView: View = { entries: [], tasks: new Map(), cards: [], status: 'idle', draft: '', queue: [], usage: null, connected: false }

type UserEntry = Extract<ChatEntry, { kind: 'user' }>
type DirectorReply = Extract<ChatEntry, { kind: 'director' }>

/** The latest message sent to this chat, and whether its turn failed or was interrupted. */
function latestTurn(entries: ChatEntry[]): { user: UserEntry; reply?: DirectorReply; retry: boolean } | null {
  let userIndex = -1
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.kind === 'user' && !entry.to) {
      userIndex = index
      break
    }
  }
  if (userIndex === -1) return null
  const user = entries[userIndex] as UserEntry
  let reply: DirectorReply | undefined
  let failed = false
  for (const entry of entries.slice(userIndex + 1)) {
    if (entry.kind === 'director' && !reply) reply = entry
    if (entry.kind === 'note' && (entry.tone === 'error' || entry.text === 'Stopped.')) failed = true
  }
  return { user, reply, retry: Boolean((reply && reply.interrupted) || (!reply && failed)) }
}

/** Escape stops this chat. A repeated key is the hold, not a second stop. */
function directorHandlesEscape(event: KeyboardEvent) {
  return !event.repeat
}

function apply(view: View, update: DirectorUpdate): View {
  switch (update.type) {
    case 'reset':
      return {
        entries: update.entries,
        tasks: new Map(update.tasks.map((task) => [task.id, task])),
        cards: update.cards,
        status: update.status,
        draft: update.draft,
        queue: update.queue,
        usage: update.usage,
        connected: true,
      }
    case 'entry': {
      const index = view.entries.findIndex(({ id }) => id === update.entry.id)
      const entries = [...view.entries]
      if (index === -1) entries.push(update.entry)
      else entries[index] = update.entry
      return { ...view, entries, sendError: update.entry.kind === 'user' ? undefined : view.sendError }
    }
    case 'entries':
      return { ...view, entries: update.entries }
    case 'queue':
      return { ...view, queue: update.messages }
    case 'draft':
      return { ...view, draft: update.text }
    case 'status':
      return { ...view, status: update.status }
    case 'usage':
      return { ...view, usage: update.usage }
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
  managedProject = null,
  header,
  greeting,
}: {
  projects: string[]
  persona: Persona
  /** The manager's id; null for the Director. */
  chat?: string | null
  /** Set for a manager: `@` lists that project's files instead of every project. */
  managedProject?: string | null
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
  const [seed, setSeed] = useState<{ token: number; text: string } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftText, setDraftText] = useState('')
  const stash = useRef('')
  const seedToken = useRef(0)
  const retrying = useRef(false)
  const scroller = useRef<HTMLDivElement>(null)
  const honoredJump = useRef<string | null>(null)
  const [jumpId, setJumpId] = useState<string | null>(null)
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

  useEffect(() => {
    const read = () => setJumpId(decodeURIComponent(window.location.hash.replace(/^#/, '')) || null)
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [])

  // Keep the newest message in view, unless a command-palette hit asked for a line.
  // Set scrollTop directly (scrollIntoView returns a Promise in this Chromium,
  // which an effect must not return).
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const target = jumpId ? element.querySelector<HTMLElement>(`[data-jump-id="${CSS.escape(jumpId)}"]`) : null
    if (jumpId && target && honoredJump.current !== jumpId) {
      target.scrollIntoView({ block: 'center' })
      honoredJump.current = jumpId
      return
    }
    // Stay on a hit. A cleared hash (the next message) follows the bottom again.
    if (jumpId && target) return
    element.scrollTop = element.scrollHeight
  }, [view.entries, view.draft, view.tasks, view.cards, jumpId])

  const turn = latestTurn(view.entries)
  const canEdit = view.status === 'idle' && view.queue.length === 0
  const queued = view.status === 'answering' ? view.queue : []

  function fillComposer(text: string) {
    seedToken.current += 1
    setSeed({ token: seedToken.current, text })
  }

  function beginEdit(text: string, id: string) {
    if (!canEdit) return
    if (editingId === null) stash.current = draftText
    setEditingId(id)
    fillComposer(text)
  }

  function cancelEdit() {
    const text = stash.current
    setEditingId(null)
    fillComposer(text)
  }

  function stopReply() {
    void stopDirectorAction(chat).catch(() =>
      setView((current) => ({ ...current, sendError: 'The reply could not be stopped. Try again.' })),
    )
  }

  function sendQueuedNow() {
    void sendDirectorQueueNowAction(chat).catch(() =>
      setView((current) => ({ ...current, sendError: 'The message could not be sent. Try again.' })),
    )
  }

  function retry() {
    if (retrying.current || !turn?.retry) return
    retrying.current = true
    void reviseDirectorMessageAction(turn.user.id, turn.user.text, chat)
      .catch(() => setView((current) => ({ ...current, sendError: 'The message could not be sent. Try again.' })))
      .finally(() => {
        retrying.current = false
      })
  }

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

  const composer = useRef<ChatComposerHandle>(null)

  function sendComposer(message: ComposerMessage) {
    if (window.location.hash) {
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
      honoredJump.current = null
      setJumpId(null)
    }
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
    const report = (error: string): never => {
      setView((current) => ({ ...current, sendError: error }))
      throw new Error(error)
    }
    const sent =
      editingId && !replyCard && !messageTask
        ? reviseDirectorMessageAction(editingId, message.text, chat, message.attachments).then(({ error }) => {
            if (error) report(error)
            setEditingId(null)
          })
        : replyCard
          ? // A delivered reply closes its card; that close must not count as a lost reply.
            replyToCardAction(replyCard.id, message.text, message.attachments).then(({ error }) => {
              if (error) report(error)
              choice.current = null
              setReplyChoice(null)
              setReplyLost(false)
            })
          : messageTask
            ? messageTaskAction(messageTask.id, message.text, message.attachments).then(({ error }) => {
                if (error) report(error)
                setMessageChoice(null)
              })
            : sendToDirectorAction(message.text, chat, message.attachments).then(({ error }) => {
                if (error) report(error)
              })
    // A rejection with no message of its own still tells the user to try again.
    return sent.catch((error: unknown) => {
      if (error instanceof Error && error.message) throw error
      report('The message could not be sent. Try again.')
    })
  }

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes('Files')) return
        event.preventDefault()
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return
        event.preventDefault()
        composer.current?.addFiles(event.dataTransfer.files)
      }}
    >
      {view.status === 'answering' && (
        <EscapeShortcut id="stop-director-reply" label="Stop the reply" handles={directorHandlesEscape} run={stopReply} />
      )}
      {editingId && view.status !== 'answering' && (
        <EscapeShortcut id="cancel-message-edit" label="Cancel editing" handles={directorHandlesEscape} run={cancelEdit} />
      )}
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
              <div
                key={row.key}
                data-jump-id={`entry-${row.entry.id}`}
                data-current={jumpId === `entry-${row.entry.id}` ? 'true' : undefined}
                className={jumpId === `entry-${row.entry.id}` ? 'rounded-md ring-2 ring-ring' : undefined}
              >
              <EntryView
                entry={row.entry}
                tasks={view.tasks}
                persona={persona}
                messaging={messageTask?.id ?? null}
                turn={turn}
                canEdit={canEdit}
                onEdit={beginEdit}
                onRetry={retry}
                currentJump={jumpId}
                onMessage={(taskId) => {
                  // One target at a time: a task replaces a card reply.
                  choice.current = null
                  setReplyChoice(null)
                  setReplyLost(false)
                  setMessageLost(false)
                  setMessageChoice(taskId)
                }}
              />
              </div>
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
        <ContextMeter usage={view.usage} />
        {editingId && (
          <div role="status" aria-label="Editing your last message" className="text-muted-foreground mb-2 flex items-center gap-2 text-xs">
            <span>Editing your last message</span>
            <Button type="button" size="xs" variant="ghost" onClick={cancelEdit}>
              Cancel
            </Button>
          </div>
        )}
        {queued.length > 0 && (
          <div role="status" aria-label="Queued message" className="bg-muted/70 mb-2 flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs">
            <span className="text-muted-foreground shrink-0">
              {queued.length > 1 ? `${queued.length} queued` : 'Send after this reply'}
            </span>
            <span className="min-w-0 flex-1 truncate">{queued.join('  ·  ')}</span>
            <Button type="button" size="xs" variant="secondary" onClick={sendQueuedNow}>
              Send now
            </Button>
          </div>
        )}
        <ChatComposer
          ref={composer}
          projects={projects}
          filesProject={messageTask?.project ?? managedProject}
          canStop={view.status === 'answering'}
          canArchive={Boolean(messageTask)}
          onCommand={(command) => {
            if (command === 'stop') stopReply()
            if (command === 'archive' && messageTask) {
              const taskId = messageTask.id
              setMessageChoice(null)
              void archiveTaskAction(taskId).then(({ error }) => {
                if (error) setView((current) => ({ ...current, sendError: error }))
              })
            }
          }}
          draftKey={chat ?? 'director'}
          seed={seed}
          onTextChange={setDraftText}
          onEmptyArrowUp={() => {
            if (turn && canEdit) beginEdit(turn.user.text, turn.user.id)
          }}
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
          onStop={view.status === 'answering' ? stopReply : undefined}
          onSend={(message) => sendComposer(message)}
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
  turn,
  canEdit,
  onEdit,
  onRetry,
  currentJump,
  onMessage,
}: {
  entry: ChatEntry
  tasks: Map<string, TaskView>
  persona: Persona
  messaging: string | null
  turn: ReturnType<typeof latestTurn>
  canEdit: boolean
  onEdit: (text: string, id: string) => void
  onRetry: () => void
  currentJump: string | null
  onMessage: (taskId: string | null) => void
}) {
  switch (entry.kind) {
    case 'user':
      return (
        <Message align="end">
          <MessageContent>
            {entry.to && <MessageHeader>To {entry.to}</MessageHeader>}
            <div className="relative flex w-full min-w-0 flex-col items-end pt-7">
              <Bubble role="group" aria-label={entry.to ? `Your reply to ${entry.to}` : 'Your message'}>
                <BubbleContent className="whitespace-pre-wrap">{entry.text}</BubbleContent>
              </Bubble>
              <MessageActions
                align="end"
                text={entry.text}
                at={entry.at}
                onEdit={!entry.to && canEdit && turn?.user.id === entry.id ? () => onEdit(entry.text, entry.id) : undefined}
                onRetry={turn?.retry && !turn.reply && turn.user.id === entry.id ? onRetry : undefined}
              />
            </div>
          </MessageContent>
        </Message>
      )
    case 'director':
      return (
        <DirectorMessage persona={persona}>
          <div className="relative flex w-full min-w-0 flex-col items-start pt-7">
            <Bubble variant="muted" role="group" aria-label="Reply" data-interrupted={entry.interrupted || undefined}>
              <BubbleContent>
                <Markdown text={entry.text} />
              </BubbleContent>
            </Bubble>
            <MessageActions
              align="start"
              text={entry.text}
              at={entry.at}
              onRetry={turn?.retry && turn.reply?.id === entry.id ? onRetry : undefined}
            />
          </div>
          {entry.interrupted && <MessageFooter>Interrupted</MessageFooter>}
        </DirectorMessage>
      )
    case 'tasks':
      return <TaskGroup taskIds={entry.taskIds} tasks={tasks} messaging={messaging} currentJump={currentJump} onMessage={onMessage} />
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
