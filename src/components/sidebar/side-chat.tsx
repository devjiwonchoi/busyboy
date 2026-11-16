'use client'

import { Plus, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { askSideQuestionAction, closeSideChatAction } from '@/app/(main)/side-chat-actions'
import { ChatComposer } from '@/components/chat/composer'
import { DirectorMessage, type Persona } from '@/components/chat/director-chat'
import { Markdown } from '@/components/chat/markdown'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import { Message, MessageContent } from '@/components/ui/message'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { AgentEventEnvelope } from '@/server/runner/contract'

type Exchange = {
  /** A local id; the answer streams from `agentId` after event `after`. */
  id: string
  agentId?: string
  after?: number
  question: string
  answer: string
  /** The answer as it streams. */
  draft: string
  /** `ended`: stopped before it answered (Stop, a closed tab, or an idle side chat that ended). */
  state: 'asking' | 'answered' | 'failed' | 'ended'
  /** The side chat had ended, so this question started a new branch without the earlier ones. */
  restarted?: boolean
  error?: string
}

type Chat = { key: string; title?: string; agentId?: string }

const newChat = (): Chat => ({ key: crypto.randomUUID() })

/**
 * Side chats beside the main chat, one tab each, like the old app's side chats.
 * Each runs in its own branch of the Director's session
 * (src/server/director/side-chat.ts) and keeps its own conversation. Answers
 * come from the same companion as the main chat, and nothing here is ever part
 * of the main chat. Tabs stay in this component only: a reload starts over.
 */
export function SideChat({ persona }: { persona: Persona }) {
  const [chats, setChats] = useState<Chat[]>(() => [newChat()])
  const [active, setActive] = useState(() => chats[0].key)
  const agents = useRef(new Map<string, string>())
  /** Tabs still open: an agent whose ask returns after its tab closed is ended, not kept. */
  const open = useRef(new Set(chats.map((chat) => chat.key)))

  const activeChat = chats.find((chat) => chat.key === active)
  const patch = (key: string, change: Partial<Chat>) =>
    setChats((list) => list.map((chat) => (chat.key === key ? { ...chat, ...change } : chat)))

  function add() {
    const chat = newChat()
    open.current.add(chat.key)
    setChats((list) => [...list, chat])
    setActive(chat.key)
  }

  function close(key: string) {
    const agentId = agents.current.get(key)
    agents.current.delete(key)
    open.current.delete(key)
    if (agentId) void closeSideChatAction(agentId).catch(() => {})
    const index = chats.findIndex((chat) => chat.key === key)
    const rest = chats.filter((chat) => chat.key !== key)
    // The last tab is never closed for good: the side chat always has a box to ask in.
    const next = rest.length > 0 ? rest : [newChat()]
    for (const chat of next) open.current.add(chat.key)
    setChats(next)
    if (key === active) setActive(next[Math.min(index, next.length - 1)].key)
  }

  return (
    <Tabs value={active} onValueChange={(value) => setActive(value as string)} className="flex h-full flex-col gap-0">
      <div className="flex items-center gap-1 overflow-x-auto p-2 pb-0">
        <TabsList aria-label="Side chats" variant="line" className="h-8">
          {chats.map((chat) => (
            <TabsTrigger key={chat.key} value={chat.key} className="max-w-36">
              <span className="truncate">{chat.title ?? 'New chat'}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        {/* One close button for the open tab: a tab list may hold only tabs. */}
        <Button variant="ghost" size="icon-xs" aria-label={`Close ${activeChat?.title ?? 'New chat'}`} onClick={() => close(active)}>
          <X />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="New side chat" onClick={add}>
          <Plus />
        </Button>
      </div>
      {chats.map((chat) => (
        // Kept mounted, so a hidden tab keeps its conversation and its draft.
        <TabsContent key={chat.key} value={chat.key} keepMounted className="min-h-0 flex-1 data-hidden:hidden">
          <SideChatThread
            persona={persona}
            onTitle={(title) => patch(chat.key, { title })}
            onAgent={(agentId) => {
              if (agentId && !open.current.has(chat.key)) {
                void closeSideChatAction(agentId).catch(() => {})
                return
              }
              if (agentId) agents.current.set(chat.key, agentId)
              else agents.current.delete(chat.key)
            }}
          />
        </TabsContent>
      ))}
    </Tabs>
  )
}

/** One side chat's conversation and its composer. */
function SideChatThread({
  persona,
  onTitle,
  onAgent,
}: {
  persona: Persona
  onTitle: (title: string) => void
  onAgent: (agentId: string | undefined) => void
}) {
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const current = exchanges.at(-1)
  const live = current?.state === 'asking' && current.agentId ? current : undefined
  /** This chat's side agent; questions after the first continue its conversation. */
  const agent = useRef<string | undefined>(undefined)
  const scroller = useRef<HTMLDivElement>(null)
  /** Questions stopped before their agent was known; the agent is ended when it arrives. */
  const stoppedEarly = useRef(new Set<string>())

  const update = (id: string, change: (exchange: Exchange) => Partial<Exchange>) =>
    setExchanges((list) => list.map((exchange) => (exchange.id === id ? { ...exchange, ...change(exchange) } : exchange)))

  /** Set when this chat's agent ended, so the next answer says the earlier questions are gone. */
  const contextLost = useRef(false)

  const forgetAgent = () => {
    if (agent.current) contextLost.current = true
    agent.current = undefined
    onAgent(undefined)
  }

  // Stream the answer being asked, from where this question started.
  const liveId = live?.id
  const liveAgent = live?.agentId
  const liveAfter = live?.after
  useEffect(() => {
    if (!liveId || !liveAgent) return
    // The stream replays this answer from its start, also after the screen was hidden and shown
    // again. The text already shown is replaced only when the replay brings text, so an answer the
    // server has since forgotten stays on screen.
    let replaying = true
    const source = new EventSource(`/api/side-chat/${liveAgent}/events?after=${liveAfter ?? 0}`)
    source.onmessage = (message) => {
      const { event } = JSON.parse(message.data) as AgentEventEnvelope
      const fresh = replaying && (event.type === 'text-delta' || event.type === 'text')
      if (fresh) replaying = false
      switch (event.type) {
        case 'text-delta':
          update(liveId, (exchange) => (fresh ? { answer: '', draft: event.text } : { draft: exchange.draft + event.text }))
          break
        case 'text':
          update(liveId, (exchange) => ({
            answer: exchange.answer && !fresh ? `${exchange.answer}\n\n${event.text}` : event.text,
            draft: '',
          }))
          break
        case 'turn-done':
          // A provider error is followed by turn-done; keep showing the error.
          update(liveId, (exchange) =>
            exchange.state === 'failed' ? {} : { state: 'answered', answer: exchange.answer || exchange.draft, draft: '' },
          )
          // The side agent stays for the next question; this answer is complete.
          source.close()
          break
        case 'error':
          update(liveId, () => ({ state: 'failed', error: event.message }))
          break
        case 'stopped':
          if (agent.current === liveAgent) forgetAgent()
          update(liveId, (exchange) => (exchange.state === 'asking' ? endedChange(exchange) : {}))
          break
      }
    }
    // The stream ends when the agent stops; without this EventSource reconnects forever.
    source.addEventListener('end', () => source.close())
    // The server no longer knows the agent, for example after a restart or long after an idle stop.
    // Text already shown is kept as the answer rather than replaced by "Stopped."
    source.addEventListener('missing', () => {
      source.close()
      if (agent.current === liveAgent) forgetAgent()
      update(liveId, (exchange) => {
        if (exchange.state !== 'asking') return {}
        const shown = exchange.answer || exchange.draft
        return shown ? { state: 'answered', answer: shown, draft: '' } : endedChange(exchange)
      })
    })
    return () => source.close()
  }, [liveId, liveAgent, liveAfter])

  useLayoutEffect(() => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [exchanges])

  async function ask(question: string) {
    // One answer at a time per side chat; the text goes back into the box.
    if (current?.state === 'asking') throw new Error('An answer is still coming.')
    const id = crypto.randomUUID()
    if (exchanges.length === 0) onTitle(question)
    setExchanges((list) => [...list, { id, question, answer: '', draft: '', state: 'asking' }])
    try {
      const result = await askSideQuestionAction(question, agent.current)
      if ('error' in result) {
        update(id, () => ({ state: 'failed', error: result.error }))
        return
      }
      if (stoppedEarly.current.delete(id)) {
        void closeSideChatAction(result.agentId).catch(() => {})
        return
      }
      // Stop and a forgotten agent drop the id before asking, so the server cannot tell; the chat can.
      const restarted = result.restarted || contextLost.current
      contextLost.current = false
      agent.current = result.agentId
      onAgent(result.agentId)
      update(id, () => ({ agentId: result.agentId, after: result.after, restarted }))
    } catch {
      update(id, () => ({ state: 'failed', error: 'The question could not be sent. Try again.' }))
    }
  }

  /** Stops the answer by ending this side chat's agent; the next question starts a new branch. */
  function stop() {
    const agentId = agent.current
    if (current?.state === 'asking' && !current.agentId) stoppedEarly.current.add(current.id)
    forgetAgent()
    setExchanges((list) => list.map((exchange) => (exchange.state === 'asking' ? { ...exchange, ...endedChange(exchange) } : exchange)))
    if (agentId) void closeSideChatAction(agentId).catch(() => {})
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <section role="log" aria-label="Side chat" className="flex flex-col gap-3 p-3">
          {exchanges.map((exchange) => (
            <ExchangeView key={exchange.id} exchange={exchange} persona={persona} />
          ))}
        </section>
      </div>
      <div className="p-3 pt-0">
        <ChatComposer
          projects={[]}
          label="Side question"
          placeholder={`Ask ${persona.companion?.name ?? 'BusyBoy'} a side question`}
          sendLabel="Ask"
          onSend={ask}
          onStop={current?.state === 'asking' ? stop : undefined}
        />
      </div>
    </div>
  )
}

function endedChange(exchange: Exchange): Partial<Exchange> {
  return { state: 'ended', answer: exchange.answer || exchange.draft, draft: '' }
}

function ExchangeView({ exchange, persona }: { exchange: Exchange; persona: Persona }) {
  const text = exchange.answer || exchange.draft
  return (
    <>
      {exchange.restarted && (
        <p role="note" className="text-muted-foreground text-center text-xs">
          This side chat had ended, so it started again without the questions above.
        </p>
      )}
      <Message align="end">
        <MessageContent>
          <Bubble role="group" aria-label="Your side question">
            <BubbleContent className="whitespace-pre-wrap">{exchange.question}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
      {text && (
        <DirectorMessage persona={persona}>
          <Bubble variant="muted" role="group" aria-label="Side answer" aria-busy={exchange.state === 'asking'}>
            <BubbleContent>
              <Markdown text={text} streaming={exchange.state === 'asking'} />
            </BubbleContent>
          </Bubble>
        </DirectorMessage>
      )}
      {exchange.state === 'asking' && !text && (
        <p role="status" className="text-muted-foreground animate-pulse text-xs">
          {persona.companion?.name ?? 'BusyBoy'} is thinking…
        </p>
      )}
      {exchange.state === 'ended' && (
        <p role="note" className="text-muted-foreground text-xs">
          Stopped.
        </p>
      )}
      {exchange.error && (
        <p role="note" className="text-destructive text-xs">
          {exchange.error}
        </p>
      )}
    </>
  )
}
