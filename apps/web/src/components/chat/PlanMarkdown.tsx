import type { ProjectAttentionItem } from "@t3tools/contracts";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

const HIGHLIGHT_CLASS = "rounded-sm bg-warning/30 text-inherit";

/** Splits text nodes so each match of a quote becomes a <mark>. */
function splitText(value: string, needles: ReadonlyArray<string>): MdNode[] | null {
  const ranges: Array<[number, number]> = [];
  for (const needle of needles) {
    const at = value.indexOf(needle);
    if (at < 0) continue;
    const end = at + needle.length;
    if (ranges.some(([from, to]) => at < to && end > from)) continue;
    ranges.push([at, end]);
  }
  if (ranges.length === 0) return null;
  ranges.sort((a, b) => a[0] - b[0]);
  const nodes: MdNode[] = [];
  let cursor = 0;
  for (const [from, to] of ranges) {
    if (from > cursor) nodes.push({ type: "text", value: value.slice(cursor, from) });
    nodes.push({
      type: "text",
      value: value.slice(from, to),
      data: { hName: "mark", hProperties: { className: HIGHLIGHT_CLASS } },
    });
    cursor = to;
  }
  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

/**
 * Remark plugin that marks commented quotes in the rendered plan. A quote that runs across
 * list items or lines is matched line by line, so a multi-bullet selection still shows.
 */
function remarkPlanHighlights(quotes: ReadonlyArray<string>) {
  const needles = quotes
    .flatMap((quote) => quote.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return () => (tree: MdNode) => {
    const visit = (node: MdNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "text" && child.value !== undefined && child.data === undefined) {
          return splitText(child.value, needles) ?? [child];
        }
        visit(child);
        return [child];
      });
    };
    visit(tree);
  };
}

/**
 * Plan text as markdown, with the chat renderer and styles, tightened for cards and the
 * review modal. Raw HTML stays literal text.
 */
export function PlanMarkdown({
  text,
  highlights,
  className,
}: {
  text: string;
  /** Quotes with comments, shown highlighted. */
  highlights?: ReadonlyArray<string> | undefined;
  className?: string;
}) {
  const key = highlights?.join("\u0000") ?? "";
  const plugins = useMemo(() => (key ? [remarkPlanHighlights(key.split("\u0000"))] : []), [key]);
  return (
    <ChatMarkdown
      text={text}
      cwd={undefined}
      isStreaming={false}
      parseRawHtml={false}
      headingLevelOffset={3}
      extraRemarkPlugins={plugins}
      className={cn("text-foreground [&_li]:my-0.5 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1", className)}
    />
  );
}

/**
 * The Goal and Verification sections a lead writes for its plan approval card. An older
 * card holds one free-form summary, shown as Goal only.
 */
export function PlanApprovalSections({
  item,
  className,
}: {
  item: Pick<ProjectAttentionItem, "summary" | "verification" | "question">;
  className?: string;
}) {
  const goal = item.summary ?? item.question;
  const sections: Array<[string, string]> = [["Goal", goal]];
  if (item.verification !== null) sections.push(["Verification", item.verification]);
  return (
    <div data-plan-summary className={cn("flex flex-col gap-2", className)}>
      {sections.map(([label, text]) => (
        <section key={label} data-plan-summary-section={label}>
          <h4 className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
            {label}
          </h4>
          <PlanMarkdown text={text} />
        </section>
      ))}
    </div>
  );
}
