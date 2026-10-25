import {
  makeSourceControlClientRegistry,
  readSourceControlHostSettings,
} from "@t3tools/source-control-core/client/definition";
import type { ServerSettings } from "@t3tools/contracts";

export {
  UNKNOWN_SOURCE_CONTROL_CLIENT,
  type ChangeRequestTerminology,
  type SourceControlClientDefinition,
} from "@t3tools/source-control-core/client/definition";
import * as GitHub from "@t3tools/source-control-github/client/definition";

const BUILT_IN_SOURCE_CONTROL_CLIENTS = [GitHub.definition];

export const sourceControlClients = makeSourceControlClientRegistry(
  BUILT_IN_SOURCE_CONTROL_CLIENTS,
);

export type { GitHubSettings } from "@t3tools/source-control-github/client/definition";

export function readGitHubSettings(settings: Pick<ServerSettings, "sourceControlHosts">) {
  return readSourceControlHostSettings(GitHub.settings, settings.sourceControlHosts.github);
}
