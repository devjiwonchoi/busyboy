'use client'

import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export type RenderedSidebarTab = { id: string; title: string; content: React.ReactNode }

export function SidebarTabs({ tabs }: { tabs: RenderedSidebarTab[] }) {
  if (tabs.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Nothing here yet.</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <Tabs defaultValue={tabs[0].id} className="h-full min-h-0 gap-0">
      <TabsList variant="line" className="h-10 w-full justify-start border-b px-2">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id} className="flex-none">
            {tab.title}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        // keepMounted: inactive tabs keep their state (streams, subscriptions) when switching.
        <TabsContent key={tab.id} value={tab.id} keepMounted className="min-h-0 flex-1 overflow-auto">
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  )
}
