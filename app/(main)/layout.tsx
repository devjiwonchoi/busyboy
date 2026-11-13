import { AppShell } from '@/components/shell/app-shell'
import { RightSidebar } from '@/components/shell/right-sidebar'

// The main screen. Slots: `children` is the chat area, `panel` is the bottom
// panel (app/(main)/@panel), and the right sidebar renders every tab found
// by components/shell/sidebar-tab-registry.ts.
export default function MainLayout({
  children,
  panel,
}: {
  children: React.ReactNode
  panel: React.ReactNode
}) {
  return (
    <AppShell sidebar={<RightSidebar />} panel={panel}>
      {children}
    </AppShell>
  )
}
