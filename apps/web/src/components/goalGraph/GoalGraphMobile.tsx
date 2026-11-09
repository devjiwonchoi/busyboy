import { useImperativeHandle, useRef, useState } from "react";
import type { GraphViewProps } from "./GoalGraph";
import { GoalChips, PulseDot, toneClasses, waitingClass } from "./GoalGraphNodes";
import { treeOrder } from "./goalGraph.logic";

export function GoalGraphMobile({ graph, ref, openChat, openTask, openWaiting }: GraphViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(
    () =>
      new Set(
        graph.goals.filter((goal, index) => index === 0 || goal.blocked).map((goal) => goal.id),
      ),
  );
  useImperativeHandle(
    ref,
    () => ({
      focusNode: (id) => {
        const task = graph.tasks.find((node) => node.nodeId === id);
        const goalId =
          task?.goalIds[0] ??
          graph.goals.find((goal) => goal.id === id)?.id ??
          graph.edges.find((edge) => edge.to === id && edge.kind === "goal-project")?.from;
        if (goalId === undefined) {
          return;
        }
        setExpanded((current) => new Set([...current, goalId]));
        // Wait for the expanded tree to mount before locating its focused row.
        requestAnimationFrame(() => {
          const nodes = container.current?.querySelectorAll<HTMLElement>("[data-node-id]");
          const node = Array.from(nodes ?? []).find((element) => element.dataset.nodeId === id);
          node?.scrollIntoView({ block: "center", behavior: "smooth" });
        });
      },
    }),
    [graph],
  );
  return (
    <div ref={container} className="flex flex-col gap-3" data-goal-tree>
      {graph.goals.map((goal) => (
        <section
          key={goal.id}
          className={`overflow-hidden rounded-lg border bg-card ${goal.id === "goal:none" ? "border-dashed" : ""}`}
        >
          <div
            data-recent={goal.recent}
            className={`flex items-center gap-2 border-l-[3px] p-3 ${goal.recent ? "ring-2 ring-inset ring-primary/60" : ""} ${goal.blocked ? "border-l-red-500" : "border-l-transparent"}`}
          >
            <button
              type="button"
              data-node-id={goal.id}
              data-goal-node={goal.id}
              data-recent={goal.recent}
              data-blocked={goal.blocked}
              aria-expanded={expanded.has(goal.id)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
              onClick={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(goal.id)) {
                    next.delete(goal.id);
                  } else {
                    next.add(goal.id);
                  }
                  return next;
                })
              }
            >
              <span>{expanded.has(goal.id) ? "▾" : "▸"}</span>
              {goal.live ? <PulseDot /> : null}
              <span className="min-w-0">
                <span className="block truncate">{goal.title}</span>
                {goal.changedLabel !== null ? (
                  <span className="block text-[10px] text-primary">{goal.changedLabel}</span>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">
                {goal.done}/{goal.total}
              </span>
            </button>
            {goal.needsYou > 0 && goal.waitingTarget !== null ? (
              <button
                type="button"
                className={waitingClass}
                data-waiting-count={goal.needsYou}
                aria-label={`나를 기다림 ${goal.needsYou}`}
                onClick={() => openWaiting(goal.waitingTarget!)}
              >
                나를 기다림 {goal.needsYou}
              </button>
            ) : null}
            <GoalChips
              goal={goal}
              onProposals={() => {
                if (graph.director !== null) {
                  openChat({
                    environmentId: graph.director.environmentId,
                    pmThreadId: graph.director.summary.pmThreadId,
                  });
                }
              }}
            />
          </div>
          {expanded.has(goal.id)
            ? graph.projects
                .filter((project) =>
                  graph.edges.some((edge) => edge.from === goal.id && edge.to === project.nodeId),
                )
                .map((project) => (
                  <div key={project.key} className="ml-4 border-t py-2 pr-2">
                    <div
                      data-recent={project.recent}
                      className={`flex items-center gap-2 px-2 py-1 ${project.recent ? "ring-2 ring-primary/60" : ""}`}
                    >
                      <button
                        type="button"
                        data-node-id={project.nodeId}
                        data-project-node={project.key}
                        data-recent={project.recent}
                        className="flex-1 text-left text-xs font-medium"
                        onClick={() => openChat(project)}
                      >
                        {project.live ? <PulseDot /> : null} {project.title}
                        {project.changedLabel !== null ? (
                          <span className="block text-[10px] text-primary">
                            {project.changedLabel}
                          </span>
                        ) : null}
                      </button>
                      {project.needsYou > 0 ? (
                        <button
                          type="button"
                          className={waitingClass}
                          data-waiting-count={project.needsYou}
                          aria-label={`나를 기다림 ${project.needsYou}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            openWaiting(project.waitingTarget ?? project);
                          }}
                        >
                          나를 기다림 {project.needsYou}
                        </button>
                      ) : null}
                    </div>
                    {treeOrder(
                      graph.tasks.filter(
                        (task) => task.projectKey === project.key && task.goalIds.includes(goal.id),
                      ),
                    ).map((task) => (
                      <div
                        key={task.nodeId}
                        data-recent={task.recent}
                        className={`my-1 flex flex-wrap items-center gap-1 border-l-[3px] px-2 py-1.5 ${toneClasses[task.tone]} ${task.recent ? "ring-2 ring-primary/60" : ""}`}
                        style={{ marginLeft: 12 + task.depth * 16 }}
                      >
                        <button
                          type="button"
                          data-node-id={task.nodeId}
                          data-task-node={task.id}
                          data-recent={task.recent}
                          data-tone={task.tone}
                          data-blocked={task.tone === "blocked"}
                          className={`min-w-0 flex-1 text-left text-xs ${task.tone === "done" ? "line-through" : ""}`}
                          onClick={() => openTask(task)}
                        >
                          {task.live ? <PulseDot /> : null} {task.key} {task.title}
                          {task.changedLabel !== null ? (
                            <span className="block text-[10px] text-primary">
                              {task.changedLabel}
                            </span>
                          ) : null}
                        </button>
                        {task.needsYou ? (
                          <button
                            type="button"
                            className={waitingClass}
                            data-waiting-count={task.waitingCount}
                            aria-label={`나를 기다림 ${task.waitingCount}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              openWaiting(task);
                            }}
                          >
                            나를 기다림 {task.waitingCount}
                          </button>
                        ) : null}
                        {task.waitsOnKeys.map((key) => (
                          <span
                            key={key}
                            className="rounded bg-red-500/10 px-1 text-[10px] text-red-500"
                          >
                            ⏳ {key} 막힘
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                ))
            : null}
        </section>
      ))}
    </div>
  );
}
