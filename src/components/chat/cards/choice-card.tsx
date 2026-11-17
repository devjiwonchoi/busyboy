"use client";

import { useId, useState } from "react";

import { answerCardAction } from "@/app/(main)/director-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  cardGroupLabel,
  optionLetter,
  type ApprovalCard,
  type QuestionCard,
} from "@/server/cards/model";

import { CardActionError, CardTrailingActions, useCardActions } from "./card-actions";
import { CardShell, CardShellActions, CardShellBody, CardShellHeader } from "./card-shell";
import type { CardViewProps } from "./card-view-props";

export function ChoiceCard({ card }: CardViewProps<QuestionCard | ApprovalCard>) {
  const { pending, replying, run } = useCardActions();
  const detail = card.kind === "approval" ? card.detail : undefined;
  return (
    <CardShell label={cardGroupLabel(card)} replying={replying}>
      <CardShellHeader title={`${card.project} · ${card.taskTitle}`} />
      <CardShellBody>
        <ChoiceOptions
          card={card}
          detail={detail}
          pending={pending}
          onAnswer={(choices) =>
            run(
              () => answerCardAction(card.id, choices),
              "The answer could not be sent. Try again.",
            )
          }
        />
        <CardActionError />
      </CardShellBody>
      <CardShellActions>
        <CardTrailingActions />
      </CardShellActions>
    </CardShell>
  );
}

function ChoiceOptions({
  card,
  detail,
  pending,
  onAnswer,
}: {
  card: QuestionCard | ApprovalCard;
  detail: string | undefined;
  pending: boolean;
  onAnswer: (choices: string[][]) => void;
}) {
  const [chosen, setChosen] = useState<string[][]>(() => card.questions.map(() => []));
  const descriptionId = useId();
  const answersOnClick = card.questions.length === 1 && !card.questions[0].multiSelect;
  const complete = card.questions.every((_, index) => (chosen[index] ?? []).length > 0);

  function choose(questionIndex: number, multiSelect: boolean, label: string) {
    if (answersOnClick) {
      onAnswer([[label]]);
      return;
    }
    setChosen((current) =>
      card.questions.map((_, index) => {
        const labels = current[index] ?? [];
        if (index !== questionIndex) {
          return labels;
        }
        if (!multiSelect) {
          return [label];
        }
        return labels.includes(label)
          ? labels.filter((other) => other !== label)
          : [...labels, label];
      }),
    );
  }

  return (
    <>
      {card.questions.map(({ question, header, options, multiSelect }, questionIndex) => (
        <fieldset key={questionIndex} className="space-y-2">
          <legend className="mb-1.5 font-medium">
            {header && <span className="text-muted-foreground">{header}: </span>}
            {question}
          </legend>
          {detail && (
            <pre className="bg-muted overflow-x-auto rounded-md px-2 py-1 font-mono whitespace-pre-wrap">
              {detail}
            </pre>
          )}
          <ItemGroup>
            {options.map((option, index) => (
              <Item
                key={option.label}
                variant="outline"
                size="xs"
                className="hover:bg-muted aria-pressed:border-ring aria-pressed:bg-muted text-left"
                aria-pressed={
                  answersOnClick ? undefined : (chosen[questionIndex] ?? []).includes(option.label)
                }
                aria-label={`${optionLetter(index)}. ${option.label}${option.recommended ? " (Recommended)" : ""}`}
                aria-describedby={
                  option.description ? `${descriptionId}-${questionIndex}-${index}` : undefined
                }
                onClick={() => choose(questionIndex, multiSelect, option.label)}
                render={<button type="button" disabled={pending} />}
              >
                <ItemMedia className="text-muted-foreground w-3 font-medium">
                  {optionLetter(index)}
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{option.label}</ItemTitle>
                  {option.description && (
                    <ItemDescription id={`${descriptionId}-${questionIndex}-${index}`}>
                      {option.description}
                    </ItemDescription>
                  )}
                </ItemContent>
                {option.recommended && (
                  <ItemActions>
                    <Badge variant="secondary">Recommended</Badge>
                  </ItemActions>
                )}
              </Item>
            ))}
          </ItemGroup>
        </fieldset>
      ))}
      {!answersOnClick && (
        <Button
          type="button"
          size="sm"
          disabled={pending || !complete}
          onClick={() => onAnswer(card.questions.map((_, index) => chosen[index] ?? []))}
        >
          Answer
        </Button>
      )}
    </>
  );
}
