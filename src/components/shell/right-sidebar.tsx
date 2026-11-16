import { getSidebarTabs } from './sidebar-tab-registry'
import { SidebarTabs } from './sidebar-tabs'

export function RightSidebar() {
  const tabs = getSidebarTabs().map(({ id, title, Component }) => ({
    id,
    title,
    content: <Component />,
  }))
  return <SidebarTabs tabs={tabs} />
}
