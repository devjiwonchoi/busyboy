import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { directorInbox } from "~/components/director/directorInbox.logic";
import { useEnvironmentIds } from "./environments";
import { type ProjectManagerEntry, useProjectManagerEntries } from "./projectTeam";
import { splitDirectorEntry } from "./projectTeam.logic";

/** The workspace Director, or null before the server has made one. */
export function useDirector(environmentIds: readonly EnvironmentId[]): ProjectManagerEntry | null {
  return splitDirectorEntry(useProjectManagerEntries(environmentIds)).director;
}

/** Resolve the Director without subscribing to its chat shell or navigation. */
export function useDirectorThreadRef(): ScopedThreadRef | null {
  const director = useDirector(useEnvironmentIds());
  return director === null
    ? null
    : scopeThreadRef(director.environmentId, director.summary.pmThreadId);
}

/** Open attention across every project and the workspace Director. */
export function useDirectorInbox() {
  return directorInbox(useProjectManagerEntries(useEnvironmentIds()));
}
