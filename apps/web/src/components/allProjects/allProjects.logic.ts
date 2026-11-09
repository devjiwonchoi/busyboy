import type { EnvironmentId, ProjectTeamAttentionSummary } from "@t3tools/contracts";

/** One manager (PM or Director) and its project summary, as All projects reads it. */
export interface MapEntry {
  readonly environmentId: EnvironmentId;
  readonly summary: ProjectTeamAttentionSummary;
}

/** Project IDs are unique per environment, so nodes are keyed by both. */
export function projectKey(environmentId: EnvironmentId, projectId: string): string {
  // Printable, so it can sit in a data attribute and a CSS selector.
  return `${environmentId}/${projectId}`;
}
