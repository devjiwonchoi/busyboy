import type { ProjectTaskCriterion, ProjectTaskFile } from "@t3tools/contracts";
import { ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { PlanMarkdown } from "../chat/PlanMarkdown";
import { Button } from "../ui/button";
import {
  FILE_CHANGE_LABEL,
  planBreakdownMermaid,
  planFileTree,
  type PlanFileNode,
  type PlanTodoLike,
  planTodoStatuses,
} from "./planView.logic";

/** Section heading shared by the review modal and the Plan tab. */
export function PlanSectionHeading({ children }: { children: string }) {
  return <h3 className="mb-1.5 font-semibold text-foreground text-sm">{children}</h3>;
}

function mermaidFence(source: string): string {
  // A longer fence than any backtick run inside keeps the block closed.
  const longest = Math.max(2, ...(source.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}mermaid\n${source.trim()}\n${fence}`;
}

/**
 * The prototype: the lead's throwaway HTML mockup in a sandboxed frame (no scripts, no
 * same-origin access), with a toggle for a taller view.
 */
export function PlanPrototype({ html, waiver }: { html: string; waiver: string }) {
  const [tall, setTall] = useState(false);
  if (html.trim().length === 0) {
    return waiver.trim().length > 0 ? (
      <p data-plan-prototype-waiver className="mt-2 text-muted-foreground text-xs">
        {`No prototype: ${waiver}`}
      </p>
    ) : null;
  }
  return (
    <div data-plan-prototype className="mt-3 overflow-hidden rounded-lg border border-border/70">
      <div className="flex items-center gap-2 border-b border-border/70 bg-muted/40 px-2.5 py-1">
        <span className="text-muted-foreground text-xs">Prototype</span>
        <Button
          size="xs"
          variant="ghost-muted"
          className="ms-auto"
          aria-pressed={tall}
          onClick={() => setTall(!tall)}
        >
          {tall ? "Shrink" : "Expand"}
        </Button>
      </div>
      <iframe
        title="Prototype"
        sandbox=""
        srcDoc={html}
        referrerPolicy="no-referrer"
        className={cn("block w-full bg-white", tall ? "h-[70dvh]" : "h-72 max-md:h-56")}
      />
    </div>
  );
}

/** The flow: the lead's Mermaid diagram, rendered like Mermaid blocks in chat. */
export function PlanFlow({ source }: { source: string }) {
  if (source.trim().length === 0) return null;
  return (
    <div data-plan-flow>
      <PlanMarkdown text={mermaidFence(source)} />
    </div>
  );
}

/** Success criteria as a checklist: checked once evidence exists, with how each is proven. */
export function PlanCriteria({ criteria }: { criteria: ReadonlyArray<ProjectTaskCriterion> }) {
  if (criteria.length === 0) return null;
  return (
    <ul data-plan-section="Success criteria" data-plan-criteria className="flex flex-col gap-1.5">
      {criteria.map((criterion) => {
        const proven = criterion.evidence !== null && criterion.evidence.trim().length > 0;
        return (
          <li
            key={criterion.id}
            data-plan-criterion={criterion.id}
            data-proven={proven || undefined}
            className="flex items-start gap-2 text-sm"
          >
            <input
              type="checkbox"
              checked={proven}
              readOnly
              disabled
              aria-label={criterion.text}
              className="mt-1 shrink-0"
            />
            <div className="min-w-0 flex-1">
              <span className="break-words">{criterion.text}</span>
              {criterion.provenBy.trim().length > 0 ? (
                <p className="text-muted-foreground text-xs">{`Proven by: ${criterion.provenBy}`}</p>
              ) : null}
              {proven ? (
                <p className="break-words text-success-foreground text-xs">{`Evidence: ${criterion.evidence}`}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The breakdown graph, generated from each step's dependencies. Null without any. */
export function PlanBreakdown({
  todos,
  running,
}: {
  todos: ReadonlyArray<PlanTodoLike>;
  running: boolean;
}) {
  const graph = planBreakdownMermaid(todos, planTodoStatuses(todos, running));
  if (graph === null) return null;
  return (
    <div data-plan-breakdown>
      <PlanMarkdown text={mermaidFence(graph)} />
    </div>
  );
}

const CHANGE_CLASS: Record<ProjectTaskFile["change"], string> = {
  new: "text-success-foreground border-success/40",
  changed: "text-warning-foreground border-warning/40",
  deleted: "text-destructive-foreground border-destructive/40",
};

/**
 * Every file the plan touches as a folder tree. Folders fold; picking a file shows why it
 * changes and which steps touch it.
 */
export function PlanFileTree({
  files,
  todos,
}: {
  files: ReadonlyArray<ProjectTaskFile>;
  todos: ReadonlyArray<PlanTodoLike>;
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  if (files.length === 0) return null;
  const tree = planFileTree(files);
  const stepNumber = new Map(todos.map((todo, index) => [todo.id, index + 1]));

  const toggle = (path: string) => {
    const next = new Set(closed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setClosed(next);
  };

  const renderNode = (node: PlanFileNode, depth: number) => {
    const indent = { paddingInlineStart: `${depth * 14 + 6}px` };
    if (node.kind === "folder") {
      const open = !closed.has(node.path);
      return (
        <li key={node.path} role="treeitem" aria-expanded={open} aria-selected={false}>
          <button
            type="button"
            data-plan-folder={node.path}
            className="flex w-full items-center gap-1 rounded py-0.5 pe-1.5 text-start text-sm hover:bg-accent"
            style={indent}
            onClick={() => toggle(node.path)}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90",
              )}
            />
            {open ? (
              <FolderOpenIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 truncate">{node.name}</span>
          </button>
          {open ? (
            <ul role="group">{node.children.map((child) => renderNode(child, depth + 1))}</ul>
          ) : null}
        </li>
      );
    }
    const file = node.file!;
    const isSelected = selected === node.path;
    const steps = file.todos.flatMap((id) => {
      const number = stepNumber.get(id);
      return number === undefined ? [] : [number];
    });
    return (
      <li key={node.path} role="treeitem" aria-selected={isSelected}>
        <button
          type="button"
          data-plan-file={node.path}
          className={cn(
            "flex w-full items-center gap-1 rounded py-0.5 pe-1.5 text-start text-sm hover:bg-accent",
            isSelected && "bg-accent",
            file.change === "deleted" && "text-muted-foreground line-through",
          )}
          style={{ paddingInlineStart: `${depth * 14 + 6 + 18}px` }}
          onClick={() => setSelected(isSelected ? null : node.path)}
        >
          <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-mono text-xs">{node.name}</span>
          <span
            className={cn(
              "ms-auto shrink-0 rounded-full border px-1.5 text-[10px] no-underline",
              CHANGE_CLASS[file.change],
            )}
          >
            {FILE_CHANGE_LABEL[file.change]}
          </span>
        </button>
        {isSelected ? (
          <div
            data-plan-file-detail
            className="mb-1 rounded-md bg-muted/50 px-2 py-1.5 text-xs"
            style={{ marginInlineStart: `${depth * 14 + 6 + 18}px` }}
          >
            <p className="break-all font-mono text-muted-foreground">{file.path}</p>
            {file.why.trim().length > 0 ? <p className="mt-0.5">{file.why}</p> : null}
            {steps.length > 0 ? (
              <p className="mt-0.5 text-muted-foreground">{`Steps: ${steps.join(", ")}`}</p>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <ul
      role="tree"
      aria-label="Files"
      data-plan-files
      className="rounded-lg border border-border/70 p-1"
    >
      {tree.map((node) => renderNode(node, 0))}
    </ul>
  );
}
