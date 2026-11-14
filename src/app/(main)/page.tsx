import { Streamdown } from 'streamdown'
import { AgentConsole } from '@/components/agent-console/agent-console'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent } from '@/components/ui/message'

const welcome = `**BusyBoy** is ready.

Message the Director to start work across your projects.`

// Chat area slot. A bare agent console until the Director chat replaces it.
export default function ChatPage() {
  return (
    <AgentConsole
      welcome={
        <Message>
          <MessageContent>
            <Bubble variant="muted">
              <BubbleContent>
                <Streamdown>{welcome}</Streamdown>
              </BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      }
    />
  )
}
