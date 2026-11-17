import { AppShell } from '@/components/shell/app-shell'
import { ChatSidebarSlot } from '@/components/shell/chat-sidebar-slot'

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
