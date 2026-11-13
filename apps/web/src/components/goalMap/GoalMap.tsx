import {
  type GoalMap as GoalMapData,
  type GoalMapGoal,
  type GoalMapTask,
  type GoalMapTransform,
  GOAL_MAP_LAYOUT,
  fitTransform,
  zoomToGoal,
} from "@t3tools/shared/goalMap";
import { useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { taskRouteParams } from "~/taskRoutes";

const L = GOAL_MAP_LAYOUT;
/** Never blow the map up past this on wide screens; text would get huge. */
const MAX_FIT_SCALE = 1.1;
/** Below this the desktop map scrolls instead of shrinking further. */
const MIN_DESKTOP_SCALE = 0.85;
/** Smallest on-screen size of the goal text; the phone overview scales it up to this. */
const MIN_TEXT_PX = 10;
const ZOOM_MS = 280;

type ViewBox = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number };

/** Rough text width for clipping labels; Hangul is about one em wide. */
function textWidth(text: string, size: number): number {
  let ems = 0;
  for (const char of text) {
    ems += /[ᄀ-ᇿ㄰-㆏가-힯]/.test(char) ? 0.94 : /[A-Z0-9#]/.test(char) ? 0.62 : 0.5;
  }
  return ems * size;
}

function fitText(text: string, maxWidth: number, size: number): string {
  if (textWidth(text, size) <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 1 && textWidth(`${chars.join("").trimEnd()}…`, size) > maxWidth) {
    chars.pop();
  }
  return `${chars.join("").trimEnd()}…`;
}

function toViewBox(transform: GoalMapTransform, viewport: Size): ViewBox {
  return {
    x: -transform.x / transform.scale,
    y: -transform.y / transform.scale,
    width: viewport.width / transform.scale,
    height: viewport.height / transform.scale,
  };
}

/**
 * Where the map sits. Desktop fits the whole map when that keeps it at least MIN_DESKTOP_SCALE,
 * and otherwise fits the width and scrolls, so text stays readable. Phones fit the whole map,
 * or one goal's cell when zoomed. `height` is the svg's own height, or null to fill the
 * area; `scale` is screen pixels per map unit.
 */
function targetFrame(
  map: GoalMapData,
  viewport: Size | null,
  goalId: string | null,
  wide: boolean,
): { viewBox: ViewBox; height: number | null; scale: number } {
  const { layout } = map;
  if (viewport === null || viewport.width <= 0 || viewport.height <= 0) {
    return {
      viewBox: { x: 0, y: 0, width: Math.max(1, layout.width), height: Math.max(1, layout.height) },
      height: null,
      scale: 1,
    };
  }
  if (wide) {
    const fit = fitTransform(layout, viewport);
    if (fit.scale >= MIN_DESKTOP_SCALE) {
      const scale = Math.min(MAX_FIT_SCALE, fit.scale);
      const transform = {
        scale,
        x: (viewport.width - layout.width * scale) / 2,
        y: (viewport.height - layout.height * scale) / 2,
      };
      return { viewBox: toViewBox(transform, viewport), height: null, scale };
    }
    const pad = 16;
    const scale = Math.min(MAX_FIT_SCALE, (viewport.width - pad * 2) / Math.max(1, layout.width));
    const height = Math.ceil(layout.height * scale + pad * 2);
    const frame = { width: viewport.width, height };
    return {
      viewBox: toViewBox({ scale, x: (viewport.width - layout.width * scale) / 2, y: pad }, frame),
      height,
      scale,
    };
  }
  // Phones are tall: start at the top instead of centering, so the map sits under the header.
  const centered =
    goalId !== null ? zoomToGoal(layout, goalId, viewport) : fitTransform(layout, viewport);
  const top = goalId !== null ? layout.cells[goalId]!.y : 0;
  // A zoomed cell leaves room above it for the 전체 보기 button.
  const transform = { ...centered, y: (goalId !== null ? 48 : 16) - top * centered.scale };
  return { viewBox: toViewBox(transform, viewport), height: null, scale: transform.scale };
}

const formatViewBox = (box: ViewBox) =>
  [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100).join(" ");

function useElementSize(ref: React.RefObject<HTMLElement | null>): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const update = () => {
      // Client size: a vertical scrollbar must not push the map sideways.
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize((current) =>
        current !== null && current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * Follows `target`, easing between the two whenever `zoomKey` changes (and jumping when
 * motion is reduced); resizes just follow along.
 */
function useAnimatedViewBox(target: ViewBox, zoomKey: string): ViewBox {
  const [tween, setTween] = useState<ViewBox | null>(null);
  const targetRef = useRef(target);
  const shownRef = useRef(target);
  const zoomKeyRef = useRef(zoomKey);
  useEffect(() => {
    if (zoomKeyRef.current === zoomKey) return;
    zoomKeyRef.current = zoomKey;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const from = shownRef.current;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ZOOM_MS);
      const ease = 1 - (1 - t) ** 3;
      const to = targetRef.current;
      const mix = (a: number, b: number) => a + (b - a) * ease;
      if (t >= 1) {
        setTween(null);
        return;
      }
      setTween({
        x: mix(from.x, to.x),
        y: mix(from.y, to.y),
        width: mix(from.width, to.width),
        height: mix(from.height, to.height),
      });
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      setTween(null);
    };
  }, [zoomKey]);
  const shown = tween ?? target;
  // Before the zoom effect runs, so a new tween starts from what is on screen.
  useLayoutEffect(() => {
    targetRef.current = target;
    shownRef.current = shown;
  });
  return shown;
}

const onActivateKey = (action: () => void) => (event: KeyboardEvent) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
};

const PILL_FONT = 12;
const COMPACT_PILL_PAD = 6;

const TASK_TONE: Record<GoalMapTask["status"], { circle: string; label: string }> = {
  running: { circle: "fill-background stroke-info", label: "진행 중" },
  user: { circle: "fill-warning stroke-warning", label: "내 차례" },
  blocked: { circle: "fill-destructive/15 stroke-destructive", label: "막힘" },
  waiting: { circle: "fill-muted stroke-muted-foreground/50", label: "대기" },
};

const PILL_TONE: Record<GoalMapGoal["nextAction"]["kind"], { rect: string; text: string }> = {
  user: { rect: "fill-warning", text: "fill-amber-950" },
  running: { rect: "fill-info/12", text: "fill-info-foreground" },
  blocked: { rect: "fill-destructive/12", text: "fill-destructive" },
  waiting: { rect: "fill-muted", text: "fill-muted-foreground" },
  none: { rect: "fill-muted", text: "fill-muted-foreground" },
};

function TaskNode(props: {
  task: GoalMapTask;
  cell: { x: number; width: number };
  pos: { x: number; y: number; r: number };
  showLabel: boolean;
  onOpen: () => void;
}) {
  const { task, pos, cell } = props;
  const user = task.status === "user";
  // The label runs right to the cell edge, between the other arc's circles.
  const size = 11;
  const tagWidth = 40;
  const labelX = pos.x + pos.r + 6 + (user ? tagWidth + 4 : 0);
  const room = cell.x + cell.width - 6 - labelX;
  const parent = task.parentKey === null ? "" : ` · 상위: ${task.parentKey}`;
  const fixed = textWidth(`${task.key} `, size) + textWidth(parent, 9);
  const title = fitText(task.shortTitle, Math.max(0, room - fixed), size);
  return (
    <g
      data-task-node={task.taskId}
      data-task-status={task.status}
      data-user-turn={user ? task.userTurn?.kind : undefined}
      role="link"
      tabIndex={0}
      aria-label={`${task.key} ${task.title} · ${TASK_TONE[task.status].label}`}
      onClick={props.onOpen}
      onKeyDown={onActivateKey(props.onOpen)}
      className="group/task cursor-pointer outline-none"
    >
      <title>{`${task.key} ${task.title}`}</title>
      {/* A larger invisible target than the drawn circle. */}
      <circle cx={pos.x} cy={pos.y} r={L.taskHitRadius} className="fill-transparent" />
      <circle
        cx={pos.x}
        cy={pos.y}
        r={pos.r}
        strokeWidth={2}
        className={cn(
          TASK_TONE[task.status].circle,
          "transition-[stroke-width] group-hover/task:stroke-[3] group-focus-visible/task:stroke-ring",
        )}
      />
      {props.showLabel && user ? (
        <g aria-hidden>
          <rect
            x={pos.x + pos.r + 6}
            y={pos.y - 7.5}
            width={tagWidth}
            height={15}
            rx={7.5}
            className="fill-warning"
          />
          <text
            x={pos.x + pos.r + 6 + tagWidth / 2}
            y={pos.y + 3}
            textAnchor="middle"
            fontSize={9}
            fontWeight={700}
            className="fill-amber-950"
          >
            내 차례
          </text>
        </g>
      ) : null}
      {props.showLabel ? (
        <text x={labelX} y={pos.y + 4} fontSize={size} className="fill-foreground">
          <tspan fontWeight={600}>{task.key}</tspan>
          {title.length > 0 ? <tspan className="fill-muted-foreground">{` ${title}`}</tspan> : null}
          {parent.length > 0 ? (
            <tspan fontSize={9} className="fill-muted-foreground">
              {parent}
            </tspan>
          ) : null}
        </text>
      ) : null}
    </g>
  );
}

const NEXT_ACTION_LEAD: Record<GoalMapGoal["nextAction"]["kind"], string> = {
  user: "내 차례",
  running: "진행 중",
  blocked: "막힘",
  waiting: "대기",
  none: "남은 일 없음",
};

/**
 * The next action for the phone overview's large text: its kind and task key, or just the
 * kind when even that does not fit.
 */
function compactNextAction(goal: GoalMapGoal, maxWidth: number): string {
  const { nextAction } = goal;
  const lead = NEXT_ACTION_LEAD[nextAction.kind];
  if (nextAction.task === null) return lead;
  const withKey = `${lead} ${nextAction.task.key}`;
  return textWidth(withKey, PILL_FONT) * 1.04 <= maxWidth ? withKey : lead;
}

/**
 * Title, counts and next action right under the goal circle. `k` scales the block up so the
 * phone overview stays readable; the block keeps to the layout's text rectangle width.
 */
function GoalText(props: {
  goal: GoalMapGoal;
  rect: { x: number; y: number; width: number };
  k: number;
  compact: boolean;
  onOpen: (() => void) | null;
}) {
  const { goal, rect, k } = props;
  const width = rect.width / k;
  return (
    <g data-goal-text={goal.id} transform={`translate(${rect.x} ${rect.y}) scale(${k})`}>
      <text
        data-goal-title
        x={0}
        y={14}
        fontSize={16}
        fontWeight={700}
        className={goal.none ? "fill-muted-foreground" : "fill-foreground"}
      >
        {fitText(goal.title, width, 16)}
      </text>
      <text
        data-goal-counts={goal.id}
        x={0}
        y={32}
        fontSize={12}
        className="fill-muted-foreground tabular-nums"
      >
        {fitText(`남은 ${goal.counts.remaining} · 완료 ${goal.counts.done}`, width, 12)}
      </text>
      <NextActionPill
        goal={goal}
        text={
          props.compact
            ? compactNextAction(goal, width - COMPACT_PILL_PAD * 2)
            : goal.nextAction.text
        }
        pad={props.compact ? COMPACT_PILL_PAD : 10}
        x={0}
        y={40}
        maxWidth={width}
        onOpen={props.onOpen}
      />
    </g>
  );
}

function NextActionPill(props: {
  goal: GoalMapGoal;
  text: string;
  pad: number;
  x: number;
  y: number;
  maxWidth: number;
  onOpen: (() => void) | null;
}) {
  const { nextAction } = props.goal;
  const tone = PILL_TONE[nextAction.kind];
  const size = PILL_FONT;
  const pad = props.pad;
  const lead = nextAction.kind === "user" ? "내 차례" : null;
  const rest =
    lead !== null && props.text.startsWith(lead) ? props.text.slice(lead.length) : props.text;
  const leadWidth = lead === null ? 0 : textWidth(lead, size) * 1.08;
  const restFit = fitText(rest, props.maxWidth - pad * 2 - leadWidth, size);
  const restWidth = textWidth(restFit, size);
  const width = Math.min(props.maxWidth, pad * 2 + leadWidth + restWidth);
  const open = props.onOpen;
  return (
    <g
      data-next-action={props.goal.id}
      data-next-action-kind={nextAction.kind}
      data-user-turn={nextAction.kind === "user" ? nextAction.task?.userTurn?.kind : undefined}
      role={open === null ? undefined : "link"}
      tabIndex={open === null ? undefined : 0}
      aria-label={open === null ? undefined : nextAction.text}
      onClick={open ?? undefined}
      onKeyDown={open === null ? undefined : onActivateKey(open)}
      className={cn("outline-none", open !== null && "group/pill cursor-pointer")}
    >
      <rect
        x={props.x}
        y={props.y}
        width={width}
        height={22}
        rx={11}
        className={cn(
          tone.rect,
          "group-hover/pill:opacity-85 group-focus-visible/pill:stroke-ring group-focus-visible/pill:stroke-2",
        )}
      />
      <text x={props.x + pad} y={props.y + 15} fontSize={size} className={tone.text}>
        {lead !== null ? <tspan fontWeight={700}>{lead}</tspan> : null}
        <tspan>{restFit}</tspan>
      </text>
    </g>
  );
}

/**
 * The All projects goal map: each active goal with its open tasks around it, finished work as
 * dots, and dashed arrows where a task waits on another. Phones tap a goal to zoom into it.
 */
export function GoalMap({ map }: { map: GoalMapData }) {
  const navigate = useNavigate();
  const wide = useMediaQuery("sm");
  const wrapper = useRef<HTMLDivElement>(null);
  const viewport = useElementSize(wrapper);
  const [zoomGoalId, setZoomGoalId] = useState<string | null>(null);
  const markerId = `goal-map-arrow-${useId().replace(/:/g, "")}`;
  // Zoom is a phone affordance; a resize to desktop, or a goal that left the map, resets it.
  const zoomed = !wide && zoomGoalId !== null && map.layout.cells[zoomGoalId] !== undefined;
  const frame = targetFrame(map, viewport, zoomed ? zoomGoalId : null, wide);
  const viewBox = useAnimatedViewBox(frame.viewBox, zoomed ? zoomGoalId : "");
  const { layout } = map;
  const overview = !wide && !zoomed;
  // Counter-scale the goal text so it is never smaller than MIN_TEXT_PX on screen, without
  // growing past the space under the goal in its cell.
  const textK = Math.min(2.3, Math.max(1, MIN_TEXT_PX / (12 * frame.scale)));

  const openTask = (task: GoalMapTask) =>
    void navigate(taskRouteParams(task.environmentId, task.projectId, task.taskId));

  return (
    <div
      ref={wrapper}
      className="relative min-h-64 w-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
    >
      <svg
        data-goal-map
        data-zoomed={zoomed ? "true" : "false"}
        viewBox={formatViewBox(viewBox)}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label="목표 지도"
        style={frame.height === null ? undefined : { height: frame.height }}
        className={cn(
          "block select-none",
          frame.height === null ? "absolute inset-0 size-full" : "w-full",
        )}
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={7}
            markerHeight={7}
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" className="fill-muted-foreground" />
          </marker>
        </defs>

        {/* Goal to task spokes. */}
        {map.goals.flatMap((goal) => {
          const center = layout.goalPos[goal.id]!;
          return goal.tasks.map((task) => {
            const pos = layout.taskPos[task.nodeId]!;
            const dx = pos.x - center.x;
            const dy = pos.y - center.y;
            const length = Math.hypot(dx, dy) || 1;
            return (
              <line
                key={`spoke:${task.nodeId}`}
                x1={center.x + (dx / length) * center.r}
                y1={center.y + (dy / length) * center.r}
                x2={pos.x - (dx / length) * pos.r}
                y2={pos.y - (dy / length) * pos.r}
                strokeWidth={1}
                className="stroke-border"
              />
            );
          });
        })}

        {/* A task waiting on unfinished work points at it. */}
        {map.edges.map((edge) => {
          const from = layout.taskPos[edge.fromTaskNodeId];
          const to = layout.taskPos[edge.toTaskNodeId];
          if (from === undefined || to === undefined) return null;
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const length = Math.hypot(dx, dy) || 1;
          return (
            <line
              key={edge.id}
              data-waits-edge={edge.id}
              x1={from.x + (dx / length) * (from.r + 2)}
              y1={from.y + (dy / length) * (from.r + 2)}
              x2={to.x - (dx / length) * (to.r + 3)}
              y2={to.y - (dy / length) * (to.r + 3)}
              strokeWidth={1.5}
              strokeDasharray="5 4"
              markerEnd={`url(#${markerId})`}
              className="stroke-muted-foreground"
            />
          );
        })}

        {map.goals.map((goal) => {
          const center = layout.goalPos[goal.id]!;
          const total = goal.counts.done + goal.counts.remaining;
          const ratio = total === 0 ? 0 : goal.counts.done / total;
          const circumference = 2 * Math.PI * center.r;
          const zoomable = !wide;
          const zoomIn = () => setZoomGoalId(goal.id);
          const nextTask = goal.nextAction.task;
          return (
            <g key={goal.id} data-goal-cell={goal.id}>
              {(layout.dotPos[goal.id] ?? []).map((dot) => (
                <circle
                  key={`${dot.x},${dot.y}`}
                  data-done-dot
                  cx={dot.x}
                  cy={dot.y}
                  r={dot.r}
                  className="fill-success/60"
                />
              ))}
              {goal.hiddenDone > 0 ? (
                <text
                  data-hidden-done={goal.hiddenDone}
                  x={center.x + L.dotArcRadius + 6}
                  y={center.y + 4}
                  fontSize={10}
                  className="fill-success"
                >
                  {`+${goal.hiddenDone}`}
                </text>
              ) : null}
              <g
                data-goal-node={goal.id}
                role={zoomable ? "button" : undefined}
                tabIndex={zoomable ? 0 : undefined}
                aria-label={zoomable ? `${goal.title} 확대` : undefined}
                onClick={zoomable ? zoomIn : undefined}
                onKeyDown={zoomable ? onActivateKey(zoomIn) : undefined}
                className={cn("outline-none", zoomable && "cursor-pointer")}
              >
                <title>{goal.title}</title>
                <circle
                  cx={center.x}
                  cy={center.y}
                  r={center.r}
                  strokeWidth={3}
                  strokeDasharray={goal.none ? "6 5" : undefined}
                  className="fill-card stroke-border"
                />
                {!goal.none && ratio > 0 ? (
                  <circle
                    cx={center.x}
                    cy={center.y}
                    r={center.r}
                    fill="none"
                    strokeWidth={3}
                    strokeLinecap="round"
                    strokeDasharray={`${circumference * ratio} ${circumference}`}
                    transform={`rotate(-90 ${center.x} ${center.y})`}
                    className="stroke-success"
                  />
                ) : null}
                <text
                  x={center.x}
                  y={center.y + 5}
                  textAnchor="middle"
                  fontSize={15}
                  fontWeight={600}
                  className="fill-foreground tabular-nums"
                >
                  {`${goal.counts.done}/${total}`}
                </text>
              </g>
              {goal.overflow > 0 ? (
                <text
                  data-overflow={goal.overflow}
                  x={layout.overflowPos[goal.id]!.x}
                  y={layout.overflowPos[goal.id]!.y}
                  textAnchor="middle"
                  fontSize={12}
                  fontWeight={600}
                  className="fill-muted-foreground"
                >
                  <title>{`그 밖에 ${goal.overflow}개`}</title>
                  {`+${goal.overflow}`}
                </text>
              ) : null}
              <GoalText
                goal={goal}
                rect={layout.textPos[goal.id]!}
                k={textK}
                compact={overview}
                onOpen={nextTask === null ? null : () => openTask(nextTask)}
              />
            </g>
          );
        })}

        {map.goals.flatMap((goal) =>
          goal.tasks.map((task) => (
            <TaskNode
              key={task.nodeId}
              task={task}
              cell={layout.cells[goal.id]!}
              pos={layout.taskPos[task.nodeId]!}
              showLabel={!overview}
              onOpen={() => openTask(task)}
            />
          )),
        )}
      </svg>
      {zoomed ? (
        <button
          type="button"
          onClick={() => setZoomGoalId(null)}
          className="absolute top-2 right-2 rounded-full border bg-background/90 px-3 py-1 font-medium text-xs shadow-sm outline-none backdrop-blur hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          전체 보기
        </button>
      ) : null}
    </div>
  );
}
