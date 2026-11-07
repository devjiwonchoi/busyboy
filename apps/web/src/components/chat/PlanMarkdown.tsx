import type { ProjectAttentionItem } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";

/**
 * Plan text as markdown, with the chat renderer and styles, tightened for cards and the
 * review modal. Raw HTML stays literal text.
 */
export function PlanMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <ChatMarkdown
      text={text}
      cwd={undefined}
      isStreaming={false}
      parseRawHtml={false}
      headingLevelOffset={3}
      className={cn("text-foreground [&_li]:my-0.5 [&_ol]:my-1 [&_p]:my-1 [&_ul]:my-1", className)}
    />
  );
}

/** The lead's summary: markdown, so bold key phrases stay bold. Commentable as "Summary". */
export function PlanSummary({ text, className }: { text: string; className?: string }) {
  if (text.trim().length === 0) return null;
  return (
    <div data-plan-section="Summary" data-plan-summary-text className={className}>
      <PlanMarkdown text={text} className="text-sm leading-relaxed" />
    </div>
  );
}

/** Turns plain bullets into unchecked task items, so Verification reads as a checklist. */
export function asChecklist(text: string): string {
  return text.replace(/^(\s*)[-*+]\s+(?!\[[ xX]\]\s)/gm, "$1- [ ] ");
}

/**
 * The Goal and Verification sections a lead writes for its plan approval card, laid out like
 * a doc: "## Goal", then "## Verification" as a read-only checklist. An older card holds one
 * free-form summary, shown as Goal only.
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
  if (item.verification !== null) sections.push(["Verification", asChecklist(item.verification)]);
  return (
    <div data-plan-summary className={cn("flex flex-col gap-3", className)}>
      {sections.map(([label, text]) => (
        <section key={label} data-plan-summary-section={label} data-plan-section={label}>
          <h3 className="font-semibold text-foreground text-sm">{label}</h3>
          <PlanMarkdown text={text} />
        </section>
      ))}
    </div>
  );
}

/** "# <task title>" with a small meta line above it, for the card and the modal. */
export function PlanTitle({
  title,
  meta,
  as: Heading = "h2",
  className,
}: {
  title: string;
  meta: string;
  as?: "h2" | "div";
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <p data-plan-meta className="truncate text-muted-foreground text-xs">
        {meta}
      </p>
      <Heading data-plan-title className="font-semibold text-lg leading-snug">
        {title}
      </Heading>
    </div>
  );
}
