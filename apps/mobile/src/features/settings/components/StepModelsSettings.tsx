import type {
  ProjectTaskModelTarget,
  ProjectTaskStepModels,
  ProjectTaskStepRole,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  TASK_STEP_ROWS,
  thinkingLevelDescriptor,
  thinkingLevelLabel,
  thinkingLevelValue,
  withStepModel,
  withThinkingLevel,
} from "@t3tools/shared/taskStepModels";
import { useState } from "react";

import type { ModelOption } from "../../../lib/modelOptions";
import { SettingsChoiceRow } from "./SettingsChoiceRow";
import { SettingsSection } from "./SettingsSection";

function stepSummary(target: ProjectTaskModelTarget, models: ReadonlyArray<ModelOption>): string {
  const option = models.find(
    (candidate) =>
      candidate.selection.instanceId === target.providerInstanceId &&
      candidate.selection.model === target.model,
  );
  const descriptor = thinkingLevelDescriptor(option?.capabilities);
  const level = thinkingLevelValue(target, descriptor);
  const name = option?.label ?? target.model;
  return level === null ? name : `${name} · ${thinkingLevelLabel(level, descriptor)}`;
}

/** App-wide model and thinking level for plan, implement (fix follows it) and review. */
export function StepModelsSettings(props: {
  readonly value: ProjectTaskStepModels;
  /** The models the environment offers, as the model picker lists them. */
  readonly models: ReadonlyArray<ModelOption>;
  readonly disabled: boolean;
  readonly onChange: (patch: ServerSettingsPatch) => void;
}) {
  // One step open at a time; its model and thinking-level choices show under it.
  const [open, setOpen] = useState<ProjectTaskStepRole | null>(null);
  const setStep = (step: ProjectTaskStepRole, target: ProjectTaskModelTarget) =>
    props.onChange({ taskStepModels: { [step]: target } });

  return (
    <>
      <SettingsSection title="단계별 모델" footer="모든 프로젝트의 기본값이에요">
        {TASK_STEP_ROWS.map((row, index) => (
          <SettingsChoiceRow
            key={row.step}
            label={row.label}
            description={`${stepSummary(props.value[row.step], props.models)} · ${row.description}`}
            selected={open === row.step}
            separated={index > 0}
            disabled={props.disabled}
            onPress={() => setOpen(open === row.step ? null : row.step)}
          />
        ))}
      </SettingsSection>
      {open === null ? null : (
        <StepChoices
          label={TASK_STEP_ROWS.find((row) => row.step === open)?.label ?? open}
          target={props.value[open]}
          models={props.models}
          disabled={props.disabled}
          onChange={(target) => setStep(open, target)}
        />
      )}
    </>
  );
}

function StepChoices(props: {
  readonly label: string;
  readonly target: ProjectTaskModelTarget;
  readonly models: ReadonlyArray<ModelOption>;
  readonly disabled: boolean;
  readonly onChange: (target: ProjectTaskModelTarget) => void;
}) {
  const selected = props.models.find(
    (option) =>
      option.selection.instanceId === props.target.providerInstanceId &&
      option.selection.model === props.target.model,
  );
  const descriptor = thinkingLevelDescriptor(selected?.capabilities);
  const level = thinkingLevelValue(props.target, descriptor);
  return (
    <>
      {descriptor === null ? null : (
        <SettingsSection title={`${props.label} 생각 수준`}>
          {descriptor.options.map((choice, index) => (
            <SettingsChoiceRow
              key={choice.id}
              label={choice.label}
              selected={level === choice.id}
              separated={index > 0}
              disabled={props.disabled}
              onPress={() => props.onChange(withThinkingLevel(props.target, descriptor, choice.id))}
            />
          ))}
        </SettingsSection>
      )}
      <SettingsSection title={`${props.label} 모델`}>
        {props.models.map((option, index) => (
          <SettingsChoiceRow
            key={option.key}
            label={option.label}
            description={option.providerLabel}
            selected={option === selected}
            separated={index > 0}
            disabled={props.disabled}
            onPress={() =>
              props.onChange(
                withStepModel(props.target, {
                  providerInstanceId: option.selection.instanceId,
                  model: option.selection.model,
                }),
              )
            }
          />
        ))}
      </SettingsSection>
    </>
  );
}
