import { parseLeadAnswer, parseLeadQuestion } from "@t3tools/contracts";

/** The fields of a lead-thread message the side chat reads. */
export interface LeadThreadMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly streaming: boolean;
}

export type CardSideChatEntry =
  | {
      readonly kind: "question";
      readonly id: string;
      readonly quotes: ReadonlyArray<string>;
      readonly question: string;
    }
  | {
      readonly kind: "answer";
      readonly id: string;
      readonly text: string;
      readonly streaming: boolean;
    };

/**
 * One card's side chat out of the lead thread: its questions, and the lead's "[답변]" replies.
 * A reply names the card it answers; a finished one that doesn't answers the oldest question
 * still waiting. The lead's other work and other cards' conversations stay out.
 */
export function selectLeadQuestionThread(
  messages: ReadonlyArray<LeadThreadMessage>,
  cardId: string,
): ReadonlyArray<CardSideChatEntry> {
  const entries: CardSideChatEntry[] = [];
  // The cards of questions still waiting for a reply, oldest first.
  const waiting: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const parsed = parseLeadQuestion(message.text);
      if (parsed === null || parsed.cardId === null) continue;
      waiting.push(parsed.cardId);
      if (parsed.cardId === cardId) {
        entries.push({
          kind: "question",
          id: message.id,
          quotes: parsed.quotes,
          question: parsed.question,
        });
      }
    } else if (message.role === "assistant") {
      const answer = parseLeadAnswer(message.text);
      // A reply still streaming in before its card line is complete waits, so it never
      // shows on the wrong card for a moment; only a finished reply falls back to order.
      if (answer === null || (answer.cardId === null && message.streaming)) continue;
      const answered = answer.cardId ?? waiting[0];
      if (answered === undefined) continue;
      const index = waiting.indexOf(answered);
      if (index >= 0) waiting.splice(index, 1);
      if (answered === cardId) {
        entries.push({
          kind: "answer",
          id: message.id,
          text: answer.text,
          streaming: message.streaming,
        });
      }
    }
  }
  return entries;
}
