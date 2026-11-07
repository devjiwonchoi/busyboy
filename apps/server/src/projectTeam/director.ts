/** The workspace Director: its hidden system project and the epics it keeps there. */

import type { ProjectTaskStage } from "@t3tools/contracts";
import type * as Path from "effect/Path";

/** The Director's hidden system project lives here, next to the app's data. */
export const directorWorkspaceRoot = (path: Path.Path, baseDir: string): string =>
  path.resolve(baseDir, "director");

/**
 * An epic has no lead: its stage follows its subtasks. All finished → done (cancelled
 * when none was done); any blocked → blocked; any started or done → running; else inbox.
 */
export function epicStage(children: ReadonlyArray<ProjectTaskStage>): ProjectTaskStage {
  if (children.length === 0) return "inbox";
  const finished = (stage: ProjectTaskStage) => stage === "done" || stage === "cancelled";
  if (children.every(finished)) {
    return children.some((stage) => stage === "done") ? "done" : "cancelled";
  }
  if (children.includes("blocked")) return "blocked";
  if (children.some((stage) => stage !== "inbox" && stage !== "cancelled")) return "running";
  return "inbox";
}
