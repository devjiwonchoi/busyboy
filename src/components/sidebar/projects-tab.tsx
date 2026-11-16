import type { SidebarTabMeta } from '@/components/shell/sidebar-tab-registry'
import { ProjectGraph } from './project-graph'

export const tab: SidebarTabMeta = { id: 'projects', title: 'Projects', order: 10 }

export default function ProjectsTab() {
  return <ProjectGraph />
}
