// why: The settings sections, in order. The open section lives in the URL (`?section=`), so a
// why: reload or the Back button lands on the same one without client state.

export const SECTIONS = [
  { id: "appearance", title: "Appearance" },
  { id: "agents", title: "Agents" },
  { id: "connectors", title: "Connectors" },
  { id: "projects", title: "Projects" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

export function parseSection(value: unknown): SectionId {
  return SECTIONS.find(({ id }) => id === value)?.id ?? "appearance";
}

export function sectionHref(id: SectionId) {
  return id === "appearance" ? "/settings" : `/settings?section=${id}`;
}
