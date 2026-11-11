import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectTaskModelTarget,
  type ProjectTaskStepRole,
} from "@t3tools/contracts";
import {
  TASK_STEP_ROWS,
  thinkingLevelDescriptor,
  thinkingLevelLabel,
  thinkingLevelValue,
  withStepModel,
  withThinkingLevel,
} from "@t3tools/shared/taskStepModels";

import { useEnvironmentProviders } from "../../state/environments";
import { RoleModelPicker } from "../task/RoleModelPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const DEFAULT_STEP_MODELS = DEFAULT_SERVER_SETTINGS.taskStepModels;

const sameTarget = (a: ProjectTaskModelTarget, b: ProjectTaskModelTarget) =>
  JSON.stringify(a) === JSON.stringify(b);

function StepThinkingLevel(props: {
  environmentId: EnvironmentId;
  label: string;
  target: ProjectTaskModelTarget;
  onChange: (target: ProjectTaskModelTarget) => void;
}) {
  const providers = useEnvironmentProviders().get(props.environmentId) ?? [];
  const model = providers
    .find((provider) => provider.instanceId === props.target.providerInstanceId)
    ?.models.find((candidate) => candidate.slug === props.target.model);
  const descriptor = thinkingLevelDescriptor(model?.capabilities);
  const value = thinkingLevelValue(props.target, descriptor);
  if (descriptor === null || value === null) return null;
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") props.onChange(withThinkingLevel(props.target, descriptor, next));
      }}
    >
      <SelectTrigger size="sm" className="w-32" aria-label={`${props.label} 생각 수준`}>
        <SelectValue>{(current: string) => thinkingLevelLabel(current, descriptor)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {descriptor.options.map((choice) => (
          <SelectItem hideIndicator key={choice.id} value={choice.id}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function StepModelControl(props: {
  environmentId: EnvironmentId | null;
  label: string;
  target: ProjectTaskModelTarget;
  onChange: (target: ProjectTaskModelTarget) => void;
}) {
  if (props.environmentId === null) return null;
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      <RoleModelPicker
        environmentId={props.environmentId}
        projectId={null}
        value={props.target}
        unsetLabel={props.label}
        ariaLabel={`${props.label} 모델`}
        onChange={(next) => {
          if (next !== null) props.onChange(withStepModel(props.target, next));
        }}
      />
      <StepThinkingLevel
        environmentId={props.environmentId}
        label={props.label}
        target={props.target}
        onChange={props.onChange}
      />
    </span>
  );
}

/** App-wide model and thinking level for plan, implement (fix follows it) and review. */
export function StepModelsSettingsSection() {
  const { target, environment } = useSettingsScope();
  const environmentId = target?.environmentId ?? environment?.environmentId ?? null;
  const stepModels = useScopedSettings((settings) => settings.taskStepModels);
  const updateSettings = useUpdateScopedSettings();
  const setStep = (step: ProjectTaskStepRole, next: ProjectTaskModelTarget) =>
    updateSettings({ taskStepModels: { [step]: next } });

  return (
    <SettingsSection id="task-step-models" title="단계별 모델">
      {TASK_STEP_ROWS.map((row) => {
        const current = stepModels[row.step];
        return (
          <SettingsRow
            key={row.step}
            serverScoped
            settingKeys={["taskStepModels"]}
            {...searchableSetting(`task-step-model-${row.step}`)}
            description={row.description}
            resetAction={
              sameTarget(current, DEFAULT_STEP_MODELS[row.step]) ? null : (
                <SettingResetButton
                  label={`${row.label} 모델`}
                  onClick={() => setStep(row.step, DEFAULT_STEP_MODELS[row.step])}
                />
              )
            }
            control={
              <StepModelControl
                environmentId={environmentId}
                label={row.label}
                target={current}
                onChange={(next) => setStep(row.step, next)}
              />
            }
          />
        );
      })}
    </SettingsSection>
  );
}
