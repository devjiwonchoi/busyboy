import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { taskRouteParams } from "~/taskRoutes";
import { ProjectFavicon } from "../ProjectFavicon";
import { StatusGlyphWithLabel } from "../sidebar/SidebarRowLine";
import { useLiveTaskStatus } from "../task/taskStatus";
import { type MapGoal, type MapProject, projectKey } from "./allProjects.logic";

/** Goals a card lists before "+N개 더": fewer on a phone. */
const GOALS_SHOWN_WIDE = 4;
const GOALS_SHOWN_NARROW = 2;

export interface MapWaitingLine {
  readonly key: string;
  readonly text: string;
}

/**
 * One project on the map: its direction, checks passed, goals with their
 * checklists, what it waits on, and now / next / needs-you.
 */
export function ProjectMapCard(props: {
  project: MapProject;
  info: EnvironmentProject | null;
  waiting: ReadonlyArray<MapWaitingLine>;
  dimmed: boolean;
  highlighted: boolean;
  onHoverChange: (hovered: boolean) => void;
  onOpenChat: () => void;
}) {
  const { project, info } = props;
  const { summary, progress, goals, needsYou } = project;
  const wide = useMediaQuery("sm");
  const [showAll, setShowAll] = useState(false);
  const [openGoalId, setOpenGoalId] = useState<string | null>(null);
  const limit = wide ? GOALS_SHOWN_WIDE : GOALS_SHOWN_NARROW;
  const shownGoals = showAll ? goals : goals.slice(0, limit);
  const hiddenCount = goals.length - shownGoals.length;
  const title = info?.title ?? "프로젝트";
  const running = summary.presence.running;

  const toggleGoal = (id: string) => setOpenGoalId((current) => (current === id ? null : id));

  return (
    <section
      aria-label={title}
      data-project-card={summary.projectId}
      data-map-key={projectKey(project.environmentId, summary.projectId)}
      // Arrows only show from two columns up; a phone tap must not leave a highlight behind.
      onMouseEnter={() => wide && props.onHoverChange(true)}
      onMouseLeave={() => wide && props.onHoverChange(false)}
      className={cn(
        "relative flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-card p-3 transition-opacity",
        props.highlighted && "border-ring ring-1 ring-ring",
        props.dimmed && "opacity-60",
      )}
    >
      <header data-project-card-head className="flex min-w-0 items-center gap-2">
        {info !== null ? <ProjectFavicon project={info} className="size-4" /> : null}
        <button
          type="button"
          onClick={props.onOpenChat}
          className="min-w-0 truncate text-left font-semibold text-sm outline-none hover:underline focus-visible:underline"
        >
          {title}
        </button>
        <span className="ml-auto shrink-0 text-muted-foreground text-xs">
          {running > 0 ? `● 작업 중 ${running}` : "○ 쉬는 중"}
        </span>
      </header>

      <p
        data-project-direction
        className={cn(
          "line-clamp-2 text-muted-foreground text-xs leading-relaxed",
          summary.direction === null && "italic opacity-70",
        )}
      >
        {summary.direction ?? "방향 미정 — PM에게 알려주세요"}
      </p>

      <div data-project-progress>
        {progress === null ? (
          <p className="text-muted-foreground text-xs">목표 없음</p>
        ) : (
          <>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.percent}
              aria-label={`체크 ${progress.passed}/${progress.total} 통과`}
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full bg-success" style={{ width: `${progress.percent}%` }} />
            </div>
            <div className="mt-1 flex justify-between text-muted-foreground text-xs">
              <span>
                체크 {progress.passed}/{progress.total} 통과
              </span>
              <span>{progress.percent}%</span>
            </div>
          </>
        )}
      </div>

      {goals.length > 0 ? (
        <ul className="flex flex-col gap-px">
          {shownGoals.map((goal) => (
            <GoalRow
              key={goal.task.id}
              project={project}
              goal={goal}
              open={openGoalId === goal.task.id}
              onToggle={() => toggleGoal(goal.task.id)}
            />
          ))}
          {hiddenCount > 0 ? (
            <li>
              <button
                type="button"
                data-goals-more
                onClick={() => setShowAll(true)}
                className="py-1 pl-6 text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:underline"
              >
                +{hiddenCount}개 더
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}

      {props.waiting.map((line) => (
        <p
          key={line.key}
          data-waiting-line
          className="text-orange-500 text-xs dark:text-orange-400"
        >
          ⏳ {line.text}
        </p>
      ))}

      <dl className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-y-1 border-border border-t pt-2.5 text-xs">
        <dt className="text-muted-foreground">지금</dt>
        <dd data-project-now className="truncate">
          {project.now.length > 0 ? project.now.join(" · ") : "—"}
        </dd>
        <dt className="text-muted-foreground">다음</dt>
        <dd data-project-next className="truncate">
          {project.next.length > 0 ? project.next.join(" · ") : "—"}
        </dd>
        <dt className={cn(needsYou.total > 0 ? "text-warning" : "text-muted-foreground")}>나</dt>
        <dd data-project-needs-you className="truncate">
          {needsYou.total > 0 ? (
            <button
              type="button"
              onClick={props.onOpenChat}
              className="text-warning outline-none hover:underline focus-visible:underline"
            >
              {needsYou.label} →
            </button>
          ) : (
            "—"
          )}
        </dd>
      </dl>
    </section>
  );
}

function GoalRow(props: {
  project: MapProject;
  goal: MapGoal;
  open: boolean;
  onToggle: () => void;
}) {
  const { project, goal } = props;
  const { task } = goal;
  const status = useLiveTaskStatus(project.environmentId, task);
  const done = goal.phase === "done";
  return (
    <li data-goal={task.id} data-goal-phase={goal.phase}>
      <button
        type="button"
        aria-expanded={props.open}
        onClick={props.onToggle}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs outline-none hover:bg-accent/60 focus-visible:bg-accent/60",
          props.open && "bg-muted",
        )}
      >
        <span className={cn("inline-flex shrink-0", status.className)}>
          <StatusGlyphWithLabel status={status} />
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-medium",
            done && "text-muted-foreground line-through",
          )}
        >
          {task.title}
        </span>
        {/* No checks yet: still being planned, whatever its stage. */}
        {goal.checks.length === 0 ? (
          <span className="shrink-0 rounded border border-border px-1 text-[10.5px] text-muted-foreground">
            계획 중
          </span>
        ) : (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {goal.passed}/{goal.checks.length}
          </span>
        )}
      </button>
      {props.open ? (
        <div data-goal-checklist className="mt-0.5 mb-1.5 ml-6 flex flex-col gap-1 text-xs">
          {goal.checks.length === 0 ? (
            <p className="text-muted-foreground">아직 체크가 없어요(계획 중).</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {goal.checks.map((check, index) => (
                <li
                  key={`${index}:${check.text}`}
                  data-check-passed={check.passed}
                  className={cn(check.passed ? "text-success" : "text-muted-foreground")}
                >
                  {check.passed ? "✓" : "○"} {check.text}
                </li>
              ))}
            </ul>
          )}
          <Link
            {...taskRouteParams(project.environmentId, project.summary.projectId, task.id)}
            className="self-start text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:underline"
          >
            열기 →
          </Link>
        </div>
      ) : null}
    </li>
  );
}
