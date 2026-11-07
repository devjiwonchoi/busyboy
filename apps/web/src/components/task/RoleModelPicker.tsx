import type {
  EnvironmentId,
  ProjectId,
  ProjectTaskModelTarget,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import type { ComposerControlSize } from "../chat/ComposerControl";
import { getTriggerDisplayModelName, type ModelEsque } from "../chat/providerIconUtils";
import { Button } from "../ui/button";

/** An environment's provider instances and their models, as the model picker lists them. */
export interface RoleModelCatalog {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptions: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
}

export function useRoleModelCatalog(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): RoleModelCatalog {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  return {
    entries: sortProviderInstanceEntries(
      applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, projectId),
    ),
    modelOptions: getCustomModelOptionsByInstance(settings, providers),
  };
}

/**
 * "GPT-5.5": the catalog's name for the model, else its slug. The provider's name leads only
 * when it has more than one instance of that kind, or when no model was reported.
 */
export function roleModelLabel(
  target: { readonly providerInstanceId: ProviderInstanceId; readonly model: string | null },
  catalog: RoleModelCatalog,
): string {
  const entry = catalog.entries.find(
    (candidate) => candidate.instanceId === target.providerInstanceId,
  );
  const provider = entry?.displayName ?? target.providerInstanceId;
  if (target.model === null) return provider;
  const option = catalog.modelOptions
    .get(target.providerInstanceId)
    ?.find((candidate) => candidate.slug === target.model);
  const name = option ? getTriggerDisplayModelName(option) : target.model;
  const ambiguous =
    entry !== undefined &&
    catalog.entries.filter((candidate) => candidate.driverKind === entry.driverKind).length > 1;
  return ambiguous ? `${provider} / ${name}` : name;
}

/** Turns a provider instance and model into its display label for one environment. */
export function useRoleModelLabel(environmentId: EnvironmentId) {
  const catalog = useRoleModelCatalog(environmentId, null);
  return (target: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly model: string | null;
  }) => roleModelLabel(target, catalog);
}

/**
 * The model for one role (plan, implement, review or fix). Unset shows `unsetLabel`, the model
 * the role falls back to; a set role has a clear button that sends null.
 */
export function RoleModelPicker(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  value: ProjectTaskModelTarget | null;
  unsetLabel: string;
  ariaLabel: string;
  clearLabel: string;
  disabled?: boolean | undefined;
  size?: ComposerControlSize | undefined;
  triggerClassName?: string | undefined;
  onChange: (target: ProjectTaskModelTarget | null) => void;
}) {
  const catalog = useRoleModelCatalog(props.environmentId, props.projectId);
  const { value } = props;
  const fallback =
    catalog.entries.find((entry) => entry.enabled && entry.isAvailable) ?? catalog.entries[0];
  const activeInstanceId = value?.providerInstanceId ?? fallback?.instanceId;
  if (activeInstanceId === undefined) {
    return (
      <span className="text-muted-foreground text-xs" data-role-model-empty="">
        {value === null ? props.unsetLabel : roleModelLabel(value, catalog)}
      </span>
    );
  }
  const known =
    value !== null &&
    catalog.modelOptions
      .get(value.providerInstanceId)
      ?.some((option) => option.slug === value.model) === true;
  // The picker falls back to the instance's first model; an unknown slug shows as itself.
  const triggerLabel =
    value === null ? props.unsetLabel : known ? undefined : roleModelLabel(value, catalog);
  return (
    <span className="inline-flex min-w-0 items-center gap-1" data-role-model-set={value !== null}>
      <ProviderModelPicker
        environmentId={props.environmentId}
        activeInstanceId={activeInstanceId}
        model={value?.model ?? ""}
        lockedProvider={null}
        instanceEntries={catalog.entries}
        modelOptionsByInstance={catalog.modelOptions}
        size={props.size ?? "sm"}
        disabled={props.disabled === true}
        triggerAriaLabel={props.ariaLabel}
        {...(props.triggerClassName ? { triggerClassName: props.triggerClassName } : {})}
        {...(triggerLabel === undefined ? {} : { triggerLabel })}
        onInstanceModelChange={(providerInstanceId, model) =>
          props.onChange({ providerInstanceId, model })
        }
      />
      {value === null ? null : (
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-label={props.clearLabel}
          title={props.clearLabel}
          disabled={props.disabled === true}
          onClick={() => props.onChange(null)}
        >
          <XIcon className="size-3" />
        </Button>
      )}
    </span>
  );
}
