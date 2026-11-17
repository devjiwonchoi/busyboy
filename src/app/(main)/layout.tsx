import { AppShell } from '@/components/shell/app-shell'
import { ChatSidebarSlot } from '@/components/shell/chat-sidebar-slot'

// The main screen. Slots: the chat list on the left, `children` is the chat area, and `panel` is the bottom
// panel (src/app/(main)/@panel).
export default function MainLayout({
  children,
  panel,
}: {
  children: React.ReactNode
  panel: React.ReactNode
}) {
  return (
    <AppShell chats={<ChatSidebarSlot />} panel={panel}>
      {children}
    </AppShell>
  )
}
