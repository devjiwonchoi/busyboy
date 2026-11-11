import {
  type EnvironmentId,
  MAX_TASK_MAX_CONCURRENT_SESSIONS,
  MIN_TASK_MAX_CONCURRENT_SESSIONS,
  type ServerSettingsPatch,
  type TaskExecutionSettings as TaskExecutionSettingsValue,
} from "@t3tools/contracts";
import {
  bytesToGb,
  formatTaskExecutionMemoryStatus,
  planTaskExecutionMemoryPatch,
  TASK_EXECUTION_LOCATION_OPTIONS,
} from "@t3tools/shared/taskExecutionSettings";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { SettingsChoiceRow } from "./SettingsChoiceRow";
import { SettingsSection } from "./SettingsSection";

const HOST_RESOURCES_REFRESH_MS = 10_000;

/** "지금: 여유 2.1 GB · 스왑 0.7 / 2 GB · 보통" for one environment. */
function TaskExecutionMemoryStatus(props: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    serverEnvironment.hostResources({ environmentId: props.environmentId, input: {} }),
  );
  const { refresh } = query;
  useEffect(() => {
    const timer = setInterval(refresh, HOST_RESOURCES_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  if (query.data === null) return null;
  return (
    <Text textRole="footnote" className="px-4 text-foreground-muted">
      {formatTaskExecutionMemoryStatus(query.data)}
    </Text>
  );
}

function parseGb(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text.trim().replace(",", "."));
}

export function TaskExecutionSettings(props: {
  readonly value: TaskExecutionSettingsValue;
  /** The environment whose memory the status line shows; null when several are selected. */
  readonly statusEnvironmentId: EnvironmentId | null;
  readonly disabled: boolean;
  readonly onChange: (patch: ServerSettingsPatch) => void;
}) {
  const storedStart = String(bytesToGb(props.value.startMinFreeBytes));
  const storedPause = String(bytesToGb(props.value.pauseBelowFreeBytes));
  const storedMax = String(props.value.maxConcurrentSessions);
  const [start, setStart] = useState(storedStart);
  const [pause, setPause] = useState(storedPause);
  const [max, setMax] = useState(storedMax);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => setStart(storedStart), [storedStart]);
  useEffect(() => setPause(storedPause), [storedPause]);
  useEffect(() => setMax(storedMax), [storedMax]);

  const commitMemory = () => {
    const plan = planTaskExecutionMemoryPatch({
      startMinFreeGb: parseGb(start),
      pauseBelowFreeGb: parseGb(pause),
    });
    if (!plan.ok) {
      setMessage(plan.message);
      return;
    }
    setMessage(null);
    if (
      plan.patch.taskExecution.startMinFreeBytes !== props.value.startMinFreeBytes ||
      plan.patch.taskExecution.pauseBelowFreeBytes !== props.value.pauseBelowFreeBytes
    ) {
      props.onChange(plan.patch);
    }
  };
  const commitMax = () => {
    const value = Number(max.trim());
    if (
      !Number.isInteger(value) ||
      value < MIN_TASK_MAX_CONCURRENT_SESSIONS ||
      value > MAX_TASK_MAX_CONCURRENT_SESSIONS
    ) {
      setMax(storedMax);
      return;
    }
    if (value !== props.value.maxConcurrentSessions) {
      props.onChange({ taskExecution: { maxConcurrentSessions: value } });
    }
  };

  return (
    <>
      {props.statusEnvironmentId !== null ? (
        <TaskExecutionMemoryStatus environmentId={props.statusEnvironmentId} />
      ) : null}
      <SettingsSection title="실행 위치" footer="클라우드는 여기서 허용할 때만 써요">
        {TASK_EXECUTION_LOCATION_OPTIONS.map((option, index) => (
          <SettingsChoiceRow
            key={option.value}
            label={option.label}
            selected={props.value.location === option.value}
            separated={index > 0}
            disabled={props.disabled}
            onPress={() => props.onChange({ taskExecution: { location: option.value } })}
          />
        ))}
      </SettingsSection>
      <SettingsSection title="메모리" {...(message === null ? {} : { footer: message })}>
        <NumberRow
          label="새 세션 시작 최소 여유 메모리"
          hint="이보다 적으면 대기해요"
          unit="GB"
          value={start}
          keyboardType="decimal-pad"
          disabled={props.disabled}
          onChange={setStart}
          onCommit={commitMemory}
        />
        <NumberRow
          label="세션을 멈추는 여유 메모리"
          hint="이보다 적으면 덜 급한 것부터 멈춰요"
          unit="GB"
          value={pause}
          keyboardType="decimal-pad"
          disabled={props.disabled}
          separated
          onChange={setPause}
          onCommit={commitMemory}
        />
        <NumberRow
          label="최대 동시 세션"
          hint="안전장치"
          value={max}
          keyboardType="number-pad"
          disabled={props.disabled}
          separated
          onChange={setMax}
          onCommit={commitMax}
        />
      </SettingsSection>
    </>
  );
}

function NumberRow(props: {
  readonly label: string;
  readonly hint: string;
  readonly unit?: string;
  readonly value: string;
  readonly keyboardType: "decimal-pad" | "number-pad";
  readonly disabled: boolean;
  readonly separated?: boolean;
  readonly onChange: (value: string) => void;
  readonly onCommit: () => void;
}) {
  return (
    <View
      className={
        props.separated
          ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
          : "min-h-14 flex-row items-center gap-3 px-4 py-3"
      }
    >
      <View className="min-w-0 flex-1">
        <Text className="text-base text-foreground">{props.label}</Text>
        <Text className="text-sm text-foreground-muted">{props.hint}</Text>
      </View>
      <View className="flex-row items-center gap-1.5">
        <AppTextInput
          accessibilityLabel={props.label}
          value={props.value}
          onChangeText={props.onChange}
          onEndEditing={props.onCommit}
          keyboardType={props.keyboardType}
          editable={!props.disabled}
          className="min-h-10 w-20 rounded-xl px-3 py-2 text-right text-base text-foreground"
        />
        {props.unit ? <Text className="text-sm text-foreground-muted">{props.unit}</Text> : null}
      </View>
    </View>
  );
}
