import type { ProjectTaskPlanCheck, ProjectTaskSpec } from "@t3tools/contracts";
import { formatModelSlugName } from "./model.ts";

/** Spec text fields a plan gate reads; the other gates are checked structurally. */
export type PlanGateTextField =
  | "problem"
  | "why"
  | "currentState"
  | "nonGoals"
  | "humanCheckpoints"
  | "budget"
  | "risks"
  | "alternatives";

/** The plan gates in order with the Korean label the user sees; the server and apps share it. */
export const PLAN_GATE_LABELS = [
  { id: "problem", label: "문제", field: "problem" },
  { id: "why", label: "왜", field: "why" },
  { id: "currentState", label: "현재 상태", field: "currentState" },
  { id: "nonGoals", label: "안 하는 것", field: "nonGoals" },
  { id: "todos", label: "할 일", field: null },
  { id: "criteria", label: "검증", field: null },
  { id: "traceability", label: "양방향 점검", field: null },
  { id: "humanCheckpoints", label: "사람 필요 지점", field: "humanCheckpoints" },
  { id: "budget", label: "예산", field: "budget" },
  { id: "risks", label: "위험", field: "risks" },
  { id: "alternatives", label: "대안", field: "alternatives" },
] as const satisfies ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly field: PlanGateTextField | null;
}>;

export type PlanGateId = (typeof PLAN_GATE_LABELS)[number]["id"];

export function planGateLabel(id: string): string {
  return PLAN_GATE_LABELS.find((gate) => gate.id === id)?.label ?? id;
}

export interface PlanGateSection {
  readonly id: PlanGateId;
  readonly label: string;
  readonly text: string;
}

/**
 * The filled gate text fields in gate order. 안 하는 것 is left out: the apps already show
 * it, so they place it between 현재 상태 and the rest.
 */
export function planGateSections(
  spec: Partial<Pick<ProjectTaskSpec, PlanGateTextField>> | null | undefined,
): Array<PlanGateSection> {
  if (!spec) return [];
  return PLAN_GATE_LABELS.flatMap((gate) => {
    if (gate.field === null || gate.field === "nonGoals") return [];
    const text = spec[gate.field]?.trim() ?? "";
    return text ? [{ id: gate.id, label: gate.label, text }] : [];
  });
}

/** Gates shown before 안 하는 것; the rest go after it. */
export function isBeforeNonGoals(section: PlanGateSection): boolean {
  return section.id === "problem" || section.id === "why" || section.id === "currentState";
}

const PLAN_CHECK_STATUS_LABEL: Record<Exclude<ProjectTaskPlanCheck["status"], "stale">, string> = {
  checking: "검사 중",
  passed: "검사 통과",
  failed: "검사 미통과",
};

export interface PlanCheckSummary {
  /** "검사 통과 · 2번째 확인 · Claude Opus 4.7" */
  readonly line: string;
  readonly rows: ReadonlyArray<{
    readonly label: string;
    readonly pass: boolean;
    readonly reason: string;
  }>;
}

/**
 * The checker's verdicts for the plan version on the card; null for another version, or a
 * check the spec moved past. A checker on the plan's own model says so quietly.
 */
export function planCheckSummary(
  planCheck: ProjectTaskPlanCheck | null | undefined,
  specVersion: number | null | undefined,
  modelLabel: (checker: NonNullable<ProjectTaskPlanCheck["checker"]>) => string = (checker) =>
    checker.model ? formatModelSlugName(checker.model) : checker.providerInstanceId,
): PlanCheckSummary | null {
  if (!planCheck || specVersion == null || planCheck.specVersion !== specVersion) return null;
  if (planCheck.status === "stale") return null;
  const parts = [PLAN_CHECK_STATUS_LABEL[planCheck.status], `${planCheck.round}번째 확인`];
  if (planCheck.checker) parts.push(modelLabel(planCheck.checker));
  if (planCheck.checker?.sameModelAsPlan) parts.push("같은 모델");
  return {
    line: parts.join(" · "),
    rows: planCheck.verdicts.map((verdict) => ({
      label: planGateLabel(verdict.gate),
      pass: verdict.pass,
      reason: verdict.reason,
    })),
  };
}

export function planVerdictLabel(pass: boolean): string {
  return pass ? "통과" : "미통과";
}
