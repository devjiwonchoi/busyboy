import { CheckIcon, LoaderCircleIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  planTodoDependencyNumbers,
  type PlanTodoLike,
  type PlanTodoStatus,
  planTodoStatuses,
} from "./planView.logic";

const STATUS_LABEL: Record<PlanTodoStatus, string> = {
  done: "Done",
  current: "In progress",
  todo: "To do",
};

/** Dashed circle for todo, a spinner for the current step, a filled check for done. */
export function PlanTodoStatusIcon({ status }: { status: PlanTodoStatus }) {
  return (
    <span
      role="img"
      aria-label={STATUS_LABEL[status]}
      data-plan-todo-icon={status}
      className="mt-0.5 flex size-4 shrink-0 items-center justify-center"
    >
      {status === "done" ? (
        <span className="flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <CheckIcon className="size-3" strokeWidth={3} />
        </span>
      ) : status === "current" ? (
        <LoaderCircleIcon className="size-4 animate-spin text-primary motion-reduce:animate-none" />
      ) : (
        <span className="size-3.5 rounded-full border-[1.5px] border-muted-foreground/60 border-dashed" />
      )}
    </span>
  );
}

/**
 * The plan's steps as a Claude-style todo list in a bordered box: status circle, the step, a
 * grey "Done when" line and an "after N" chip for its dependencies. Each row is a
 * data-plan-section ("Step N") so review comments can quote it.
 */
export function PlanTodoList({
  todos,
  running,
  className,
  renderAction,
}: {
  todos: ReadonlyArray<PlanTodoLike>;
  /** True while the work runs: the next ready step spins. */
  running: boolean;
  className?: string;
  /** Extra control at the end of a row, such as "Open subtask". */
  renderAction?: (todo: PlanTodoLike, index: number) => ReactNode;
}) {
  if (todos.length === 0) return null;
  const statuses = planTodoStatuses(todos, running);
  return (
    <ol
      data-plan-todos
      className={cn("divide-y divide-border/70 rounded-lg border border-border/70", className)}
    >
      {todos.map((todo, index) => {
        const status = statuses[index]!;
        const deps = planTodoDependencyNumbers(todos, todo);
        return (
          <li
            key={todo.id}
            data-plan-todo={todo.id}
            data-plan-todo-status={status}
            className="flex items-start gap-2.5 px-3 py-2"
          >
            <PlanTodoStatusIcon status={status} />
            <div data-plan-section={`Step ${index + 1}`} className="min-w-0 flex-1 text-sm">
              <span
                className={cn(
                  "break-words",
                  status === "done" && "text-muted-foreground line-through",
                  status === "current" && "font-medium",
                )}
              >
                {todo.text}
              </span>
              {deps.length > 0 ? (
                <span
                  data-plan-todo-deps
                  className="ms-1.5 inline-flex items-center whitespace-nowrap rounded-full border border-border/70 px-1.5 align-[1px] text-[11px] text-muted-foreground"
                >
                  {`↳ after ${deps.join(", ")}`}
                </span>
              ) : null}
              {todo.doneWhen.trim().length > 0 ? (
                <p data-plan-todo-done-when className="mt-0.5 text-muted-foreground text-xs">
                  {`Done when: ${todo.doneWhen}`}
                </p>
              ) : null}
            </div>
            {renderAction?.(todo, index)}
          </li>
        );
      })}
    </ol>
  );
}
