import type { SidebarTabMeta } from '@/components/shell/sidebar-tab-registry'
import { WeekList } from './week-list'

export const tab: SidebarTabMeta = { id: 'week', title: 'Week', order: 15 }

export default function WeekTab() {
  return <WeekList />
}
