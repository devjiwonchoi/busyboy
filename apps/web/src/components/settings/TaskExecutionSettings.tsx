import {
  DEFAULT_SERVER_SETTINGS,
  MAX_TASK_MAX_CONCURRENT_SESSIONS,
  MIN_TASK_MAX_CONCURRENT_SESSIONS,
  type TaskExecutionLocationPolicy,
} from "@t3tools/contracts";
import {
  bytesToGb,
  formatTaskExecutionMemoryStatus,
  planTaskExecutionMemoryPatch,
  TASK_EXECUTION_LOCATION_OPTIONS,
  TASK_EXECUTION_MEMORY_MAX_GB,
  TASK_EXECUTION_MEMORY_MIN_GB,
  TASK_EXECUTION_MEMORY_STEP_GB,
  taskExecutionLocationLabel,
  type TaskExecutionMemoryDraft,
} from "@t3tools/shared/taskExecutionSettings";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const HOST_RESOURCES_REFRESH_MS = 10_000;
const DEFAULT_TASK_EXECUTION = DEFAULT_SERVER_SETTINGS.taskExecution;

/** "지금: 여유 2.1 GB · 스왑 0.7 / 2 GB · 보통" for the one environment in scope. */
function TaskExecutionMemoryStatus() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.hostResources({ environmentId, input: {} }),
  );
  const { refresh } = query;
  useEffect(() => {
    if (environmentId === null) return;
    const timer = setInterval(refresh, HOST_RESOURCES_REFRESH_MS);
    return () => clearInterval(timer);
  }, [environmentId, refresh]);
  if (query.data === null) return null;
  return (
    <span data-task-execution-status className="text-xs text-muted-foreground">
      {formatTaskExecutionMemoryStatus(query.data)}
    </span>
  );
}

export function TaskExecutionSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const taskExecution = settings.taskExecution;
  const stored: TaskExecutionMemoryDraft = {
    startMinFreeGb: bytesToGb(taskExecution.startMinFreeBytes),
    pauseBelowFreeGb: bytesToGb(taskExecution.pauseBelowFreeBytes),
  };
  // Kept locally so an invalid pair can show its message without being written.
  const [draft, setDraft] = useState<TaskExecutionMemoryDraft | null>(null);
  const memory = draft ?? stored;
  const plan = planTaskExecutionMemoryPatch(memory);
  useEffect(() => {
    if (
      draft !== null &&
      draft.startMinFreeGb === stored.startMinFreeGb &&
      draft.pauseBelowFreeGb === stored.pauseBelowFreeGb
    ) {
      setDraft(null);
    }
  }, [draft, stored.startMinFreeGb, stored.pauseBelowFreeGb]);

  const setMemory = (change: Partial<TaskExecutionMemoryDraft>) => {
    const next = { ...memory, ...change };
    setDraft(next);
    const nextPlan = planTaskExecutionMemoryPatch(next);
    if (nextPlan.ok) updateSettings(nextPlan.patch);
  };
  const resetMemory = () => {
    setDraft(null);
    updateSettings({
      taskExecution: {
        startMinFreeBytes: DEFAULT_TASK_EXECUTION.startMinFreeBytes,
        pauseBelowFreeBytes: DEFAULT_TASK_EXECUTION.pauseBelowFreeBytes,
      },
    });
  };
  const memoryIsDefault =
    draft === null &&
    taskExecution.startMinFreeBytes === DEFAULT_TASK_EXECUTION.startMinFreeBytes &&
    taskExecution.pauseBelowFreeBytes === DEFAULT_TASK_EXECUTION.pauseBelowFreeBytes;

  return (
    <SettingsSection
      id="task-execution"
      title="작업 실행"
      headerAction={<TaskExecutionMemoryStatus />}
    >
      <SettingsRow
        serverScoped
        settingKeys={["taskExecution"]}
        {...searchableSetting("task-execution-location")}
        description="클라우드는 여기서 허용할 때만 써요"
        resetAction={
          taskExecution.location !== DEFAULT_TASK_EXECUTION.location ? (
            <SettingResetButton
              label="실행 위치"
              onClick={() =>
                updateSettings({ taskExecution: { location: DEFAULT_TASK_EXECUTION.location } })
              }
            />
          ) : null
        }
        control={
          <Select
            value={taskExecution.location}
            onValueChange={(value) => {
              const option = TASK_EXECUTION_LOCATION_OPTIONS.find((item) => item.value === value);
              if (option) updateSettings({ taskExecution: { location: option.value } });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="실행 위치">
              <SelectValue>
                {(value: TaskExecutionLocationPolicy) => taskExecutionLocationLabel(value)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {TASK_EXECUTION_LOCATION_OPTIONS.map((option) => (
                <SelectItem hideIndicator key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["taskExecution"]}
        {...searchableSetting("task-execution-start-memory")}
        description="이보다 적으면 대기해요"
        resetAction={
          memoryIsDefault ? null : <SettingResetButton label="메모리 기준" onClick={resetMemory} />
        }
        control={
          <MemoryField
            label="새 세션 시작 최소 여유 메모리"
            value={memory.startMinFreeGb}
            onChange={(startMinFreeGb) => setMemory({ startMinFreeGb })}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["taskExecution"]}
        {...searchableSetting("task-execution-pause-memory")}
        description="이보다 적으면 덜 급한 것부터 멈춰요"
        status={plan.ok ? null : plan.message}
        control={
          <MemoryField
            label="세션을 멈추는 여유 메모리"
            value={memory.pauseBelowFreeGb}
            invalid={!plan.ok}
            onChange={(pauseBelowFreeGb) => setMemory({ pauseBelowFreeGb })}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["taskExecution"]}
        {...searchableSetting("task-execution-max-sessions")}
        description="안전장치"
        resetAction={
          taskExecution.maxConcurrentSessions !== DEFAULT_TASK_EXECUTION.maxConcurrentSessions ? (
            <SettingResetButton
              label="최대 동시 세션"
              onClick={() =>
                updateSettings({
                  taskExecution: {
                    maxConcurrentSessions: DEFAULT_TASK_EXECUTION.maxConcurrentSessions,
                  },
                })
              }
            />
          ) : null
        }
        control={
          <NumberField
            value={taskExecution.maxConcurrentSessions}
            min={MIN_TASK_MAX_CONCURRENT_SESSIONS}
            max={MAX_TASK_MAX_CONCURRENT_SESSIONS}
            step={1}
            size="sm"
            className="w-32"
            onValueChange={(value) => {
              if (
                value === null ||
                !Number.isInteger(value) ||
                value < MIN_TASK_MAX_CONCURRENT_SESSIONS ||
                value > MAX_TASK_MAX_CONCURRENT_SESSIONS ||
                value === taskExecution.maxConcurrentSessions
              ) {
                return;
              }
              updateSettings({ taskExecution: { maxConcurrentSessions: value } });
            }}
          >
            <NumberFieldGroup>
              <NumberFieldDecrement aria-label="최대 동시 세션 줄이기" />
              <NumberFieldInput aria-label="최대 동시 세션" />
              <NumberFieldIncrement aria-label="최대 동시 세션 늘리기" />
            </NumberFieldGroup>
          </NumberField>
        }
      />
    </SettingsSection>
  );
}

function MemoryField(props: {
  readonly label: string;
  readonly value: number;
  readonly invalid?: boolean;
  readonly onChange: (value: number) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <NumberField
        value={props.value}
        min={TASK_EXECUTION_MEMORY_MIN_GB}
        max={TASK_EXECUTION_MEMORY_MAX_GB}
        step={TASK_EXECUTION_MEMORY_STEP_GB}
        size="sm"
        className="w-32"
        onValueChange={(value) => {
          if (value !== null) props.onChange(value);
        }}
      >
        <NumberFieldGroup>
          <NumberFieldDecrement aria-label={`${props.label} 줄이기`} />
          <NumberFieldInput aria-label={props.label} aria-invalid={props.invalid || undefined} />
          <NumberFieldIncrement aria-label={`${props.label} 늘리기`} />
        </NumberFieldGroup>
      </NumberField>
      <span className="text-xs text-muted-foreground">GB</span>
    </div>
  );
}
