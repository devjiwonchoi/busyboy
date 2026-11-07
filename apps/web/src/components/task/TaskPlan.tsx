import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProjectAttentionItem,
  ProjectId,
  ProjectTaskId,
  ProjectTaskSpec,
  ProjectTaskSpecVersion,
  ProjectTaskTodo,
  ProjectTeamTaskDetail,
} from "@t3tools/contracts";
import { approvalPlanOf, newProjectTaskTodo } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { GitPullRequestIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import {
  useProjectManager,
  useRestoreTaskSpec,
  useSplitTaskTodo,
  useTaskDetail,
  useUpdateTaskSpec,
} from "~/state/projectTeam";
import { taskRouteParams } from "~/taskRoutes";
import { DecisionCard } from "../chat/DecisionCard";
import { PlanSummary } from "../chat/PlanMarkdown";
import {
  PlanBreakdown,
  PlanCriteria,
  PlanFileTree,
  PlanFlow,
  PlanPrototype,
} from "../plan/PlanDocument";
import { planTodoDependencyNumbers } from "../plan/planView.logic";
import { StatusGlyph } from "../sidebar/SidebarRowLine";
import {
  WaitingMarker,
  SubtaskProgressBadge,
  TaskParentBreadcrumb,
  TaskStructure,
  useTaskRelations,
} from "./TaskRelations";
import { TaskPhaseBadge } from "./TaskPhaseBadge";
import { taskPhaseView } from "./taskPhase.logic";
import { useLiveTaskStatus } from "./taskStatus";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";

export interface TaskPlanProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly taskId: ProjectTaskId;
  readonly className?: string;
}

type SpecTextField = "background" | "goal" | "successCriteria" | "nonGoals";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function authorLabel(version: ProjectTaskSpecVersion, pmName: string | null): string {
  switch (version.author) {
    case "user":
      return "You";
    case "agent":
      return "Agent";
    case "pm":
      return pmName ?? "PM";
  }
}

const SECTION_HEADING =
  "mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide";

/**
 * A task's plan: its spec, todos, versions, PR and open questions. Shown beside the task
 * lead's chat, in a sheet on phones, and as the whole page for a task with no agent yet.
 */
export function TaskPlan(props: TaskPlanProps) {
  const { environmentId, projectId, taskId } = props;
  const query = useTaskDetail(environmentId, { projectId, taskId });
  const summary = useProjectManager(scopeProjectRef(environmentId, projectId));
  const detail = query.data;
  if (detail === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground text-sm">
        {query.error ?? "Loading task…"}
      </div>
    );
  }
  return (
    <TaskPlanBody
      key={detail.task.id}
      detail={detail}
      environmentId={environmentId}
      pmName={summary?.persona.name ?? null}
      pmThreadId={summary?.pmThreadId ?? null}
      className={props.className}
    />
  );
}

function TaskPlanBody(props: {
  detail: ProjectTeamTaskDetail;
  environmentId: EnvironmentId;
  pmName: string | null;
  pmThreadId: ProjectTeamTaskDetail["task"]["leadThreadId"];
  className?: string | undefined;
}) {
  const { detail, environmentId } = props;
  const { task, versions } = detail;
  const relations = useTaskRelations(environmentId, task.id);
  const updateTaskSpec = useUpdateTaskSpec();
  const restoreTaskSpec = useRestoreTaskSpec();
  const splitTaskTodo = useSplitTaskTodo();
  const latest = versions.at(-1)!;
  const planFor = (item: ProjectAttentionItem) => {
    const pinned = versions.find((version) => version.version === item.specVersion);
    return item.kind === "approval" && pinned !== undefined ? approvalPlanOf(pinned.spec) : null;
  };
  // Null shows the latest version; a number pins an older one, read-only.
  const [viewedVersion, setViewedVersion] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Pick<ProjectTaskSpec, SpecTextField>>(latest.spec);
  const [newTodo, setNewTodo] = useState("");

  const shown = versions.find((version) => version.version === viewedVersion) ?? latest;
  const isLatest = shown.version === latest.version;
  const previous = versions.find((version) => version.version === shown.version - 1) ?? null;
  const spec = shown.spec;
  const status = useLiveTaskStatus(environmentId, {
    ...task,
    openQuestion: detail.openAttention.length > 0,
    openBlocker: detail.openAttention.some((item) => item.kind === "blocker"),
    ready: task.ready !== null,
  });
  const archived = task.stage === "done" || task.stage === "cancelled";
  const ref = { projectId: task.projectId, taskId: task.id };

  const viewVersion = (version: number) => {
    setViewedVersion(version === latest.version ? null : version);
    setEditing(false);
  };

  const save = (next: ProjectTaskSpec, note: string) =>
    updateTaskSpec(environmentId, { ...ref, baseVersion: latest.version, spec: next, note });

  const toggleTodo = (todo: ProjectTaskTodo) =>
    save(
      {
        ...latest.spec,
        todos: latest.spec.todos.map((candidate) =>
          candidate.id === todo.id ? { ...candidate, done: !candidate.done } : candidate,
        ),
      },
      `${todo.done ? "Unchecked" : "Checked"} "${todo.text}"`,
    );

  const addTodo = () => {
    const text = newTodo.trim();
    if (text.length === 0) return;
    setNewTodo("");
    void save(
      {
        ...latest.spec,
        todos: [...latest.spec.todos, newProjectTaskTodo(`t${Date.now().toString(36)}`, text)],
      },
      `Added "${text}"`,
    );
  };

  const changed = (field: SpecTextField) =>
    previous !== null && previous.spec[field] !== spec[field];
  const previousTodoIds = new Set(previous?.spec.todos.map((todo) => todo.id) ?? []);

  const section = (label: string, field: SpecTextField) => (
    <section className="mt-5">
      <h2 className={SECTION_HEADING}>{label}</h2>
      {editing && isLatest ? (
        <Textarea
          aria-label={label}
          value={draft[field]}
          onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
          rows={field === "background" ? 5 : 3}
        />
      ) : (
        <p
          data-changed={changed(field) || undefined}
          className={cn(
            "whitespace-pre-wrap text-sm",
            changed(field) && "-ml-2.5 border-success border-l-2 pl-2",
            spec[field].trim().length === 0 && "text-muted-foreground",
          )}
        >
          {spec[field].trim().length === 0 ? "—" : spec[field]}
        </p>
      )}
    </section>
  );

  return (
    <div className={cn("min-w-0", props.className)} data-testid="task-plan">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-muted-foreground text-sm">{detail.key}</span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
            status.className,
          )}
          data-testid="task-status"
          data-status={status.status}
        >
          <StatusGlyph icon={status.icon} />
          {status.label}
        </span>
        <TaskPhaseBadge view={taskPhaseView({ ...task, status: status.status })} />
        {relations?.progress ? <SubtaskProgressBadge progress={relations.progress} /> : null}
        <WaitingMarker blockedBy={relations?.blockedBy ?? []} />
        <div className="ml-auto">
          <Select
            value={String(shown.version)}
            onValueChange={(value) => viewVersion(Number(value))}
          >
            <SelectTrigger size="xs" aria-label="Spec version">
              <SelectValue>{`v${shown.version} · ${authorLabel(shown, props.pmName)}`}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {versions.map((version) => (
                <SelectItem key={version.version} value={String(version.version)}>
                  {`v${version.version} · ${authorLabel(version, props.pmName)} · ${formatTime(version.createdAt)}`}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>

      <div className="mt-2">
        <TaskParentBreadcrumb relations={relations} />
      </div>
      <h1 className="font-semibold text-lg leading-snug">{task.title}</h1>

      {task.prUrl === null ? null : (
        <a
          href={task.prUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-flex items-center gap-1 text-primary text-sm underline-offset-2 hover:underline"
        >
          <GitPullRequestIcon aria-hidden className="size-3.5" />
          Pull request
        </a>
      )}

      {isLatest ? (
        <div className="mt-2 flex gap-2">
          {editing ? (
            <>
              <Button
                size="xs"
                onClick={() => {
                  setEditing(false);
                  void save({ ...latest.spec, ...draft }, "Edited by the user");
                }}
              >
                Save
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setDraft(latest.spec);
                setEditing(true);
              }}
            >
              Edit
            </Button>
          )}
        </div>
      ) : (
        <div
          role="status"
          className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
        >
          <span>
            Viewing v{shown.version} ({shown.note}). Read-only.
          </span>
          <Button
            size="xs"
            onClick={() => {
              void restoreTaskSpec(environmentId, { ...ref, version: shown.version });
              setViewedVersion(null);
            }}
          >
            Restore this version
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setViewedVersion(null)}>
            Back to latest
          </Button>
        </div>
      )}

      {props.pmThreadId !== null && detail.openAttention.length > 0 ? (
        <section className="mt-5 flex flex-col gap-3" aria-label="Waiting on you">
          {detail.openAttention.map((item) => (
            <DecisionCard
              key={item.id}
              card={{ item, taskNumber: task.number, taskTitle: task.title, plan: planFor(item) }}
              environmentId={environmentId}
              threadRef={scopeThreadRef(environmentId, props.pmThreadId!)}
              cwd={undefined}
            />
          ))}
        </section>
      ) : null}

      {spec.summary.trim().length > 0 ? (
        <section className="mt-5">
          <h2 className={SECTION_HEADING}>Summary</h2>
          <PlanSummary text={spec.summary} />
        </section>
      ) : null}

      {section("End result", "goal")}
      {editing ? null : <PlanPrototype html={spec.prototype} waiver={spec.prototypeWaiver} />}
      {spec.flow.trim().length > 0 ? (
        <section className="mt-5">
          <h2 className={SECTION_HEADING}>Flow</h2>
          <PlanFlow source={spec.flow} />
        </section>
      ) : null}
      {spec.criteria.length > 0 && !editing ? (
        <section className="mt-5">
          <h2 className={SECTION_HEADING}>
            {`Success criteria · ${spec.criteria.filter((criterion) => criterion.evidence !== null).length}/${spec.criteria.length}`}
          </h2>
          <PlanCriteria criteria={spec.criteria} />
        </section>
      ) : (
        section("Success criteria", "successCriteria")
      )}
      {section("Non-goals", "nonGoals")}

      <section className="mt-5">
        <h2 className={SECTION_HEADING}>
          Todos
          {spec.todos.length > 0
            ? ` · ${spec.todos.filter((todo) => todo.done).length}/${spec.todos.length}`
            : null}
        </h2>
        {spec.todos.length === 0 ? <p className="text-muted-foreground text-sm">None yet</p> : null}
        <ul className="flex flex-col gap-1">
          {spec.todos.map((todo) => (
            <li
              key={todo.id}
              data-changed={(previous !== null && !previousTodoIds.has(todo.id)) || undefined}
              className={cn(
                "flex items-start gap-2 text-sm",
                previous !== null &&
                  !previousTodoIds.has(todo.id) &&
                  "-ml-2.5 border-success border-l-2 pl-2",
              )}
            >
              <Checkbox
                aria-label={todo.text}
                className="mt-0.5"
                checked={todo.done}
                disabled={!isLatest}
                onCheckedChange={() => void toggleTodo(todo)}
              />
              <div className="min-w-0 flex-1">
                <span className={cn(todo.done && "text-muted-foreground line-through")}>
                  {todo.text}
                </span>
                {todo.dependsOn.length > 0 ? (
                  <span
                    data-plan-todo-deps
                    className="ms-1.5 inline-flex whitespace-nowrap rounded-full border border-border/70 px-1.5 text-[11px] text-muted-foreground"
                  >
                    {`↳ after ${planTodoDependencyNumbers(spec.todos, todo).join(", ")}`}
                  </span>
                ) : null}
                {todo.doneWhen.trim().length > 0 ? (
                  <p className="text-muted-foreground text-xs">{`Done when: ${todo.doneWhen}`}</p>
                ) : null}
              </div>
              {todo.subtaskId !== null ? (
                <Link
                  {...taskRouteParams(environmentId, task.projectId, todo.subtaskId)}
                  className="shrink-0 text-primary text-xs underline-offset-2 hover:underline"
                >
                  Open subtask
                </Link>
              ) : isLatest && !todo.done ? (
                <Button
                  size="xs"
                  variant="ghost"
                  className="shrink-0"
                  onClick={() => void splitTaskTodo(environmentId, { ...ref, todoId: todo.id })}
                >
                  Split into task
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {isLatest ? (
          <form
            className="mt-2 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              addTodo();
            }}
          >
            <Input
              aria-label="New todo"
              placeholder="Add todo"
              value={newTodo}
              onChange={(event) => setNewTodo(event.target.value)}
            />
            <Button size="sm" type="submit" variant="outline">
              Add
            </Button>
          </form>
        ) : null}
      </section>

      {spec.todos.some((todo) => todo.dependsOn.length > 0) ? (
        <section className="mt-5">
          <h2 className={SECTION_HEADING}>Breakdown</h2>
          <PlanBreakdown todos={spec.todos} running={task.stage === "running"} />
        </section>
      ) : null}

      {spec.files.length > 0 ? (
        <section className="mt-5">
          <h2 className={SECTION_HEADING}>Files</h2>
          <PlanFileTree files={spec.files} todos={spec.todos} />
        </section>
      ) : null}

      <TaskStructure relations={relations} className="mt-5" />

      {section("Background", "background")}

      <section className="mt-5">
        <h2 className={SECTION_HEADING}>History</h2>
        <ol aria-label="Spec history">
          {versions.toReversed().map((version) => (
            <li key={version.version} className="flex items-start gap-2 border-b py-1.5 text-sm">
              <span className="w-7 shrink-0 font-mono font-semibold">v{version.version}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  <span className="font-medium">{authorLabel(version, props.pmName)}</span> ·{" "}
                  {version.note}
                </div>
                <div className="text-muted-foreground text-xs">{formatTime(version.createdAt)}</div>
              </div>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`View v${version.version}`}
                onClick={() => viewVersion(version.version)}
              >
                View
              </Button>
            </li>
          ))}
        </ol>
      </section>

      {archived ? (
        <p className="mt-6 text-muted-foreground text-sm">
          Archived. The agent sessions and worktree are closed; the spec and history stay here.
        </p>
      ) : null}

      {task.stage === "inbox" && detail.sessions.length === 0 ? (
        <p className="mt-6 text-muted-foreground text-sm">Saved without an agent.</p>
      ) : null}
    </div>
  );
}
