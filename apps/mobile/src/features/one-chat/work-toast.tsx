import {
  isToastVisible,
  workCounts,
  type ActionCard,
  type WorkItem,
} from "@t3tools/shared/one-chat";
import { useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { OneChatModal } from "./one-chat-modal";

export function workCountsLabel(items: ReadonlyArray<WorkItem>): string {
  const counts = workCounts(items);
  return `Waiting on you ${counts.waitingOnMe} · Running ${counts.running}`;
}

interface WorkListProps {
  readonly items: ReadonlyArray<WorkItem>;
  readonly cards: ReadonlyArray<ActionCard>;
  readonly taskTitle: (taskId: string) => string;
  readonly onJumpToCard: (cardId: string) => void;
  readonly onOpenDetails: (card: ActionCard) => void;
  readonly onOpenNode: (nodeId: string) => void;
}

function cardForItem(item: WorkItem, cards: ReadonlyArray<ActionCard>): ActionCard | null {
  if (item.taskId === null) return null;
  return (
    cards.find((card) => card.id === item.cardId) ??
    cards.find((card) => card.taskId === item.taskId && card.kind === "plan") ??
    cards.find((card) => card.taskId === item.taskId) ??
    null
  );
}

/** A task row with no card still opens its agreed end state, read from the task spec. */
function endStateCard(item: WorkItem): ActionCard | null {
  if (item.taskId === null) return null;
  return {
    id: `end-state:${item.taskId}`,
    kind: "plan",
    projectId: item.projectId,
    projectName: item.projectName,
    taskId: item.taskId,
    taskTitle: item.title,
    question: item.title,
    subline: item.statusLabel,
    options: [],
    criteria: [],
    answered: null,
    createdAt: "1970-01-01T00:00:00.000Z",
    attentionItemId: null,
    attentionProjectId: null,
    prUrl: item.prUrl,
    detailParagraphs: [],
    details: [],
    goal: null,
    verification: null,
  };
}

function WorkRow(props: WorkListProps & { readonly item: WorkItem }) {
  const { item } = props;
  const [open, setOpen] = useState(false);
  const waiting = item.state === "waiting_on_me";
  const card = cardForItem(item, props.cards) ?? endStateCard(item);
  const progress = [
    item.phaseLabel,
    item.criteriaCount > 0 ? `${item.provenCount} of ${item.criteriaCount} proven` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View testID="work-row" className="py-1.5">
      <Pressable
        accessibilityRole="button"
        className="flex-row items-center gap-2"
        onPress={() => {
          setOpen((value) => !value);
          if (waiting && item.cardId !== null) props.onJumpToCard(item.cardId);
        }}
      >
        <View className={`h-2 w-2 rounded-full ${waiting ? "bg-warning" : "bg-primary"}`} />
        <Text className="flex-1 text-sm" numberOfLines={1}>
          {item.title} <Text className="text-xs text-foreground-muted">@{item.projectName}</Text>
        </Text>
        <Text className="text-xs text-foreground-secondary">{item.statusLabel}</Text>
      </Pressable>
      {open ? (
        <View testID="work-row-details" className="ml-4 gap-1 pt-1.5">
          {item.childIds.length > 0 ? (
            <Text className="text-xs text-foreground-secondary">
              Subtasks: {item.childIds.map(props.taskTitle).join(", ")}
            </Text>
          ) : null}
          {progress ? (
            <Text className="text-xs text-foreground-secondary">Progress: {progress}</Text>
          ) : null}
          {item.waitsOnIds.length > 0 || item.prUrl ? (
            <View className="flex-row flex-wrap gap-1">
              <Text className="text-xs text-foreground-secondary">Links:</Text>
              {item.waitsOnIds.map((id) => (
                <Text key={id} className="text-xs text-foreground-secondary">
                  {props.taskTitle(id)}
                </Text>
              ))}
              {item.prUrl ? (
                <Pressable onPress={() => void Linking.openURL(item.prUrl!)}>
                  <Text className="text-xs text-primary">PR</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {card || item.nodeId !== null ? (
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                item.nodeId !== null ? props.onOpenNode(item.nodeId) : props.onOpenDetails(card!)
              }
            >
              <Text className="text-xs text-primary">View end state</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function WorkList(props: WorkListProps) {
  return (
    <>
      {props.items.map((item) => (
        <WorkRow key={item.id} {...props} item={item} />
      ))}
    </>
  );
}

/** A quiet line above the composer with the work in flight; hidden when nothing runs. */
export function WorkToast(props: WorkListProps) {
  const [expanded, setExpanded] = useState(false);
  const [large, setLarge] = useState(false);
  if (!isToastVisible(workCounts(props.items))) return null;
  const label = workCountsLabel(props.items);
  return (
    <View testID="work-toast" className="mx-3 mb-2 rounded-2xl border border-border bg-card px-3 py-2">
      <View className="flex-row items-center gap-3">
        <Text className="flex-1 text-sm text-foreground-secondary">{label}</Text>
        {expanded ? (
          <Pressable accessibilityRole="button" onPress={() => setLarge(true)}>
            <Text className="text-sm text-foreground-muted">Open large</Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" onPress={() => setExpanded((value) => !value)}>
          <Text className="text-sm text-primary">{expanded ? "Collapse" : "Expand"}</Text>
        </Pressable>
      </View>
      {expanded ? (
        <ScrollView style={{ maxHeight: 200 }} className="mt-1">
          <WorkList {...props} />
        </ScrollView>
      ) : null}
      {large ? (
        <OneChatModal title={label} onClose={() => setLarge(false)} testID="work-toast-large">
          <WorkList
            {...props}
            onJumpToCard={(cardId) => {
              setLarge(false);
              props.onJumpToCard(cardId);
            }}
          />
        </OneChatModal>
      ) : null}
    </View>
  );
}
