import { Streamdown } from 'streamdown'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent } from '@/components/ui/message'

const welcome = `**BusyBoy** is ready.

Message the master agent to start work across your projects.`

// Chat area slot. The master chat replaces this placeholder.
export default function ChatPage() {
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col justify-end p-6">
      <Message>
        <MessageContent>
          <Bubble variant="muted">
            <BubbleContent>
              <Streamdown>{welcome}</Streamdown>
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    </div>
  )
}
