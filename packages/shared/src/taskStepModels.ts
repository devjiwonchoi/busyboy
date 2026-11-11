import type {
  ModelCapabilities,
  ProjectTaskModelTarget,
  ProjectTaskStepRole,
  SelectProviderOptionDescriptor,
} from "@t3tools/contracts";

/** The settings rows for the three steps the app sets models for. Fix follows implement. */
export const TASK_STEP_ROWS: ReadonlyArray<{
  readonly step: ProjectTaskStepRole;
  readonly label: string;
  readonly description: string;
}> = [
  { step: "plan", label: "플랜", description: "리드가 이 모델로 시작해요" },
  { step: "implement", label: "구현", description: "수정도 이 모델로 해요" },
  { step: "review", label: "리뷰", description: "PR 전에 이 모델이 검토해요" },
];

const THINKING_LEVEL_IDS = new Set(["effort", "reasoningEffort"]);

/** The model's thinking-level option (Claude effort, Codex reasoning effort), if it has one. */
export function thinkingLevelDescriptor(
  capabilities: ModelCapabilities | null | undefined,
): SelectProviderOptionDescriptor | null {
  const descriptor = capabilities?.optionDescriptors?.find(
    (candidate) => candidate.type === "select" && THINKING_LEVEL_IDS.has(candidate.id),
  );
  return descriptor?.type === "select" ? descriptor : null;
}

/** The thinking level a step saved, else the model's default. */
export function thinkingLevelValue(
  target: ProjectTaskModelTarget,
  descriptor: SelectProviderOptionDescriptor | null,
): string | null {
  const saved = target.options?.find((option) => THINKING_LEVEL_IDS.has(option.id))?.value;
  if (typeof saved === "string") return saved;
  if (descriptor === null) return null;
  return (
    descriptor.currentValue ??
    descriptor.options.find((choice) => choice.isDefault)?.id ??
    descriptor.options[0]?.id ??
    null
  );
}

/** "Extra High" for a saved value, falling back to the value itself. */
export function thinkingLevelLabel(
  value: string,
  descriptor: SelectProviderOptionDescriptor | null,
): string {
  return descriptor?.options.find((choice) => choice.id === value)?.label ?? value;
}

/** A step on another model; the old model's options do not carry over. */
export function withStepModel(
  current: ProjectTaskModelTarget,
  next: Pick<ProjectTaskModelTarget, "providerInstanceId" | "model">,
): ProjectTaskModelTarget {
  if (current.providerInstanceId === next.providerInstanceId && current.model === next.model) {
    return current;
  }
  return { providerInstanceId: next.providerInstanceId, model: next.model };
}

/** The step with its thinking level set, keeping any other options. */
export function withThinkingLevel(
  current: ProjectTaskModelTarget,
  descriptor: SelectProviderOptionDescriptor,
  value: string,
): ProjectTaskModelTarget {
  const others = (current.options ?? []).filter((option) => !THINKING_LEVEL_IDS.has(option.id));
  return { ...current, options: [...others, { id: descriptor.id, value }] };
}
