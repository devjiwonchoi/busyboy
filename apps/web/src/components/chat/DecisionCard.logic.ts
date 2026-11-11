/** Keep the title readable as plain text while preserving markdown in the context. */
export function splitDecisionQuestion(text: string) {
  const lines = text.trim().split("\n");
  const codeSpans: string[] = [];
  const headline = (lines.shift() ?? "")
    .trim()
    // Protect literal code from the markdown cleanup, then restore it last.
    .replace(/(`+)(.*?)\1/g, (_match, _ticks, code: string) => {
      codeSpans.push(code);
      return `\u0000${codeSpans.length - 1}\u0000`;
    })
    .replace(/^#{1,6}\s+/, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(^|[^\w*_])(\*\*|__|\*|_)(?=\S)(.+?)(?<=\S)\2(?![\w*_])/g, "$1$3")
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => codeSpans[Number(index)]!);
  return { headline, context: lines.join("\n").trim() };
}

/** Long legacy paragraphs stay intact in the body rather than becoming a bold title. */
export function decisionQuestionPresentation({
  question,
  action,
  taskTitle,
}: {
  question: string;
  action: string | null | undefined;
  taskTitle: string;
}) {
  if (action) {
    return { headline: action, context: question };
  }

  const presentation = splitDecisionQuestion(question);
  if (presentation.headline.length > 120) {
    return { headline: `${taskTitle}에 대한 결정`, context: question };
  }

  return presentation;
}

/** The display may be cleaned up, but answers retain the lead's exact option text. */
export { parseRequestOption as parseDecisionOption } from "@t3tools/shared/requestMessage";
