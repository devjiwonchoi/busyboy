import { useImperativeHandle, useRef, useState } from "react";
import type { GraphViewProps } from "./GoalGraph";
import { GoalChips, toneClasses, waitingClass } from "./GoalGraphNodes";
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
            className={`flex items-center gap-2 border-l-[3px] p-3 ${goal.blocked ? "border-l-red-500" : "border-l-transparent"}`}
          >
            <button
              type="button"
              data-node-id={goal.id}
              data-goal-node={goal.id}
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
              <span className="truncate">{goal.title}</span>
              <span className="text-xs text-muted-foreground">
                {goal.done}/{goal.total}
              </span>
            </button>
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
                    <div className="flex items-center gap-2 px-2 py-1">
                      <button
                        type="button"
                        data-node-id={project.nodeId}
                        data-project-node={project.key}
                        className="flex-1 text-left text-xs font-medium"
                        onClick={() => openChat(project)}
                      >
                        {project.title}
                      </button>
                      {project.needsYou > 0 ? (
                        <button
                          type="button"
                          className={waitingClass}
                          onClick={(event) => {
                            event.stopPropagation();
                            openWaiting(project);
                          }}
                        >
                          나를 기다림
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
                        className={`my-1 flex flex-wrap items-center gap-1 border-l-[3px] px-2 py-1.5 ${toneClasses[task.tone]}`}
                        style={{ marginLeft: 12 + task.depth * 16 }}
                      >
                        <button
                          type="button"
                          data-node-id={task.nodeId}
                          data-task-node={task.id}
                          data-tone={task.tone}
                          data-blocked={task.tone === "blocked"}
                          className={`min-w-0 flex-1 text-left text-xs ${task.tone === "done" ? "line-through" : ""}`}
                          onClick={() => openTask(task)}
                        >
                          {task.live ? (
                            <span className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-blue-500" />
                          ) : null}
                          {task.key} {task.title}
                          {task.recent ? (
                            <span
                              title="24시간 안에 바뀜"
                              className="ml-1 inline-block size-1 rounded-full bg-primary align-middle"
                            />
                          ) : null}
                        </button>
                        {task.needsYou ? (
                          <button
                            type="button"
                            className={waitingClass}
                            onClick={(event) => {
                              event.stopPropagation();
                              openWaiting(task);
                            }}
                          >
                            나를 기다림
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
