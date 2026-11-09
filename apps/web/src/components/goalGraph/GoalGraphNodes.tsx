import type { GoalGraphData, TaskTone } from "./goalGraph.logic";

export const toneClasses: Record<TaskTone, string> = {
  running: "border-l-blue-500",
  review: "border-l-violet-500",
  ready: "border-l-emerald-500",
  done: "border-l-muted-foreground text-muted-foreground",
  blocked: "border-l-red-500",
  planning: "border-l-muted-foreground",
};
export const waitingClass =
  "shrink-0 rounded-full bg-warning/16 px-1.5 py-0.5 text-warning text-[10px] hover:bg-warning/24";

export function ProgressRing({ done, total }: { done: number; total: number }) {
  return (
    <svg
      data-progress-ring
      width="28"
      height="28"
      viewBox="0 0 32 32"
      aria-label={`${done}/${total}`}
      className="shrink-0 -rotate-90"
    >
      <circle
        cx="16"
        cy="16"
        r="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        className="text-muted"
      />
      <circle
        cx="16"
        cy="16"
        r="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        pathLength="100"
        strokeDasharray={`${total === 0 ? 0 : (done / total) * 100} 100`}
        className="text-emerald-500"
      />
    </svg>
  );
}
export function GoalChips({ goal }: { goal: GoalGraphData["goals"][number] }) {
  return (
    <span className="flex flex-wrap gap-1 text-[10px]">
      {goal.missingWork ? (
        <span className="rounded bg-amber-500/15 px-1 text-amber-600">빠진 일 있음</span>
      ) : null}
    </span>
  );
}

/** A still dot remains visible when the user prefers reduced motion. */
export function PulseDot() {
  return (
    <span
      data-pulse
      aria-label="에이전트 작업 중"
      className="inline-block size-1.5 shrink-0 rounded-full bg-blue-500 motion-safe:animate-pulse"
    />
  );
}
