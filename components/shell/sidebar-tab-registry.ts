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

type RequireContext = {
  keys(): string[]
  (id: string): TabModule
}

declare const require: {
  context(directory: string, useSubdirectories: boolean, pattern: RegExp): RequireContext
}

const tabModules = require.context('../sidebar', false, /-tab\.tsx$/)

export function getSidebarTabs(): SidebarTab[] {
  return tabModules
    .keys()
    .map((key) => {
      const mod = tabModules(key)
      return { ...mod.tab, Component: mod.default }
    })
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
}
