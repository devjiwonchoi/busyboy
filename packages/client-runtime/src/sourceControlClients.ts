import {
  makeSourceControlClientRegistry,
  readSourceControlHostSettings,
} from "@busyboy/source-control-core/client/definition";
import type { ServerSettings } from "@busyboy/contracts";

export {
  UNKNOWN_SOURCE_CONTROL_CLIENT,
  type ChangeRequestTerminology,
  type SourceControlClientDefinition,
} from "@busyboy/source-control-core/client/definition";
import * as GitHub from "@busyboy/source-control-github/client/definition";

const BUILT_IN_SOURCE_CONTROL_CLIENTS = [GitHub.definition];

export const sourceControlClients = makeSourceControlClientRegistry(
  BUILT_IN_SOURCE_CONTROL_CLIENTS,
);

export type { GitHubSettings } from "@busyboy/source-control-github/client/definition";

export function readGitHubSettings(settings: Pick<ServerSettings, "sourceControlHosts">) {
  return readSourceControlHostSettings(GitHub.settings, settings.sourceControlHosts.github);
}
