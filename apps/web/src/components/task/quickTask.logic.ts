const MAX_DERIVED_TITLE_LENGTH = 80;

/**
 * A title from the first line of what the user dumped, like Linear does when the
 * title is left empty. Markdown heading and list markers are dropped; long lines
 * are cut at a word boundary.
 */
export function deriveTaskTitle(context: string): string {
  const firstLine =
    context
      .split("\n")
      .map((line) =>
        line
          .trim()
          .replace(/^(#{1,6}|[-*+]|\d+[.)])\s+/, "")
          .trim(),
      )
      .find((line) => line.length > 0) ?? "";
  if (firstLine.length <= MAX_DERIVED_TITLE_LENGTH) return firstLine;
  const cut = firstLine.slice(0, MAX_DERIVED_TITLE_LENGTH - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > MAX_DERIVED_TITLE_LENGTH / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function quickTaskProjectKey(project: {
  readonly environmentId: string;
  readonly projectId: string;
}): string {
  return `${project.environmentId}:${project.projectId}`;
}
