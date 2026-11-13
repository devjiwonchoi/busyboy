import type {
  EnvironmentId,
  ProjectId,
  ProjectTaskId,
  ProjectTaskSpec,
} from "@t3tools/contracts";
import type { ActionCard, ActionCardOption } from "@t3tools/shared/one-chat";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useTaskDetail } from "~/state/projectTeam";

export const RECOMMENDED_SUFFIX = " (Recommended)";

export function optionLabel(option: ActionCardOption): string {
  return option.recommended ? `${option.label}${RECOMMENDED_SUFFIX}` : option.label;
}

/** A task's current spec, or null while it loads. */
export function useCurrentSpec(
  environmentId: EnvironmentId,
  projectId: string,
  taskId: string,
): ProjectTaskSpec | null {
  const detail = useTaskDetail(environmentId, {
    projectId: projectId as ProjectId,
    taskId: taskId as ProjectTaskId,
  }).data;
  return detail?.versions.at(-1)?.spec ?? null;
}

/** The first few non-empty lines of a free-text field, without list markers. */
export function firstLines(text: string, count: number): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, count);
}

function PlanNonGoals({
  environmentId,
  projectId,
  taskId,
}: {
  environmentId: EnvironmentId;
  projectId: string;
  taskId: string;
}) {
  const spec = useCurrentSpec(environmentId, projectId, taskId);
  const lines = firstLines(spec?.nonGoals ?? "", 2);
  if (lines.length === 0) return null;
  return (
    <p data-one-chat-card-non-goals className="text-muted-foreground text-xs">
      Do not: {lines.join(" · ")}
    </p>
  );
}

export function OptionButtons({
  card,
  onPick,
}: {
  card: ActionCard;
  onPick: (option: ActionCardOption) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {card.options.map((option) => (
        <Button
          key={option.value}
          size="sm"
          variant={option.recommended ? "default" : "outline"}
          data-one-chat-option={option.recommended ? "recommended" : "other"}
          onClick={() => onPick(option)}
        >
          {optionLabel(option)}
        </Button>
      ))}
    </div>
  );
}

/** One card in the chat: who asks, the one-line question, and the choices. */
export function ActionCardView({
  card,
  environmentId,
  onPick,
  onOpenDetails,
}: {
  card: ActionCard;
  environmentId: EnvironmentId | null;
  onPick: (card: ActionCard, option: ActionCardOption) => void;
  onOpenDetails: (card: ActionCard) => void;
}) {
  const sender = [card.projectName, card.taskTitle].filter(Boolean).join(" · ");
  return (
    <article
      data-one-chat-card={card.id}
      data-kind={card.kind}
      data-answered={card.answered ? "true" : "false"}
      className={cn(
        "flex max-w-[85%] flex-col gap-1.5 self-start rounded-xl border bg-card px-3 py-2.5 transition-shadow",
        "data-[highlighted=true]:ring-2 data-[highlighted=true]:ring-primary",
        card.answered && "bg-muted/40",
      )}
    >
      <p className="truncate text-muted-foreground text-xs">{sender}</p>
      <p data-one-chat-card-question className="truncate font-semibold text-sm">
        {card.question}
      </p>
      {card.answered ? (
        <p data-one-chat-card-picked className="text-muted-foreground text-xs">
          You chose: {card.answered.label}
        </p>
      ) : (
        <>
          {card.subline ? (
            <p data-one-chat-card-subline className="text-muted-foreground text-xs">
              {card.subline}
            </p>
          ) : null}
          {card.kind === "plan" && card.criteria.length > 0 ? (
            <ol data-one-chat-card-criteria className="list-decimal ps-5 text-xs">
              {card.criteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ol>
          ) : null}
          {card.kind === "plan" && card.taskId !== null && environmentId !== null ? (
            <PlanNonGoals
              environmentId={environmentId}
              projectId={card.projectId}
              taskId={card.taskId}
            />
          ) : null}
          <div className="flex items-end gap-2">
            <OptionButtons card={card} onPick={(option) => onPick(card, option)} />
            <button
              type="button"
              data-one-chat-card-details
              className="ms-auto shrink-0 text-muted-foreground text-xs underline-offset-2 hover:underline"
              onClick={() => onOpenDetails(card)}
            >
              Details
            </button>
          </div>
        </>
      )}
    </article>
  );
}
