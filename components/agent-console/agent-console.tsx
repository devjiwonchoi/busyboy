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
import { Button } from '@/components/ui/button'
import type { AgentAnswer, AgentEventEnvelope, AgentStatus, Question } from '@/server/runner/contract'

// A bare transcript and message box that proves the agent runner end to end.
// The master chat todo replaces it with the real chat (bubbles, cards, @ picker).

type Entry =
  | { kind: 'user' | 'assistant' | 'tool' | 'error'; text: string; streaming?: boolean }
  | { kind: 'approval'; requestId: string; title: string; detail?: string; answered: boolean }
  | { kind: 'question'; requestId: string; questions: Question[]; answered: boolean }

type View = { entries: Entry[]; status: AgentStatus; finished?: boolean; lastSeq: number }

const initialView: View = { entries: [], status: 'starting', lastSeq: 0 }

function apply(view: View, { seq, event }: AgentEventEnvelope): View {
  if (seq <= view.lastSeq) return view
  const entries = [...view.entries]
  const last = entries.at(-1)
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
      if (last?.kind === 'assistant' && last.streaming) entries[entries.length - 1] = { ...last, text: last.text + event.text }
      else entries.push({ kind: 'assistant', text: event.text, streaming: true })
      break
    case 'text':
      if (last?.kind === 'assistant' && last.streaming) entries[entries.length - 1] = { kind: 'assistant', text: event.text }
      else entries.push({ kind: 'assistant', text: event.text })
      break
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

export function AgentConsole() {
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
      // `?provider=codex` picks Codex until the master chat chooses providers itself.
      const provider = new URLSearchParams(window.location.search).get('provider') === 'codex' ? 'codex' : 'claude'
      setAgentId((await startAgentAction(text, provider)).id)
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
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto text-sm"
      >
        {view.entries.length === 0 && !agentId && (
          <p className="text-muted-foreground mt-auto">Busyboy is ready. Send a message to start an agent.</p>
        )}
        {view.entries.map((entry, index) => (
          <EntryView key={index} entry={entry} onAnswer={answer} />
        ))}
        {view.status === 'stopped' && (
          <p role="status" className="text-muted-foreground">
            {view.finished ? 'Agent stopped.' : 'Agent stopped before finishing.'}
          </p>
        )}
        <div ref={bottom} />
      </section>
      <form onSubmit={send} className="flex items-end gap-2">
        <textarea
          aria-label="Message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
          rows={2}
          className="bg-background min-h-10 flex-1 resize-none rounded-md border px-3 py-2 text-sm"
        />
        <Button type="submit">Send</Button>
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
      return <p className="bg-muted self-end rounded-md px-3 py-2 whitespace-pre-wrap">{entry.text}</p>
    case 'assistant':
      return <p className="whitespace-pre-wrap">{entry.text}</p>
    case 'tool':
      return <p className="text-muted-foreground font-mono text-xs">{entry.text}</p>
    case 'error':
      return (
        <p role="alert" className="text-destructive">
          {entry.text}
        </p>
      )
    case 'approval':
      return (
        <div role="group" aria-label="Approval request" className="rounded-md border p-3">
          <p>{entry.title}</p>
          {entry.detail && <p className="text-muted-foreground">{entry.detail}</p>}
          {!entry.answered && (
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => onAnswer(entry.requestId, { kind: 'approval', allow: true })}>
                Allow
              </Button>
              <Button size="sm" variant="outline" onClick={() => onAnswer(entry.requestId, { kind: 'approval', allow: false })}>
                Deny
              </Button>
            </div>
          )}
        </div>
      )
    case 'question':
      return (
        <div role="group" aria-label="Question" className="rounded-md border p-3">
          {entry.questions.map((question) => (
            <div key={question.question}>
              <p>{question.question}</p>
              {!entry.answered && (
                <div className="mt-2 flex gap-2">
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
            </div>
          ))}
        </div>
      )
  }
}
