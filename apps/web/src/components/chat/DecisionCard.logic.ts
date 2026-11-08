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

/** The display may be cleaned up, but answers retain the lead's exact option text. */
export function parseDecisionOption(raw: string) {
  const clean = raw.replace(/\(recommended\)/gi, "").trim();
  const separator = / [—–] /.exec(clean);
  return {
    value: raw,
    label: separator ? clean.slice(0, separator.index).trim() : clean,
    tradeoff: separator ? clean.slice(separator.index + separator[0].length).trim() : null,
    recommended: /\(recommended\)/i.test(raw),
  };
}
