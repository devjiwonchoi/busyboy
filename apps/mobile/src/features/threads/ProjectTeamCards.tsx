import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useProjects } from "../../state/entities";
import { useAnswerDecision, useEnvironmentProjectTeamAttention } from "../../state/projectTeam";
import {
  cardOptionLabel,
  openTeamCardsForThread,
  splitCardQuestion,
  type ThreadTeamCard,
} from "./projectTeamCards.logic";
import { RequestActionButton } from "./RequestActionButton";

/**
 * Open blocker and decision cards above the composer of a PM or Director chat, with the
 * project each one is about. Picking an option answers it; the server relays the answer.
 */
export function ProjectTeamCards(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly canOperateThread: boolean;
}) {
  const attention = useEnvironmentProjectTeamAttention(props.environmentId);
  const projects = useProjects();
  const cards = useMemo(
    () =>
      openTeamCardsForThread([...attention.byProjectId.values()], props.threadId, (projectId) => {
        const project = projects.find(
          (candidate) =>
            candidate.environmentId === props.environmentId && candidate.id === projectId,
        );
        return project?.title ?? "프로젝트";
      }),
    [attention, projects, props.environmentId, props.threadId],
  );
  if (cards.length === 0) return null;
  return (
    <View className="shrink-0 gap-3 px-4 pb-3" testID="project-team-cards">
      {cards.map((entry) => (
        <ProjectTeamCard
          key={entry.card.item.id}
          entry={entry}
          environmentId={props.environmentId}
          canOperateThread={props.canOperateThread}
        />
      ))}
    </View>
  );
}

export function ProjectTeamCard(props: {
  readonly entry: ThreadTeamCard;
  readonly environmentId: EnvironmentId;
  readonly canOperateThread: boolean;
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
      if (AsyncResult.isFailure(result)) setFailed(true);
    } catch {
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
