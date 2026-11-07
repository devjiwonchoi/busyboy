import {
  type ProjectTaskPhase,
  type ProjectTaskStage,
  type ProjectTaskStatus,
  projectTaskPhase,
} from "@t3tools/contracts";

export const TASK_PHASE_LABELS: Record<ProjectTaskPhase, string> = {
  align: "계획",
  iterate: "구현·리뷰",
  ship: "배포",
};

const PHASES: ReadonlyArray<ProjectTaskPhase> = ["align", "iterate", "ship"];

export type TaskPhaseTone = "active" | "ready" | "done";

export interface TaskPhaseStep {
  readonly phase: ProjectTaskPhase;
  readonly label: string;
  readonly state: "done" | "current" | "upcoming";
}

export interface TaskPhaseView {
  /** The current phase; null once the task is done. */
  readonly phase: ProjectTaskPhase | null;
  readonly steps: ReadonlyArray<TaskPhaseStep>;
  /** "구현·리뷰", "배포 준비됨" or "완료". */
  readonly label: string;
  /** "2회차"; null for the first round, Align, or a finished task. */
  readonly round: string | null;
  /** The label with the round: "구현·리뷰 · 2회차". */
  readonly text: string;
  readonly tone: TaskPhaseTone;
}

export interface TaskPhaseInput {
  readonly stage: ProjectTaskStage;
  /** The live status; "ready" marks a pull request waiting on nothing but the merge. */
  readonly status: ProjectTaskStatus | null;
  readonly iterateRound: number;
  readonly shipRound: number;
}

function roundLabel(round: number): string | null {
  // The first round goes without saying; a counter appears once a phase repeats.
  return round >= 2 ? `${round}회차` : null;
}

/**
 * The phase stepper for a task: Align → Iterate → Ship, read from the stage, with the round
 * of the current phase. Ready keeps Ship current but reads "배포 준비됨"; Done fills every
 * step. Null for blocked and cancelled tasks, which have no phase to show.
 */
export function taskPhaseView(input: TaskPhaseInput): TaskPhaseView | null {
  if (input.stage === "done") {
    const label = "완료";
    return {
      phase: null,
      steps: PHASES.map((phase) => ({ phase, label: TASK_PHASE_LABELS[phase], state: "done" })),
      label,
      round: null,
      text: label,
      tone: "done",
    };
  }
  const phase = projectTaskPhase(input.stage);
  if (phase === null) return null;
  const index = PHASES.indexOf(phase);
  const ready = phase === "ship" && input.status === "ready";
  const label = ready ? "배포 준비됨" : TASK_PHASE_LABELS[phase];
  const round =
    phase === "iterate"
      ? roundLabel(input.iterateRound)
      : phase === "ship"
        ? roundLabel(input.shipRound)
        : null;
  return {
    phase,
    steps: PHASES.map((step, stepIndex) => ({
      phase: step,
      label: TASK_PHASE_LABELS[step],
      state: stepIndex < index ? "done" : stepIndex === index ? "current" : "upcoming",
    })),
    label,
    round,
    text: round === null ? label : `${label} · ${round}`,
    tone: ready ? "ready" : "active",
  };
}
