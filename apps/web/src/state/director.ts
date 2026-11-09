import type { EnvironmentId } from "@t3tools/contracts";

import { directorInbox } from "~/components/director/directorInbox.logic";
import { useEnvironmentIds } from "./environments";
import { type ProjectManagerEntry, useProjectManagerEntries } from "./projectTeam";
import { directorProjectKeys, splitDirectorEntry } from "./projectTeam.logic";

/** Every project's PM without the workspace Director. */
export function useProjectOnlyManagerEntries(
  environmentIds: readonly EnvironmentId[],
): readonly ProjectManagerEntry[] {
  return splitDirectorEntry(useProjectManagerEntries(environmentIds)).projects;
}

/** The workspace Director, or null before the server has made one. */
export function useDirector(environmentIds: readonly EnvironmentId[]): ProjectManagerEntry | null {
  return splitDirectorEntry(useProjectManagerEntries(environmentIds)).director;
}

/** "environmentId:projectId" of the Director's hidden system project(s). */
export function useDirectorProjectKeys(
  environmentIds: readonly EnvironmentId[],
): ReadonlySet<string> {
  return directorProjectKeys(useProjectManagerEntries(environmentIds));
}

/** Open attention across every project and the workspace Director. */
export function useDirectorInbox() {
  return directorInbox(useProjectManagerEntries(useEnvironmentIds()));
}
