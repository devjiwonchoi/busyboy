import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";

import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentScope } from "~/state/session";
import { isProviderSettingsEnvironmentAvailable } from "./ProviderSettingsPanel.logic";
import { filterAvailableSettingsSearchItems } from "./settingsSearch";

export function useAvailableSettingsSearchItems() {
  const { environments } = useEnvironments();
  // The filtered list must be cached on boolean flags so it stays stable for the search and
  // the command palette while environments update. The compiler cannot tell that `.some()`
  // and other plain calls return primitives, so `=== true` marks each flag as one; without
  // it the flags join the filter's cache scope and the list is rebuilt every render.
  const hasEnvironment =
    environments.some((environment) => environment.serverConfig !== null) === true;
  const hasProviderSettingsEnvironment =
    environments.some((environment) =>
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: environment.connection.phase,
        hasServerConfig: environment.serverConfig !== null,
      }),
    ) === true;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canMaintain = useEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope);

  const localEnvironmentDisabled = isLocalEnvironmentDisabled() === true;
  const canManageLocalBackend = !localEnvironmentDisabled && canMaintain;
  return filterAvailableSettingsSearchItems({
    localEnvironmentDisabled,
    hasEnvironment,
    hasProviderSettingsEnvironment,
    canManageLocalBackend,
    managedTunnelActive: false,
  });
}
