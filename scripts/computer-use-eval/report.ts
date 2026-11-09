// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A plain Node evaluation harness.
import { join } from "node:path";
import type { Mac } from "./mac.ts";
import { TOOL_RULE } from "./tasks.ts";

export type FailureCause =
  | "permission"
  | "timeout"
  | "ax_tree"
  | "wrong_action"
  | "instruction"
  | "harness";
export const CAUSE_LABELS: Record<FailureCause, string> = {
  permission: "권한",
  timeout: "타임아웃",
  ax_tree: "AX 트리 부족",
  wrong_action: "잘못된 동작(클릭)",
  instruction: "지시 이해",
  harness: "실행기 오류",
};
export const FAILURE_RULE_ORDER = [
  "permission",
  "timeout",
  "ax_tree",
  "instruction",
  "wrong_action",
] as const;

/**
 * Guesses why a failed attempt failed from the thread transcript (opaque text,
 * raw or JSON-escaped). The tool rule from the prompt is stripped first so its
 * own words ("computer_*", "osascript") never count.
 */
export function classifyFailure(input: { transcript: string; timedOut: boolean }): FailureCause {
  const transcript = input.transcript.split(TOOL_RULE).join("");
  if (
    /computer_use_unavailable|permission_required|app_denied|app_forbidden|screen_locked|turn_inactive|phase\\?"\s*:\s*\\?"approval/i.test(
      transcript,
    )
  ) {
    return "permission";
  }
  // A quoted error code works with both raw and escaped transcript JSON.
  if (input.timedOut || /code\\?"\s*:\s*\\?"timeout/.test(transcript)) {
    return "timeout";
  }
  if (
    /element_not_found|stale_element|window_not_found|action_unsupported|truncated\\?"\s*:\s*\\?"(?:nodes|depth|deadline|size)/.test(
      transcript,
    )
  ) {
    return "ax_tree";
  }
  if (
    !/computer_(?:snapshot|click|type|press|scroll|fill|select|invoke_menu)\b/.test(transcript) ||
    /command_execution[^{}]{0,4000}?(?:osascript|tell application\s)/i.test(transcript) ||
    /\$ [^\n"]*osascript/i.test(transcript)
  ) {
    return "instruction";
  }
  return "wrong_action";
}

export interface AttemptResult {
  runId: string;
  taskId: string;
  app: string;
  attempt: number;
  pass: boolean;
  cause?: FailureCause;
  detail: string;
  threadId?: string;
  durationMs?: number;
  at: string;
}

export async function readResults(mac: Mac, runDir: string): Promise<AttemptResult[]> {
  const path = join(runDir, "results.jsonl");
  if (!(await mac.exists(path))) {
    return [];
  }
  return (await mac.readFile(path))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AttemptResult);
}
export async function appendResult(mac: Mac, runDir: string, result: AttemptResult): Promise<void> {
  await mac.mkdirp(runDir);
  const path = join(runDir, "results.jsonl");
  const previous = (await mac.exists(path)) ? await mac.readFile(path) : "";
  await mac.writeFile(
    path,
    previous + (previous && !previous.endsWith("\n") ? "\n" : "") + JSON.stringify(result) + "\n",
  );
}

export function summarize(results: ReadonlyArray<AttemptResult>) {
  // Later JSONL entries replace previous judgments of the same attempt.
  const latest = new Map<string, AttemptResult>();
  for (const entry of results) {
    latest.set(JSON.stringify([entry.runId, entry.taskId, entry.attempt]), entry);
  }
  const tasks: Record<
    string,
    { app: string; passes: number; attempts: number; rate: number; results: AttemptResult[] }
  > = {};
  const apps: Record<string, { passes: number; attempts: number; rate: number }> = {};
  const causes = Object.fromEntries(Object.keys(CAUSE_LABELS).map((cause) => [cause, 0])) as Record<
    FailureCause,
    number
  >;
  const excluded = { count: 0, byTask: {} as Record<string, number> };
  let passes = 0;
  for (const entry of latest.values()) {
    const task = (tasks[entry.taskId] ??= {
      app: entry.app,
      passes: 0,
      attempts: 0,
      rate: 0,
      results: [],
    });
    const app = (apps[entry.app] ??= { passes: 0, attempts: 0, rate: 0 });
    task.results.push(entry);
    // Harness/environment failures stay visible but do not score the agent.
    if (entry.cause === "harness") {
      excluded.count++;
      excluded.byTask[entry.taskId] = (excluded.byTask[entry.taskId] ?? 0) + 1;
      causes.harness++;
      continue;
    }
    task.attempts++;
    app.attempts++;
    if (entry.pass) {
      task.passes++;
      app.passes++;
      passes++;
    } else if (entry.cause) {
      causes[entry.cause]++;
    }
    task.rate = task.passes / task.attempts;
    app.rate = app.passes / app.attempts;
  }
  for (const task of Object.values(tasks)) {
    task.results.sort((a, b) => a.attempt - b.attempt);
  }
  const attempts = latest.size - excluded.count;
  return {
    excluded,
    tasks,
    apps,
    overall: {
      passes,
      attempts,
      percent: attempts ? Math.round((passes / attempts) * 1000) / 10 : 0,
    },
    causes,
  };
}
export function renderReport(summary: ReturnType<typeof summarize>): string {
  const lines = ["| 작업 | 앱 | 결과 | 통과 |", "| --- | --- | --- | --- |"];
  for (const [id, task] of Object.entries(summary.tasks)) {
    lines.push(
      `| ${id} | ${task.app} | ${task.results.map((r) => (r.cause === "harness" ? "—" : r.pass ? "✓" : "✗")).join("")} | ${task.passes}/${task.attempts} |`,
    );
  }
  const { passes, attempts, percent } = summary.overall;
  lines.push(
    "",
    `전체: ${passes}/${attempts} (${percent.toFixed(1)}%)`,
    `제외(실행기 오류): ${summary.excluded.count}`,
    "",
    "| 원인 | 횟수 |",
    "| --- | --- |",
  );
  for (const [cause, count] of Object.entries(summary.causes)) {
    lines.push(`| ${CAUSE_LABELS[cause as FailureCause]} | ${count} |`);
  }
  return lines.join("\n");
}
