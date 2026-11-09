import type { EnvironmentId } from "@t3tools/contracts";

import { directorInbox } from "~/components/director/directorInbox.logic";
import { useEnvironmentIds } from "./environments";
import { type ProjectManagerEntry, useProjectManagerEntries } from "./projectTeam";
import { splitDirectorEntry } from "./projectTeam.logic";

/** The workspace Director, or null before the server has made one. */
export function useDirector(environmentIds: readonly EnvironmentId[]): ProjectManagerEntry | null {
  return splitDirectorEntry(useProjectManagerEntries(environmentIds)).director;
}

/** Open attention across every project and the workspace Director. */
export function useDirectorInbox() {
  return directorInbox(useProjectManagerEntries(useEnvironmentIds()));
}
