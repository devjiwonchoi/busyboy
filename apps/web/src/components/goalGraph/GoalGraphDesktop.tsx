import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { GraphViewProps } from "./GoalGraph";
import { GoalChips, ProgressRing, PulseDot, toneClasses } from "./GoalGraphNodes";
import { layoutGoalGraph, relatedNodeIds } from "./goalGraph.logic";

/** Below this zoom only goals and projects show, as progress rings. */
const NEAR_SCALE = 0.7;

export function GoalGraphDesktop({ graph, ref, openChat, openTask }: GraphViewProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const marker = useId();
  const layout = useMemo(() => layoutGoalGraph(graph), [graph]);
  const [transform, setTransform] = useState({ x: 16, y: 16, scale: 1 });
  const [hovered, setHovered] = useState<string | null>(null);
  const related = hovered === null ? null : relatedNodeIds(graph, hovered);
  const far = transform.scale < NEAR_SCALE;
  const fit = useCallback(
    (minScale: number, maxScale: number) => {
      const rect = viewport.current?.getBoundingClientRect();
      if (rect === undefined) {
        return;
      }
      const fitScale = Math.min(
        (rect.width - 32) / layout.width,
        (rect.height - 32) / layout.height,
      );
      const scale = Math.max(minScale, Math.min(maxScale, fitScale));
      // Too big to fit at the smallest allowed zoom: start from the top left instead.
      setTransform(
        scale > fitScale
          ? { scale, x: 16, y: 16 }
          : {
              scale,
              x: (rect.width - layout.width * scale) / 2,
              y: Math.max(16, (rect.height - layout.height * scale) / 2),
            },
      );
    },
    [layout],
  );
  // Open with the whole graph in view, but never so small that tasks hide.
  const fitted = useRef(false);
  useLayoutEffect(() => {
    if (fitted.current) {
      return;
    }
    fitted.current = true;
    fit(NEAR_SCALE, 1);
  }, [fit]);
  const zoom = useCallback(
    (factor: number, x: number, y: number) =>
      setTransform((current) => {
        const scale = Math.max(0.3, Math.min(2, current.scale * factor));
        return {
          x: x - ((x - current.x) * scale) / current.scale,
          y: y - ((y - current.y) * scale) / current.scale,
          scale,
        };
      }),
    [],
  );
  const zoomAtCenter = (factor: number) => {
    const rect = viewport.current?.getBoundingClientRect();
    zoom(factor, (rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2);
  };
  // A non-passive listener consumes pinch gestures before the browser zooms the page.
  useEffect(() => {
    const element = viewport.current;
    if (element === null) {
      return;
    }
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = element.getBoundingClientRect();
        zoom(Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top);
      } else {
        setTransform((current) => ({
          ...current,
          x: current.x - event.deltaX,
          y: current.y - event.deltaY,
        }));
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [zoom]);
  useImperativeHandle(
    ref,
    () => ({
      focusNode: (id) => {
        const box = layout.boxes.find((node) => node.id === id);
        const rect = viewport.current?.getBoundingClientRect();
        if (box === undefined || rect === undefined) {
          return;
        }
        setTransform((current) => {
          const scale = id.startsWith("task:")
            ? Math.max(NEAR_SCALE, current.scale)
            : current.scale;
          return {
            scale,
            x: rect.width / 2 - (box.x + box.width / 2) * scale,
            y: rect.height / 2 - (box.y + box.height / 2) * scale,
          };
        });
      },
    }),
    [layout],
  );
  const dim = (id: string) => (related === null || related.has(id) ? 1 : 0.25);
  return (
    <div
      ref={viewport}
      data-zoom={far ? "far" : "near"}
      className="relative h-[70vh] min-h-64 touch-none overflow-hidden rounded-lg border bg-muted/10"
      onPointerDown={(event) => {
        if ((event.target as Element).closest("button") !== null || event.button !== 0) {
          return;
        }
        drag.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current === null) {
          return;
        }
        const dx = event.clientX - drag.current.x;
        const dy = event.clientY - drag.current.y;
        drag.current = { x: event.clientX, y: event.clientY };
        setTransform((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    >
      <div
        className="absolute inset-0"
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          transformOrigin: "0 0",
        }}
      >
        <svg
          width={layout.width}
          height={layout.height}
          className="absolute pointer-events-none overflow-visible"
          aria-hidden="true"
        >
          <defs>
            <marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8" fill="currentColor" className="text-red-500" />
            </marker>
          </defs>
          {layout.paths
            .filter((edge) => !far || edge.kind === "goal-project")
            .map((edge) => (
              <path
                key={edge.id}
                data-edge={edge.kind}
                data-from={edge.from}
                data-to={edge.to}
                data-blocked={edge.blocked}
                d={edge.d}
                fill="none"
                stroke="currentColor"
                strokeWidth={edge.kind === "parent" ? 1 : 1.5}
                strokeDasharray={edge.kind === "waits" ? "5 4" : undefined}
                markerEnd={edge.kind === "waits" ? `url(#${marker})` : undefined}
                className={edge.blocked ? "text-red-500" : "text-muted-foreground/40"}
                opacity={
                  related === null || (related.has(edge.from) && related.has(edge.to)) ? 1 : 0.25
                }
              />
            ))}
        </svg>
        {layout.boxes.map((box) => {
          const goal = graph.goals.find((node) => node.id === box.id);
          const project = graph.projects.find((node) => node.nodeId === box.id);
          const task = graph.tasks.find((node) => node.nodeId === box.id);
          if (far && task !== undefined) {
            return null;
          }
          const node = goal ?? project ?? task!;
          const blocked = goal?.blocked ?? project?.blocked ?? task?.tone === "blocked";
          return (
            <div
              key={box.id}
              onMouseEnter={() => setHovered(box.id)}
              onMouseLeave={() => setHovered(null)}
              style={{
                position: "absolute",
                left: box.x,
                top: box.y,
                width: box.width,
                height: box.height,
                opacity: dim(box.id),
              }}
              data-recent={node.recent}
              className={`flex items-center gap-2 rounded-lg border border-l-[3px] bg-card px-3 shadow-sm ${task !== undefined ? toneClasses[task.tone] : blocked ? "border-l-red-500" : "border-l-border"} ${goal?.id === "goal:none" ? "border-dashed text-muted-foreground" : ""} ${node.recent ? "ring-2 ring-primary/60" : ""}`}
            >
              <button
                type="button"
                data-goal-node={goal?.id}
                data-project-node={project?.key}
                data-task-node={task?.id}
                data-tone={task?.tone}
                data-blocked={blocked}
                className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-recent={node.recent}
                aria-label={goal?.title ?? project?.title ?? `${task?.key} ${task?.title}`}
                onClick={() => {
                  if (task !== undefined) {
                    openTask(task);
                  } else if (project !== undefined) {
                    openChat(project);
                  }
                }}
              />
              {far ? (
                <ProgressRing
                  done={goal?.done ?? project!.progress.done}
                  total={goal?.total ?? project!.progress.total}
                />
              ) : null}
              <div className="pointer-events-none min-w-0 flex-1">
                <div
                  className={`flex items-center gap-1 truncate ${far ? "text-sm" : "text-xs"} ${task?.tone === "done" ? "line-through" : ""}`}
                >
                  {node.live ? <PulseDot /> : null}
                  {task !== undefined ? (
                    <span className="text-muted-foreground">{task.key}</span>
                  ) : null}
                  <span className="truncate">{goal?.title ?? project?.title ?? task?.title}</span>
                </div>
                {node.changedLabel !== null ? (
                  <span className="block text-[10px] text-primary">{node.changedLabel}</span>
                ) : null}
                {task !== undefined && task.waitsOnKeys.length > 0 ? (
                  <span className="flex gap-1 text-[10px] text-red-500">
                    {task.waitsOnKeys.map((key) => (
                      <span key={key}>⏳ {key} 막힘</span>
                    ))}
                  </span>
                ) : null}
                {goal !== undefined || project !== undefined ? (
                  <span className="text-[10px] text-muted-foreground">
                    {goal?.done ?? project!.progress.done}/{goal?.total ?? project!.progress.total}
                  </span>
                ) : null}
                {goal !== undefined ? (
                  <span className="pointer-events-auto relative">
                    <GoalChips goal={goal} />
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="absolute bottom-3 right-3 flex rounded-lg border bg-card shadow-sm">
        <button
          type="button"
          aria-label="확대"
          className="px-3 py-2"
          onClick={() => zoomAtCenter(1.2)}
        >
          +
        </button>
        <button
          type="button"
          aria-label="축소"
          className="px-3 py-2"
          onClick={() => zoomAtCenter(1 / 1.2)}
        >
          −
        </button>
        <button type="button" className="px-3 py-2 text-xs" onClick={() => fit(0.3, 2)}>
          맞춤
        </button>
      </div>
    </div>
  );
}
