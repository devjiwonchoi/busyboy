import {
  isStallBlocker,
  isTurnFailedBlocker,
  isSandboxRotationDecision,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  approveAnswerFor,
  primaryActionLabel,
  defaultRequestOption,
  formatRequestAnswer,
  formatRequestLink,
  parseRequestMessage,
  REQUEST_DETAILS_LABEL,
  REQUEST_CONTEXT_MISSING,
  REQUEST_PLAN_SCOPE_NOTE,
  requestImpactLabels,
  parseRequestOption,
  requestParagraphs,
} from "@t3tools/shared/requestMessage";
import * as Clipboard from "expo-clipboard";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useProjects } from "../../state/entities";
import {
  projectTeamEnvironment,
  useAnswerDecision,
  useEnvironmentProjectTeamAttention,
} from "../../state/projectTeam";
import { useEnvironmentQuery } from "../../state/query";
import {
  cardOptionLabel,
  openTeamCardsForThread,
  snoozedTeamCardsForThread,
  splitCardQuestion,
  requestTodoRows,
  type ThreadTeamCard,
} from "./projectTeamCards.logic";
import { SnoozeAction, SnoozedTeamCards } from "./CardSnooze";
import { RequestActionButton } from "./RequestActionButton";

/**
 * Open requests stay above the PM or Director composer as individual messages.
 * Recovery requests retain their existing actions; the server relays every answer.
 */
export function ProjectTeamCards(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly canOperateThread: boolean;
  readonly onReply: (text: string) => void;
  readonly onOpenLead: (threadId: ThreadId) => void;
}) {
  const attention = useEnvironmentProjectTeamAttention(props.environmentId);
  const projects = useProjects();
  const { cards, snoozed } = useMemo(() => {
    const summaries = [...attention.byProjectId.values()];
    const titleOf = (projectId: string) =>
      projects.find(
        (candidate) =>
          candidate.environmentId === props.environmentId && candidate.id === projectId,
      )?.title ?? "프로젝트";
    return {
      cards: openTeamCardsForThread(summaries, props.threadId, titleOf),
      snoozed: snoozedTeamCardsForThread(summaries, props.threadId, titleOf),
    };
  }, [attention, projects, props.environmentId, props.threadId]);
  if (cards.length === 0 && snoozed.length === 0) {
    return null;
  }
  return (
    <View className="shrink-0 gap-3 px-4 pb-3" testID="project-team-cards">
      {cards.map((entry) => (
        <View key={entry.card.item.id} className="gap-1.5">
          <ProjectTeamCard
            entry={entry}
            environmentId={props.environmentId}
            canOperateThread={props.canOperateThread}
            onReply={props.onReply}
            onOpenLead={props.onOpenLead}
          />
          <SnoozeAction
            entry={entry}
            environmentId={props.environmentId}
            disabled={!props.canOperateThread}
          />
        </View>
      ))}
      <SnoozedTeamCards
        entries={snoozed}
        environmentId={props.environmentId}
        disabled={!props.canOperateThread}
      />
    </View>
  );
}

function LegacyProjectTeamCard(props: {
  readonly entry: ThreadTeamCard;
  readonly environmentId: EnvironmentId;
  readonly canOperateThread: boolean;
  readonly onReply: (text: string) => void;
  readonly onOpenLead: (threadId: ThreadId) => void;
}) {
  const answerDecision = useAnswerDecision();
  const [sending, setSending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const { card, header } = props.entry;
  const { title, detail } = splitCardQuestion(card.item.question);
  const options = card.item.options;
  const answer = async (option: string) => {
    setSending(option);
    setFailed(false);
    try {
      const result = await answerDecision(props.environmentId, {
        projectId: card.item.projectId,
        attentionItemId: card.item.id,
        answer: option,
      });
      if (AsyncResult.isFailure(result)) {
        setFailed(true);
      }
    } catch (error) {
      console.error("Failed to answer project request", error);
      setFailed(true);
    } finally {
      setSending(null);
    }
  };
  return (
    <View
      className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4"
      testID={`project-team-card-${card.item.kind}`}
    >
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-warning-foreground">
        {header}
      </Text>
      <Text className="font-t3-bold text-base text-foreground">{title}</Text>
      {detail !== "" ? (
        <Text
          className="font-sans text-sm leading-normal text-foreground-secondary"
          numberOfLines={6}
        >
          {detail}
        </Text>
      ) : null}
      {card.item.context?.reason ? (
        <Text className="font-sans text-xs leading-normal text-foreground-muted">
          {card.item.context.reason}
        </Text>
      ) : null}
      {failed ? (
        <Text className="font-sans text-xs text-danger-foreground">
          답을 보내지 못했어요. 다시 눌러 주세요.
        </Text>
      ) : null}
      {options.length > 0 ? (
        <View className="gap-2">
          {options.map((option, index) => (
            <RequestActionButton
              key={option}
              label={cardOptionLabel(option)}
              tone={index === 0 ? "primary" : "secondary"}
              disabled={sending !== null || !props.canOperateThread}
              onPress={() => void answer(option)}
            />
          ))}
        </View>
      ) : (
        <Text className="font-sans text-xs text-foreground-muted">
          선택지가 없는 질문이에요. 채팅으로 답해 주세요.
        </Text>
      )}
    </View>
  );
}

type ProjectTeamCardProps = Parameters<typeof LegacyProjectTeamCard>[0];

export function ProjectTeamCard(props: ProjectTeamCardProps) {
  if (
    isTurnFailedBlocker(props.entry.card.item) ||
    isSandboxRotationDecision(props.entry.card.item)
  ) {
    return <LegacyProjectTeamCard {...props} />;
  }
  return <RequestMessageCard {...props} />;
}

function RequestMessageCard(props: ProjectTeamCardProps) {
  const { card, sender, leadThreadId } = props.entry;
  const { item } = card;
  const message = parseRequestMessage(item.question);
  // Plan approvals read the task's spec for live done marks and the folded full plan.
  const detail = useEnvironmentQuery(
    item.kind === "approval" && item.taskId !== null
      ? projectTeamEnvironment.taskDetail({
          environmentId: props.environmentId,
          input: { projectId: item.projectId, taskId: item.taskId },
        })
      : null,
  );
  const versions = detail.data?.versions ?? [];
  const asked = versions.find((entry) => entry.version === item.specVersion)?.spec ?? null;
  const live = versions.at(-1)?.spec ?? null;
  const todos = requestTodoRows(card, asked?.todos).map((row) => ({
    ...row,
    done: live?.todos.find((todo) => todo.id === row.id)?.done ?? row.done,
  }));
  const [planOpen, setPlanOpen] = useState(false);
  const lead = item.senderRole === "lead" || (item.senderRole == null && leadThreadId !== null);
  const chatThreadId = lead && leadThreadId !== null ? leadThreadId : item.askerThreadId;
  const answerDecision = useAnswerDecision();
  const [expanded, setExpanded] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => defaultRequestOption(item.options));
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = sending || !props.canOperateThread;

  // Keep failed requests visible and retryable instead of clearing the user's choices.
  const answer = async (text: string) => {
    setSending(true);
    setError(null);
    try {
      const result = await answerDecision(props.environmentId, {
        projectId: item.projectId,
        attentionItemId: item.id,
        answer: text,
      });
      if (AsyncResult.isFailure(result)) {
        setError("답을 보내지 못했어요. 다시 눌러 주세요.");
      }
    } catch (cause) {
      console.error("Failed to answer project request", cause);
      setError("답을 보내지 못했어요. 다시 눌러 주세요.");
    } finally {
      setSending(false);
    }
  };
  const link = formatRequestLink(item.id, message.headline);
  const copyLink = async () => {
    try {
      await Clipboard.setStringAsync(link);
      setActionsOpen(false);
    } catch (cause) {
      console.error("Failed to copy request link", cause);
      setError("링크를 복사하지 못했어요. 다시 눌러 주세요.");
    }
  };

  return (
    <View className="gap-1.5" testID={`project-team-card-${item.kind}`}>
      {/* Reply and copy link sit outside the bubble, which holds only its two buttons. */}
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 font-sans text-xs text-foreground-muted">{sender}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="요청 동작"
          hitSlop={8}
          onPress={() => setActionsOpen(!actionsOpen)}
        >
          <Text className="text-foreground-muted">⋯</Text>
        </Pressable>
      </View>
      {actionsOpen ? (
        <View className="flex-row gap-2" testID="request-message-actions">
          {props.entry.replyable ? (
            <RequestActionButton
              label="답장"
              tone="secondary"
              disabled={!props.canOperateThread}
              onPress={() => {
                props.onReply(link);
                setActionsOpen(false);
              }}
            />
          ) : null}
          <RequestActionButton label="링크 복사" tone="secondary" onPress={() => void copyLink()} />
        </View>
      ) : null}
      <View
        className="gap-3 rounded-[20px] border border-border bg-card-alt p-4"
        testID="request-bubble"
      >
        <Text className="font-t3-bold text-base text-foreground">{message.headline}</Text>
        {requestParagraphs(card).map((paragraph, index) => (
          <Text key={index} className="font-sans text-sm leading-normal text-foreground-secondary">
            {paragraph}
          </Text>
        ))}
        {(item.kind === "approval"
          ? todos
          : message.steps.map((text, index) => ({ text, done: false, number: index + 1 }))
        ).map((row) => (
          <Text
            key={row.number}
            className={
              row.done
                ? "font-sans text-sm text-foreground-muted line-through opacity-50"
                : "font-sans text-sm text-foreground-secondary"
            }
          >
            {row.number}. {row.text}
          </Text>
        ))}
        {expanded ? (
          <View className="gap-3" testID="request-details">
            {item.context ? (
              <View className="gap-2" testID="request-context">
                <Text className="font-sans text-sm text-foreground">{item.context.action}</Text>
                <Text className="font-sans text-sm text-foreground-secondary">
                  {item.context.reason}
                </Text>
                <Text className="font-sans text-xs text-foreground-muted">
                  {requestImpactLabels(item.context).join(" · ")}
                </Text>
                <Text className="font-sans text-sm text-foreground-secondary">
                  추천안: {item.context.recommendation}
                </Text>
                {item.kind === "approval" ? (
                  <Text className="font-sans text-xs text-foreground-muted">
                    {REQUEST_PLAN_SCOPE_NOTE}
                  </Text>
                ) : null}
              </View>
            ) : (
              <View testID="request-context">
                <Text className="font-sans text-xs text-warning-foreground">
                  {REQUEST_CONTEXT_MISSING}
                </Text>
              </View>
            )}
            {(item.details ?? []).map((detail, index) => (
              <Text key={index} className="font-sans text-sm text-foreground-secondary">
                {detail.label}: {detail.text}
              </Text>
            ))}
            {item.kind === "approval" && todos.length > 0 ? (
              <View className="gap-1">
                <Text className="font-t3-bold text-sm text-foreground">단계</Text>
                {todos.map((todo) => (
                  <Text key={todo.number} className="font-sans text-sm text-foreground-secondary">
                    {todo.number}. {todo.detail}
                  </Text>
                ))}
              </View>
            ) : null}
            {/* A stalled task's card has one answer, already the main button. */}
            {item.kind !== "approval" && !isStallBlocker(item) && item.options.length > 0 ? (
              <View className="gap-2">
                {item.options.map((option) => {
                  const parsed = parseRequestOption(option);
                  return (
                    <Pressable
                      key={option}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected === option, disabled }}
                      disabled={disabled}
                      onPress={() => setSelected(option)}
                      className="flex-row gap-2 rounded-xl border border-border p-3"
                    >
                      <Text className="text-foreground">{selected === option ? "●" : "○"}</Text>
                      <View className="flex-1 gap-0.5">
                        <Text className="font-sans text-sm text-foreground">{parsed.label}</Text>
                        {parsed.tradeoff ? (
                          <Text className="font-sans text-xs text-foreground-muted">
                            {parsed.tradeoff}
                          </Text>
                        ) : null}
                      </View>
                      {parsed.recommended ? (
                        <Text className="text-xs text-foreground-muted">추천</Text>
                      ) : null}
                    </Pressable>
                  );
                })}
                <TextInput
                  accessibilityLabel="추가 의견"
                  placeholder="추가 의견 (선택)"
                  value={note}
                  onChangeText={setNote}
                  editable={!disabled}
                  multiline
                  className="rounded-xl border border-border p-3 text-foreground"
                />
                <RequestActionButton
                  label="보내기"
                  disabled={disabled || selected === null}
                  onPress={() => {
                    if (selected !== null) {
                      void answer(formatRequestAnswer(selected, note));
                    }
                  }}
                />
              </View>
            ) : null}
            {asked?.nonGoals ? (
              <View className="gap-1">
                <Text className="font-t3-bold text-sm text-foreground">안 하는 것</Text>
                <Text className="font-sans text-sm text-foreground-secondary">
                  {asked.nonGoals}
                </Text>
              </View>
            ) : null}
            {asked !== null ? (
              <RequestActionButton
                label="전체 플랜"
                tone="secondary"
                accessibilityState={{ expanded: planOpen }}
                onPress={() => setPlanOpen(!planOpen)}
              />
            ) : null}
            {planOpen && asked !== null ? (
              // The phone has no plan review screen, so the full plan unfolds here; changes go by reply.
              <View className="gap-2" testID="request-full-plan">
                <Text className="font-sans text-sm text-foreground-secondary">{asked.summary}</Text>
                <Text className="font-sans text-sm text-foreground-secondary">{asked.goal}</Text>
                {asked.criteria.map((criterion) => (
                  <Text key={criterion.id} className="font-sans text-sm text-foreground-secondary">
                    · {criterion.text}
                  </Text>
                ))}
              </View>
            ) : null}
            {chatThreadId !== null ? (
              <RequestActionButton
                label={lead ? "💬 리드와 대화" : "대화하기"}
                tone="secondary"
                onPress={() => props.onOpenLead(chatThreadId)}
              />
            ) : null}
          </View>
        ) : null}
        {error !== null ? (
          <Text className="font-sans text-xs text-danger-foreground">{error}</Text>
        ) : null}
        <View className="h-px bg-border" />
        <View className="flex-row gap-2" testID="request-actions">
          <View className="flex-1">
            <RequestActionButton
              label={primaryActionLabel(item)}
              disabled={disabled}
              onPress={() => void answer(approveAnswerFor(item))}
            />
          </View>
          <View className="flex-1">
            <RequestActionButton
              label={REQUEST_DETAILS_LABEL}
              tone="secondary"
              accessibilityState={{ expanded }}
              onPress={() => setExpanded(!expanded)}
            />
          </View>
        </View>
      </View>
    </View>
  );
}
