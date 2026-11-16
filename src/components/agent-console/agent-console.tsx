'use client'

import { useEffect, useRef, useState } from 'react'
import {
  answerAgentAction,
  interruptAgentAction,
  resumeAgentAction,
  sendMessageAction,
  startAgentAction,
  stopAgentAction,
} from '@/app/(main)/agent-actions'
import { Streamdown } from 'streamdown'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Message, MessageContent } from '@/components/ui/message'
import { Textarea } from '@/components/ui/textarea'
import type { AgentAnswer, AgentEventEnvelope, AgentStatus, Question } from '@/server/runner/contract'

// A bare transcript and message box that proves the agent runner end to end.
// The Director chat replaces it with the real chat (@ picker, task cards).

type Entry =
  | { kind: 'user' | 'tool' | 'error'; text: string }
  | { kind: 'assistant'; itemId: string; text: string }
  | { kind: 'approval'; requestId: string; title: string; detail?: string; canAllowForSession: boolean; answered: boolean }
  | { kind: 'question'; requestId: string; questions: Question[]; answered: boolean }

type View = { entries: Entry[]; status: AgentStatus; finished?: boolean; lastSeq: number }

const initialView: View = { entries: [], status: 'starting', lastSeq: 0 }

function apply(view: View, { seq, event }: AgentEventEnvelope): View {
  if (seq <= view.lastSeq) return view
  const entries = [...view.entries]
  let { status, finished } = view
  switch (event.type) {
    case 'started':
      status = 'idle'
      finished = undefined
      break
    case 'user-message':
      entries.push({ kind: 'user', text: event.text })
      status = 'running'
      break
    case 'text-delta':
    case 'text': {
      const index = entries.findLastIndex((entry) => entry.kind === 'assistant' && entry.itemId === event.itemId)
      const previous = index === -1 ? '' : (entries[index] as Extract<Entry, { kind: 'assistant' }>).text
      const entry: Entry = {
        kind: 'assistant',
        itemId: event.itemId,
        text: event.type === 'text' ? event.text : previous + event.text,
      }
      if (index === -1) entries.push(entry)
      else entries[index] = entry
      break
    }
    case 'tool':
      entries.push({ kind: 'tool', text: event.label })
      break
    case 'error':
      entries.push({ kind: 'error', text: event.message })
      break
    case 'approval':
      entries.push({ kind: 'approval', ...event, answered: false })
      status = 'waiting'
      break
    case 'question':
      entries.push({ kind: 'question', ...event, answered: false })
      status = 'waiting'
      break
    case 'answered':
      for (const [index, entry] of entries.entries()) {
        if ((entry.kind === 'approval' || entry.kind === 'question') && entry.requestId === event.requestId) {
          entries[index] = { ...entry, answered: true }
        }
      }
      if (status === 'waiting') status = 'running'
      break
    case 'turn-done':
      status = 'idle'
      break
    case 'stopped':
      status = 'stopped'
      finished = event.finished
      break
  }
  return { entries, status, finished, lastSeq: seq }
}

export function AgentConsole({ welcome }: { welcome: React.ReactNode }) {
  const [agentId, setAgentId] = useState<string>()
  const [view, setView] = useState(initialView)
  const [streamOpen, setStreamOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [connection, setConnection] = useState(0)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!agentId) return
    const source = new EventSource(`/api/agents/${agentId}/events`)
    setStreamOpen(true)
    source.onmessage = (message) => setView((current) => apply(current, JSON.parse(message.data)))
    const end = () => {
      source.close()
      setStreamOpen(false)
    }
    source.addEventListener('end', end)
    source.addEventListener('missing', end)
    return () => source.close()
  }, [agentId, connection])

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [view.entries.length])

  async function send(event: React.FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft('')
    if (agentId && view.status !== 'stopped') await sendMessageAction(agentId, text)
    else {
      setView(initialView)
      setAgentId((await startAgentAction(text)).id)
    }
  }

  async function resume() {
    if (!agentId) return
    await resumeAgentAction(agentId)
    setConnection((count) => count + 1)
  }

  const answer = (requestId: string, value: AgentAnswer) => agentId && answerAgentAction(agentId, requestId, value)
  const active = Boolean(agentId) && view.status !== 'stopped'

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-3 p-6">
      <section
        aria-label="Transcript"
        role="log"
        data-stream={streamOpen ? 'open' : 'closed'}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto"
      >
        {view.entries.length === 0 && !agentId && <div className="mt-auto">{welcome}</div>}
        {view.entries.map((entry, index) => (
          <EntryView key={index} entry={entry} onAnswer={answer} />
        ))}
        {view.status === 'stopped' && (
          <p role="status" className="text-muted-foreground text-xs">
            {view.finished ? 'Agent stopped.' : 'Agent stopped before finishing.'}
          </p>
        )}
        <div ref={bottom} />
      </section>
      <form onSubmit={send} className="flex flex-col gap-2">
        <Textarea
          aria-label="Message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter that ends an IME composition (Korean, Japanese) must not send.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          rows={2}
          className="max-h-48 overflow-y-auto"
        />
        <div className="flex justify-end gap-2">
          {active && (
            <>
              <Button type="button" variant="outline" onClick={() => agentId && interruptAgentAction(agentId)}>
                Interrupt
              </Button>
              <Button type="button" variant="outline" onClick={() => agentId && stopAgentAction(agentId)}>
                Stop
              </Button>
            </>
          )}
          {agentId && view.status === 'stopped' && (
            <Button type="button" variant="outline" onClick={resume}>
              Resume
            </Button>
          )}
          <Button type="submit">Send</Button>
        </div>
      </form>
    </div>
  )
}

function EntryView({
  entry,
  onAnswer,
}: {
  entry: Entry
  onAnswer: (requestId: string, answer: AgentAnswer) => void
}) {
  switch (entry.kind) {
    case 'user':
      return (
        <Message align="end">
          <MessageContent>
            <Bubble align="end">
              <BubbleContent className="whitespace-pre-wrap">{entry.text}</BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      )
    case 'assistant':
      return (
        <Message>
          <MessageContent>
            <Bubble variant="ghost">
              <BubbleContent>
                <Streamdown>{entry.text}</Streamdown>
              </BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      )
    case 'tool':
      return (
        <Message>
          <MessageContent>
            <Bubble variant="outline">
              <BubbleContent className="font-mono">{entry.text}</BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      )
    case 'error':
      return (
        <Alert variant="destructive">
          <AlertDescription>{entry.text}</AlertDescription>
        </Alert>
      )
    case 'approval':
      return (
        <Card role="group" aria-label="Approval request" size="sm">
          <CardHeader>
            <CardTitle className="wrap-break-word">{entry.title}</CardTitle>
            {entry.detail && <CardDescription className="wrap-break-word">{entry.detail}</CardDescription>}
          </CardHeader>
          {!entry.answered && (
            <CardFooter className="gap-2">
              <Button size="sm" onClick={() => onAnswer(entry.requestId, { kind: 'approval', allow: true })}>
                Allow
              </Button>
              {entry.canAllowForSession && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onAnswer(entry.requestId, { kind: 'approval', allow: true, forSession: true })}
                >
                  Allow for this session
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => onAnswer(entry.requestId, { kind: 'approval', allow: false })}>
                Deny
              </Button>
            </CardFooter>
          )}
        </Card>
      )
    case 'question':
      return (
        <Card role="group" aria-label="Question" size="sm">
          {entry.questions.map((question) => (
            <CardContent key={question.question} className="flex flex-col gap-2">
              <CardTitle className="wrap-break-word">{question.question}</CardTitle>
              {!entry.answered && (
                <div className="flex flex-wrap gap-2">
                  {question.options.map((option) => (
                    <Button
                      key={option.label}
                      size="sm"
                      variant="outline"
                      title={option.description}
                      onClick={() =>
                        onAnswer(entry.requestId, { kind: 'question', answers: { [question.question]: option.label } })
                      }
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
              )}
            </CardContent>
          ))}
        </Card>
      )
  }
}
