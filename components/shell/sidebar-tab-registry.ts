import type { ComponentType } from 'react'

/**
 * Right sidebar tab registry.
 *
 * Every `components/sidebar/<name>-tab.tsx` file is a tab; add a file to add a tab.
 * The file must be a server module (no 'use client' at the top, so its `tab`
 * export stays plain data) with:
 *   export const tab: SidebarTabMeta = { id: 'projects', title: 'Projects', order: 10 }
 *   export default function ProjectsTab() { ... }  // may render client components
 */
export type SidebarTabMeta = {
  id: string
  title: string
  /** Lower comes first. */
  order: number
}

export type SidebarTab = SidebarTabMeta & { Component: ComponentType }

type TabModule = { tab: SidebarTabMeta; default: ComponentType }

// Turbopack's import.meta.glob: keys are sorted the same way in dev and production.
const tabModules = import.meta.glob<TabModule>('../sidebar/*-tab.tsx', { eager: true })

export function getSidebarTabs(): SidebarTab[] {
  return Object.values(tabModules)
    .map((mod) => ({ ...mod.tab, Component: mod.default }))
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
}
