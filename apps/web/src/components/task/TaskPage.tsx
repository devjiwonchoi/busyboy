import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProjectId,
  ProjectTaskId,
  ProjectTaskSession,
  ProjectTaskSpec,
  ProjectTaskSpecVersion,
  ProjectTaskTodo,
  ProjectTeamTaskDetail,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
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
import ChatView from "../ChatView";
import { DecisionCard } from "../chat/DecisionCard";
import { StatusGlyph } from "../sidebar/SidebarRowLine";
import { useLiveTaskStatus } from "./taskStatus";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export interface TaskPageProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly taskId: ProjectTaskId;
}

const HISTORY_TAB = "history";

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

function sessionLabels(sessions: ReadonlyArray<ProjectTaskSession>): ReadonlyArray<string> {
  let implementers = 0;
  return sessions.map((session) => {
    if (session.role === "implementer") {
      implementers += 1;
      return `Implementer #${implementers}`;
    }
    return "Planner";
  });
}

/** A task's spec on the left and the agent sessions working on it on the right. */
export function TaskPage(props: TaskPageProps) {
  const { environmentId, projectId, taskId } = props;
  const query = useTaskDetail(environmentId, { projectId, taskId });
  const summary = useProjectManager(scopeProjectRef(environmentId, projectId));
  const detail = query.data;
  // Null shows the latest version; a number pins an older one, read-only.
  const [viewedVersion, setViewedVersion] = useState<number | null>(null);
  if (detail === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
        {query.error ?? "Loading task…"}
      </div>
    );
  }
  return (
    // Side by side on wide screens; stacked and scrolling as one page on phones.
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-visible"
      data-testid="task-page"
    >
      <SpecPane
        detail={detail}
        environmentId={environmentId}
        pmName={summary?.persona.name ?? null}
        pmThreadId={summary?.pmThreadId ?? null}
        viewedVersion={viewedVersion}
        onViewVersion={setViewedVersion}
      />
      <SessionPane
        detail={detail}
        environmentId={environmentId}
        pmName={summary?.persona.name ?? null}
        onViewVersion={setViewedVersion}
      />
    </div>
  );
}

function SpecPane(props: {
  detail: ProjectTeamTaskDetail;
  environmentId: EnvironmentId;
  pmName: string | null;
  pmThreadId: ProjectTeamTaskDetail["task"]["leadThreadId"];
  viewedVersion: number | null;
  onViewVersion: (version: number | null) => void;
}) {
  const { detail, environmentId } = props;
  const { task, versions } = detail;
  const updateTaskSpec = useUpdateTaskSpec();
  const restoreTaskSpec = useRestoreTaskSpec();
  const splitTaskTodo = useSplitTaskTodo();
  const latest = versions.at(-1)!;
  const { viewedVersion, onViewVersion: setViewedVersion } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Pick<ProjectTaskSpec, "background" | "goal" | "nonGoals">>(
    latest.spec,
  );
  const [newTodo, setNewTodo] = useState("");

  const shown = versions.find((version) => version.version === viewedVersion) ?? latest;
  const isLatest = shown.version === latest.version;
  const previous = versions.find((version) => version.version === shown.version - 1) ?? null;
  const spec = shown.spec;
  const status = useLiveTaskStatus(environmentId, {
    ...task,
    openQuestion: detail.openAttention.length > 0,
  });
  const archived = task.stage === "done" || task.stage === "cancelled";
  const ref = { projectId: task.projectId, taskId: task.id };

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
        todos: [
          ...latest.spec.todos,
          { id: `t${Date.now().toString(36)}`, text, done: false, subtaskId: null },
        ],
      },
      `Added "${text}"`,
    );
  };

  const changed = (field: "background" | "goal" | "nonGoals") =>
    previous !== null && previous.spec[field] !== spec[field];
  const previousTodoIds = new Set(previous?.spec.todos.map((todo) => todo.id) ?? []);

  const section = (label: string, field: "background" | "goal" | "nonGoals") => (
    <section className="mt-5">
      <h2 className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
        {label}
      </h2>
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
    <div className="min-w-0 shrink-0 border-b px-5 pt-14 pb-6 md:flex-[1.2] md:shrink md:overflow-y-auto md:border-r md:border-b-0 md:px-7 md:pt-6">
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
        {task.parentTaskId === null ? null : (
          <Link
            {...taskRouteParams(environmentId, task.projectId, task.parentTaskId)}
            className="rounded-full border px-2 py-0.5 text-muted-foreground text-xs hover:text-foreground"
          >
            Parent task
          </Link>
        )}
        {detail.children.length > 0 ? (
          <span className="rounded-full border px-2 py-0.5 text-muted-foreground text-xs">
            Subtasks {detail.children.length}
          </span>
        ) : null}
        {detail.sessions.length > 0 ? (
          <span className="rounded-full border px-2 py-0.5 text-muted-foreground text-xs">
            Agents {detail.sessions.length}
          </span>
        ) : null}
        <div className="ml-auto">
          <Select
            value={String(shown.version)}
            onValueChange={(value) => {
              const version = Number(value);
              setViewedVersion(version === latest.version ? null : version);
              setEditing(false);
            }}
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

      <h1 className="mt-2 font-semibold text-xl">{task.title}</h1>

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

      {section("Background", "background")}
      {section("Goal", "goal")}
      {section("Non-goals", "nonGoals")}

      <section className="mt-5">
        <h2 className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
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
                "flex items-center gap-2 text-sm",
                previous !== null &&
                  !previousTodoIds.has(todo.id) &&
                  "-ml-2.5 border-success border-l-2 pl-2",
              )}
            >
              <Checkbox
                aria-label={todo.text}
                checked={todo.done}
                disabled={!isLatest}
                onCheckedChange={() => void toggleTodo(todo)}
              />
              <span className={cn(todo.done && "text-muted-foreground line-through")}>
                {todo.text}
              </span>
              {todo.subtaskId !== null ? (
                <Link
                  {...taskRouteParams(environmentId, task.projectId, todo.subtaskId)}
                  className="text-primary text-xs underline-offset-2 hover:underline"
                >
                  Open subtask
                </Link>
              ) : isLatest && !todo.done ? (
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
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

      {archived ? (
        <p className="mt-6 text-muted-foreground text-sm">
          Archived. The agent sessions and worktree are closed; the spec and history stay here.
        </p>
      ) : null}

      {task.stage === "inbox" && detail.sessions.length === 0 ? (
        <p className="mt-6 text-muted-foreground text-sm">Saved without an agent.</p>
      ) : null}

      {props.pmThreadId !== null && detail.openAttention.length > 0 ? (
        <section className="mt-6 flex flex-col gap-3" aria-label="Waiting on you">
          {detail.openAttention.map((item) => (
            <DecisionCard
              key={item.id}
              card={{ item, taskNumber: task.number, taskTitle: task.title }}
              environmentId={environmentId}
              threadRef={scopeThreadRef(environmentId, props.pmThreadId!)}
              cwd={undefined}
            />
          ))}
        </section>
      ) : null}
    </div>
  );
}

function SessionPane(props: {
  detail: ProjectTeamTaskDetail;
  environmentId: EnvironmentId;
  pmName: string | null;
  onViewVersion: (version: number | null) => void;
}) {
  const { detail, environmentId } = props;
  const labels = sessionLabels(detail.sessions);
  const defaultTab = detail.sessions.at(-1)?.threadId ?? HISTORY_TAB;
  const [tab, setTab] = useState<string>(defaultTab);
  const selected = detail.sessions.find((session) => session.threadId === tab) ?? null;
  const activeTab = selected === null ? HISTORY_TAB : tab;

  return (
    <div className="flex min-h-[70vh] flex-1 flex-col md:min-h-0 md:min-w-80">
      <div className="border-b px-3 py-2">
        <ToggleGroup
          aria-label="Task sessions"
          variant="segmented"
          value={[activeTab]}
          onValueChange={(value) => {
            const next = value[0];
            if (next !== undefined) setTab(next);
          }}
        >
          {detail.sessions.map((session, index) => (
            <Toggle key={session.threadId} value={session.threadId}>
              {labels[index]}
            </Toggle>
          ))}
          <Toggle value={HISTORY_TAB}>History</Toggle>
        </ToggleGroup>
      </div>
      {selected === null ? (
        <ol className="flex-1 overflow-y-auto px-4 py-3" aria-label="Spec history">
          {detail.versions.toReversed().map((version) => (
            <li key={version.version} className="flex items-start gap-3 border-b py-2 text-sm">
              <span className="w-8 shrink-0 font-mono font-semibold">v{version.version}</span>
              <div className="min-w-0 flex-1">
                <div>
                  <span className="font-medium">{authorLabel(version, props.pmName)}</span> ·{" "}
                  {version.note}
                </div>
                <div className="text-muted-foreground text-xs">{formatTime(version.createdAt)}</div>
              </div>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`View v${version.version}`}
                onClick={() =>
                  props.onViewVersion(
                    version.version === detail.versions.at(-1)?.version ? null : version.version,
                  )
                }
              >
                View
              </Button>
            </li>
          ))}
        </ol>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ChatView
            key={selected.threadId}
            sideChat
            routeKind="server"
            environmentId={environmentId}
            threadId={selected.threadId}
          />
        </div>
      )}
    </div>
  );
}
