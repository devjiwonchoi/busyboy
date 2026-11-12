/**
 * Splits an assistant reply into the chunks a chat shows as separate bubbles.
 *
 * Paragraphs become their own bubbles. Code fences, lists, tables and quotes
 * stay whole, and a heading or a paragraph ending in ":" stays with the block
 * it introduces. Web and mobile both use this so a reply reads the same.
 */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const QUOTE = /^ {0,3}>/;
const INDENTED = /^(?: {2,}|\t)/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)\s*$/;
// Reference links and footnotes resolve across the whole reply, so a reply that
// defines them stays in one bubble.
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s/;
// A divider on its own reads as noise between bubbles, so it is dropped.
const THEMATIC_BREAK = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const IMAGE = /!\[[^\]]*\]\(/;

type BlockKind = "list" | "quote" | "other";
type Fence = { readonly char: string; readonly length: number };

/** The open code fence after `line`: opens on a marker, closes only on a bare marker. */
function fenceAfter(fence: Fence | null, line: string): Fence | null {
  const marker = FENCE_OPEN.exec(line)?.[1];
  if (marker === undefined) return fence;
  if (fence === null) return { char: marker[0]!, length: marker.length };
  const closes =
    marker[0] === fence.char && marker.length >= fence.length && line.trim() === marker;
  return closes ? null : fence;
}

function blockKind(line: string): BlockKind {
  // A divider such as "* * *" also looks like a list item; the divider wins.
  if (THEMATIC_BREAK.test(line)) return "other";
  if (LIST_ITEM.test(line)) return "list";
  if (QUOTE.test(line)) return "quote";
  return "other";
}

function staysWithPrevious(input: {
  readonly line: string;
  readonly previousBlockKind: BlockKind;
  readonly previousLine: string;
  readonly lineBeforePrevious: string;
}): boolean {
  const { line, previousBlockKind, previousLine, lineBeforePrevious } = input;
  const trimmedPrevious = previousLine.trim();
  if (THEMATIC_BREAK.test(line)) return false;
  if (HEADING.test(previousLine)) return true;
  if (SETEXT_UNDERLINE.test(previousLine) && lineBeforePrevious.trim().length > 0) return true;
  if (trimmedPrevious.endsWith(":")) return true;
  if (previousBlockKind === "list" && (LIST_ITEM.test(line) || INDENTED.test(line))) return true;
  if (previousBlockKind === "quote" && QUOTE.test(line)) return true;
  return false;
}

export function splitAssistantMarkdownIntoBubbles(markdown: string): string[] {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (hasReferenceDefinitionOutsideFences(lines)) {
    const whole = normalized.trim();
    return whole.length > 0 ? [whole] : [];
  }
  const chunks: string[][] = [];
  let current: string[] = [];
  let fence: Fence | null = null;
  let sawBlankLine = false;
  let previousBlockKind: BlockKind = "other";
  let previousLine = "";
  // The raw line right above `previousLine`; a setext underline only counts under text.
  let lineBeforePrevious = "";

  const flush = () => {
    if (current.some((line) => line.trim().length > 0)) chunks.push(current);
    current = [];
  };

  for (const [index, line] of lines.entries()) {
    const rawLineAbove = index > 0 ? lines[index - 1]! : "";
    if (fence !== null) {
      current.push(line);
      fence = fenceAfter(fence, line);
      lineBeforePrevious = rawLineAbove;
      previousLine = line;
      continue;
    }

    if (line.trim().length === 0) {
      if (current.length > 0) sawBlankLine = true;
      current.push(line);
      continue;
    }

    if (sawBlankLine) {
      if (!staysWithPrevious({ line, previousBlockKind, previousLine, lineBeforePrevious })) {
        flush();
      }
      sawBlankLine = false;
      // An indented line inside a list continues that list item.
      if (!(previousBlockKind === "list" && INDENTED.test(line))) {
        previousBlockKind = blockKind(line);
      }
    } else if (current.every((existing) => existing.trim().length === 0)) {
      previousBlockKind = blockKind(line);
    }

    current.push(line);
    fence = fenceAfter(fence, line);
    lineBeforePrevious = rawLineAbove;
    previousLine = line;
  }
  flush();

  return chunks
    .map((chunk) => trimBlankLines(chunk).join("\n"))
    .filter((chunk) => chunk.length > 0 && !THEMATIC_BREAK.test(chunk));
}

function hasReferenceDefinitionOutsideFences(lines: ReadonlyArray<string>): boolean {
  let fence: Fence | null = null;
  for (const line of lines) {
    if (fence === null && REFERENCE_DEFINITION.test(line)) return true;
    fence = fenceAfter(fence, line);
  }
  return false;
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim().length === 0) start += 1;
  while (end > start && lines[end - 1]!.trim().length === 0) end -= 1;
  return lines.slice(start, end);
}

const TABLE_DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** True when a bubble holds a code fence, a table or an image, so it takes the full row width. */
export function isWideBubbleChunk(chunk: string): boolean {
  const hasPipe = chunk.includes("|");
  return chunk
    .split("\n")
    .some(
      (line) =>
        FENCE_OPEN.test(line) || IMAGE.test(line) || (hasPipe && TABLE_DELIMITER_ROW.test(line)),
    );
}
