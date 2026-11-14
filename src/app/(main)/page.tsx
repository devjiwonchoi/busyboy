import { connection } from 'next/server'
import { Suspense } from 'react'
import { AgentConsole } from '@/components/agent-console/agent-console'
import { CompanionAvatar } from '@/components/companion/companion-avatar'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageAvatar, MessageContent, MessageHeader } from '@/components/ui/message'
import { companionImageUrl, currentCompanion } from '@/server/companions'

// Chat area slot. A bare agent console until the Director chat replaces it.
export default function ChatPage() {
  return (
    <AgentConsole
      welcome={
        <Suspense>
          <Welcome />
        </Suspense>
      }
    />
  )
}

/** The companion chosen in setup says hello in its own voice. */
async function Welcome() {
  await connection()
  const [companion, imageUrl] = await Promise.all([currentCompanion(), companionImageUrl()])
  return (
    <Message>
      {companion && (
        <MessageAvatar>
          <CompanionAvatar companion={companion} imageUrl={imageUrl} className="size-8 text-base" />
        </MessageAvatar>
      )}
      <MessageContent>
        {companion && <MessageHeader>{companion.name}, your director</MessageHeader>}
        <Bubble variant="muted">
          <BubbleContent>{companion?.greeting ?? 'BusyBoy is ready. What should we work on?'}</BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}
