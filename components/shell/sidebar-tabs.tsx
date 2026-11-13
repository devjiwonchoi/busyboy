'use client'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export type RenderedSidebarTab = { id: string; title: string; content: React.ReactNode }

export function SidebarTabs({ tabs }: { tabs: RenderedSidebarTab[] }) {
  if (tabs.length === 0) {
    return <div className="text-muted-foreground p-4 text-sm">Nothing here yet.</div>
  }
  return (
    <Tabs defaultValue={tabs[0].id} className="flex h-full min-h-0 flex-col gap-0">
      <TabsList variant="line" className="h-10 w-full justify-start border-b px-2">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id} className="flex-none">
            {tab.title}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        // Keep inactive tabs mounted so their state (streams, subscriptions) survives switching.
        <TabsContent
          key={tab.id}
          value={tab.id}
          forceMount
          className="min-h-0 flex-1 overflow-auto data-[state=inactive]:hidden"
        >
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  )
}
