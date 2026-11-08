import { type RefObject, useEffect, useId, useState } from "react";

import { type MapArrow, type MapGoalRef, projectKey } from "./allProjects.logic";

interface DrawnArrow {
  readonly key: string;
  readonly arrow: MapArrow;
  readonly d: string;
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly mid: number;
}

/** A goal row, or its card's header while the row is folded under "+N개 더". */
function endpointBox(container: HTMLElement, end: MapGoalRef): Box | null {
  const card = container.querySelector<HTMLElement>(
    `[data-map-key="${CSS.escape(projectKey(end.environmentId, end.projectId))}"]`,
  );
  if (card === null) return null;
  const target =
    card.querySelector<HTMLElement>(`[data-goal="${CSS.escape(end.taskId)}"] > button`) ??
    card.querySelector<HTMLElement>("[data-project-card-head]");
  if (target === null) return null;
  const origin = container.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  return {
    left: rect.left - origin.left,
    right: rect.right - origin.left,
    mid: rect.top + rect.height / 2 - origin.top,
  };
}

/** A curve from the waiting goal to the awaited one, leaving and entering from the side. */
function arrowPath(from: Box, to: Box): string {
  const bend = 28;
  if (to.right <= from.left) {
    const x1 = from.left - 4;
    const x2 = to.right + 4;
    return `M${x1},${from.mid} C${x1 - bend},${from.mid} ${x2 + bend},${to.mid} ${x2},${to.mid}`;
  }
  if (to.left >= from.right) {
    const x1 = from.right + 4;
    const x2 = to.left - 4;
    return `M${x1},${from.mid} C${x1 + bend},${from.mid} ${x2 - bend},${to.mid} ${x2},${to.mid}`;
  }
  // Same column: loop out to the left.
  const x1 = from.left - 4;
  const x2 = to.left - 4;
  const out = Math.min(x1, x2) - bend * 1.5;
  return `M${x1},${from.mid} C${out},${from.mid} ${out},${to.mid} ${x2},${to.mid}`;
}

/**
 * Orange dashed arrows between goals in different projects, drawn over the map.
 * Hidden on one-column (phone) layouts, where cards say what they wait on instead.
 */
export function ProjectMapArrows(props: {
  containerRef: RefObject<HTMLElement | null>;
  arrows: ReadonlyArray<MapArrow>;
  /** The hovered card's projectKey; its arrows stay strong and the rest fade. */
  focusKey: string | null;
}) {
  const { containerRef, arrows } = props;
  // useId can hold characters that break url(#…); keep it to a plain name.
  const markerId = `map-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [drawn, setDrawn] = useState<ReadonlyArray<DrawnArrow>>([]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const measure = () => {
      const next: DrawnArrow[] = [];
      for (const arrow of arrows) {
        const from = endpointBox(container, arrow.from);
        const to = endpointBox(container, arrow.to);
        if (from === null || to === null) continue;
        next.push({
          key: `${arrow.from.taskId}->${arrow.to.taskId}`,
          arrow,
          d: arrowPath(from, to),
        });
      }
      // Same paths, same state: re-measuring must not re-render (and re-measure) forever.
      setDrawn((current) =>
        current.length === next.length &&
        current.every((item, index) => item.key === next[index]!.key && item.d === next[index]!.d)
          ? current
          : next,
      );
    };
    measure();
    // Cards resize when a goal unfolds or "+N개 더" opens; the container when the grid reflows.
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    for (const card of container.querySelectorAll("[data-project-card]")) observer.observe(card);
    return () => observer.disconnect();
  }, [containerRef, arrows]);

  if (drawn.length === 0) return null;
  return (
    <svg
      aria-hidden
      data-map-arrows
      className="pointer-events-none absolute inset-0 z-10 hidden size-full overflow-visible text-orange-500 sm:block dark:text-orange-400"
    >
      <defs>
        <marker
          id={markerId}
          markerWidth="8"
          markerHeight="8"
          refX="7"
          refY="4"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
        </marker>
      </defs>
      {drawn.map(({ key, arrow, d }) => {
        const focused =
          props.focusKey === null ||
          projectKey(arrow.from.environmentId, arrow.from.projectId) === props.focusKey ||
          projectKey(arrow.to.environmentId, arrow.to.projectId) === props.focusKey;
        return (
          <path
            key={key}
            data-map-arrow
            data-from={arrow.from.taskId}
            data-to={arrow.to.taskId}
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeDasharray="5 4"
            markerEnd={`url(#${markerId})`}
            opacity={focused ? 1 : 0.25}
          />
        );
      })}
    </svg>
  );
}
