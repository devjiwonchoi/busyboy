import { type EnvironmentId, PROJECT_ATTENTION_SNOOZE_REASON_MAX } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useSnoozeDecision, useUnsnoozeDecision } from "../../state/projectTeam";
import { splitCardQuestion, type ThreadTeamCard } from "./projectTeamCards.logic";
import { RequestActionButton } from "./RequestActionButton";

/** A quiet "보류" under a request; snoozing asks for a reason first. */
export function SnoozeAction(props: {
  readonly entry: ThreadTeamCard;
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
}) {
  const snooze = useSnoozeDecision();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const { item } = props.entry.card;
  const trimmed = reason.trim();
  if (!open) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="요청 보류"
        disabled={props.disabled}
        hitSlop={8}
        className="self-start"
        onPress={() => setOpen(true)}
      >
        <Text className="text-xs text-foreground-muted">보류</Text>
      </Pressable>
    );
  }
  const submit = async () => {
    if (trimmed === "") return;
    setSending(true);
    setFailed(false);
    try {
      const result = await snooze(props.environmentId, {
        projectId: item.projectId,
        attentionItemId: item.id,
        reason: trimmed,
      });
      if (AsyncResult.isFailure(result)) {
        setFailed(true);
        return;
      }
      setOpen(false);
      setReason("");
    } catch (cause) {
      console.error("Failed to snooze project request", cause);
      setFailed(true);
    } finally {
      setSending(false);
    }
  };
  return (
    <View className="gap-2" testID="snooze-form">
      <TextInput
        accessibilityLabel="보류 이유"
        placeholder="보류 이유"
        autoFocus
        maxLength={PROJECT_ATTENTION_SNOOZE_REASON_MAX}
        value={reason}
        onChangeText={setReason}
        className="rounded-xl border border-border px-3 py-2 text-sm text-foreground"
      />
      <View className="flex-row gap-2">
        <RequestActionButton
          label="보류"
          accessibilityLabel="이유와 함께 보류"
          tone="secondary"
          disabled={trimmed === "" || sending || props.disabled}
          onPress={() => void submit()}
        />
        <RequestActionButton
          label="취소"
          accessibilityLabel="보류 취소"
          tone="secondary"
          onPress={() => {
            setOpen(false);
            setReason("");
          }}
        />
      </View>
      {failed ? <Text className="text-xs text-foreground-muted">보류하지 못했어요</Text> : null}
    </View>
  );
}

/** The folded "보류 N" list below the open requests. */
export function SnoozedTeamCards(props: {
  readonly entries: ReadonlyArray<ThreadTeamCard>;
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (props.entries.length === 0) {
    return null;
  }
  return (
    <View className="gap-2" testID="snoozed-cards">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={8}
        className="self-start"
        onPress={() => setOpen(!open)}
      >
        <Text className="text-xs text-foreground-muted">
          보류 {props.entries.length} {open ? "▴" : "▾"}
        </Text>
      </Pressable>
      {open
        ? props.entries.map((entry) => (
            <SnoozedRow
              key={entry.card.item.id}
              entry={entry}
              environmentId={props.environmentId}
              disabled={props.disabled}
            />
          ))
        : null}
    </View>
  );
}

function SnoozedRow(props: {
  readonly entry: ThreadTeamCard;
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
}) {
  const unsnooze = useUnsnoozeDecision();
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const { item } = props.entry.card;
  return (
    <View className="flex-row items-start gap-2" testID={`snoozed-card-${item.id}`}>
      <View className="flex-1 gap-0.5">
        <Text className="text-xs text-foreground-muted">{props.entry.sender}</Text>
        <Text className="text-sm text-foreground">{splitCardQuestion(item.question).title}</Text>
        <Text className="text-xs text-foreground-muted">이유: {item.snoozeReason ?? ""}</Text>
        {failed ? (
          <Text className="text-xs text-foreground-muted">다시 꺼내지 못했어요</Text>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="다시 꺼내기"
        disabled={sending || props.disabled}
        hitSlop={8}
        onPress={async () => {
          setSending(true);
          setFailed(false);
          try {
            const result = await unsnooze(props.environmentId, {
              projectId: item.projectId,
              attentionItemId: item.id,
            });
            if (AsyncResult.isFailure(result)) setFailed(true);
          } catch (cause) {
            console.error("Failed to bring back project request", cause);
            setFailed(true);
          } finally {
            setSending(false);
          }
        }}
      >
        <Text className="text-xs text-foreground">다시 꺼내기</Text>
      </Pressable>
    </View>
  );
}
