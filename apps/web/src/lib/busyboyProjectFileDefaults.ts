import { BUSYBOY_PROJECT_FILE_NAME, type EnvironmentId, type BusyboyProjectFile } from "@busyboy/contracts";
import { parseBusyboyProjectFile } from "@busyboy/shared/busyboyProjectFile";
import { executeAtomQuery } from "@busyboy/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export async function readBusyboyProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<BusyboyProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, BUSYBOY_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    BUSYBOY_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.truncated) return null;
  return parseBusyboyProjectFile(data.contents);
}
