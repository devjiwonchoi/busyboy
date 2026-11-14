import type { SidebarTabMeta } from '@/components/shell/sidebar-tab-registry'
import { MemoryList } from './memory-list'

// A sidebar tab rather than a settings page: memory changes while the user
// chats ("remember X"), so it sits next to the chat where the new fact shows
// up at once, and the tab registry lets it be added without touching shared files.
export const tab: SidebarTabMeta = { id: 'memory', title: 'Memory', order: 40 }

export default function MemoryTab() {
  return <MemoryList />
}
