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
export function GoalChips({
  goal,
  onProposals,
}: {
  goal: GoalGraphData["goals"][number];
  onProposals: () => void;
}) {
  return (
    <span className="flex flex-wrap gap-1 text-[10px]">
      {goal.missingWork ? (
        <span className="rounded bg-amber-500/15 px-1 text-amber-600">빠진 일 있음</span>
      ) : null}
      {goal.proposals.length > 0 ? (
        <button
          type="button"
          className={waitingClass}
          onClick={(event) => {
            event.stopPropagation();
            onProposals();
          }}
        >
          디렉터 제안 {goal.proposals.length}
        </button>
      ) : null}
    </span>
  );
}
