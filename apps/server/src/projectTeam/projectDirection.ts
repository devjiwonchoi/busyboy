/** The PM memory topic that holds a project's direction. */
export const PROJECT_DIRECTION_TOPIC = "direction";

/**
 * The line All projects shows as a project's direction: the first line of the PM's
 * "direction" memory that says something. Blank lines and headings that end with ":"
 * (such as "Product direction (user, 2026-11-07):") are skipped, and leading markdown
 * markers are stripped. Null when nothing is left.
 */
export function projectDirectionLine(content: string): string | null {
  for (const raw of content.split("\n")) {
    const line = raw.replace(/^[\s#>*-]+/, "").trim();
    if (line.length === 0 || line.endsWith(":")) continue;
    return line;
  }
  return null;
}
