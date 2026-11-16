import { AppShell } from '@/components/shell/app-shell'
import { ChatSidebarSlot } from '@/components/shell/chat-sidebar-slot'
import { RightSidebar } from '@/components/shell/right-sidebar'

// The main screen. Slots: the chat list on the left, `children` is the chat area, `panel` is the bottom
// panel (src/app/(main)/@panel), and the right sidebar renders every tab found
// by src/components/shell/sidebar-tab-registry.ts.
export default function MainLayout({
  children,
  panel,
}: {
  children: React.ReactNode
  panel: React.ReactNode
}) {
  return (
    <AppShell chats={<ChatSidebarSlot />} sidebar={<RightSidebar />} panel={panel}>
      {children}
    </AppShell>
  )
}
