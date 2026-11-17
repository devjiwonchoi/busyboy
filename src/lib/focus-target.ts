export type FocusTarget = { kind: "task"; project: string; taskId: string } | { kind: "director" };

export const FOCUS_PARAM = "focus";

export function formatFocusTarget(target: FocusTarget) {
  return target.kind === "director" ? "director" : `task:${target.project}/${target.taskId}`;
}

export function parseFocusTarget(value: string | null | undefined): FocusTarget | null {
  if (!value) return null;
  if (value === "director") return { kind: "director" };
  // Task ids never contain a slash (a slug plus hex); project names might, so split at the last one.
  const match = /^task:(.+)\/([^/]+)$/.exec(value);
  return match ? { kind: "task", project: match[1], taskId: match[2] } : null;
}
