import { Streamdown } from 'streamdown'

const welcome = `**Busyboy** is ready.

Message the master agent to start work across your projects.`

// Chat area slot. The master chat replaces this placeholder.
export default function ChatPage() {
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col justify-end p-6">
      <div className="text-muted-foreground rounded-xl border bg-card p-4 text-sm">
        <Streamdown>{welcome}</Streamdown>
      </div>
    </div>
  )
}
