// The settings sections, in order. The open section lives in the URL (`?section=`), so a
// reload or the Back button lands on the same one without client state.

export const SECTIONS = [
  { id: 'companion', title: 'Companion' },
  { id: 'agents', title: 'Agents' },
  { id: 'connectors', title: 'Connectors' },
  { id: 'approvals', title: 'Approvals' },
  { id: 'projects', title: 'Projects' },
] as const

export type SectionId = (typeof SECTIONS)[number]['id']

export function parseSection(value: unknown): SectionId {
  return SECTIONS.find(({ id }) => id === value)?.id ?? 'companion'
}

export function sectionHref(id: SectionId) {
  return id === 'companion' ? '/settings' : `/settings?section=${id}`
}
