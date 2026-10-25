import {
  BUSYBOY_PROJECT_FILE_NAME,
  type EnvironmentId,
  type BusyboyProjectFile,
  type BusyboyProjectFileScript,
} from "@busyboy/contracts";
import { parseBusyboyProjectFile } from "@busyboy/shared/busyboyProjectFile";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<BusyboyProjectFileScript> = [];

export interface BusyboyProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  file: BusyboyProjectFile | null;
  scripts: ReadonlyArray<BusyboyProjectFileScript>;
}

export function useBusyboyProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): BusyboyProjectFileState {
  const query = useProjectFileQuery(environmentId, cwd ?? "", BUSYBOY_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  if (contents === null) {
    return {
      status: isPending ? "loading" : "missing",
      file: null,
      scripts: NO_SCRIPTS,
    } as const;
  }
  const file = parseBusyboyProjectFile(contents);
  if (file === null) {
    return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
  }
  return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
}

export function useBusyboyProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<BusyboyProjectFileScript> {
  return useBusyboyProjectFileState(environmentId, cwd).scripts;
}
