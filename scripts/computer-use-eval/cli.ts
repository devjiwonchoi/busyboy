#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A plain Node evaluation harness.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { realMac, type Mac } from "./mac.ts";
import { TASKS, findTask, promptFor } from "./tasks.ts";
import {
  appendResult,
  classifyFailure,
  readResults,
  renderReport,
  summarize,
  type AttemptResult,
} from "./report.ts";

const HELP = `Computer Use 평가 실행기
node scripts/computer-use-eval/cli.ts <command> [--base <dir>]

list
setup <taskId> --run <runId> --attempt <n>
judge <taskId> --run <runId> --attempt <n> [--answer-file f] [--transcript-file f] [--thread-id id] [--timed-out]
report --run <runId> [--json]
cleanup-all

기본 경로: ~/.busyboy-cu-eval (runs/<runId>, work)
시도별 순서: setup → lead가 prompt로 BusyBoy thread 실행 → 최대 10분 대기
→ 최종 답변과 원본 transcript를 각각 파일로 저장 → judge → 전체 완료 후 report.
이 실행기는 에이전트를 실행하지 않습니다. 작업은 동일한 Mac에서 순차 실행하세요.`;

export function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  const flags = new Set(["help", "json", "timed-out"]);
  const values = new Set(["base", "run", "attempt", "answer-file", "transcript-file", "thread-id"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (flags.has(name)) {
        options[name] = true;
      } else if (values.has(name)) {
        const value = argv[++i];
        if (!value || value.startsWith("--")) {
          throw new Error(`Missing value for --${name}`);
        }
        options[name] = value;
      } else {
        throw new Error(`Unknown option: ${arg}`);
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], taskId: positional[1], options };
}

export async function main(argv: string[], mac: Mac, out: (text: string) => void): Promise<void> {
  const { command, taskId, options } = parseArgs(argv);
  if (options.help || !command) {
    out(HELP);
    return;
  }
  if (command === "list") {
    out(
      JSON.stringify(
        TASKS.map(({ id, app, prompt }) => ({ id, app, prompt })),
        null,
        2,
      ),
    );
    return;
  }
  const base =
    typeof options.base === "string" ? options.base : join(mac.homeDir(), ".busyboy-cu-eval");
  const workDir = join(base, "work");
  if (command === "cleanup-all") {
    const errors: unknown[] = [];
    for (const task of TASKS) {
      try {
        const warning = await task.cleanup({ mac, workDir, vars: {} });
        if (warning) {
          out(warning);
        }
      } catch (error) {
        errors.push(new Error(`${task.id}: ${String(error)}`));
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Cleanup failed");
    }
    out("Cleanup complete.");
    return;
  }
  if (!["setup", "judge", "report"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  const runId = options.run;
  if (typeof runId !== "string" || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error("--run must contain only letters, digits, underscores, or hyphens.");
  }
  const runDir = join(base, "runs", runId);
  if (command === "report") {
    const summary = summarize(await readResults(mac, runDir));
    out(options.json ? JSON.stringify(summary, null, 2) : renderReport(summary));
    return;
  }
  const task = findTask(taskId ?? "");
  const attempt = Number(options.attempt);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("--attempt must be a positive integer.");
  }
  const statePath = join(runDir, "state", `${task.id}-${attempt}.json`);
  if (command === "setup") {
    const ctx = { mac, workDir, vars: {} };
    await mac.removeFile(statePath);
    const warning = await task.cleanup(ctx);
    const startedAt = mac.now().toISOString();
    let vars: Record<string, string>;
    try {
      vars = await task.setup(ctx);
    } catch (error) {
      // Remove partially created test data while preserving the setup error.
      try {
        await task.cleanup(ctx);
      } catch {
        // Cleanup is best-effort here; the original setup failure must propagate.
      }
      throw error;
    }
    await mac.mkdirp(join(runDir, "state"));
    await mac.writeFile(statePath, JSON.stringify({ vars, startedAt }));
    out(
      JSON.stringify({
        taskId: task.id,
        attempt,
        prompt: promptFor(task, vars),
        ...(warning ? { warning } : {}),
      }),
    );
    return;
  }

  const result: AttemptResult = {
    runId,
    taskId: task.id,
    app: task.app,
    attempt,
    pass: false,
    detail: "",
    at: mac.now().toISOString(),
  };
  if (typeof options["thread-id"] === "string") {
    result.threadId = options["thread-id"];
  }
  let vars: Record<string, string> = {};
  try {
    const state = JSON.parse(await mac.readFile(statePath)) as {
      vars: Record<string, string>;
      startedAt: string;
    };
    if (!state.vars || !Number.isFinite(Date.parse(state.startedAt))) {
      throw new Error("Invalid setup state.");
    }
    vars = state.vars;
    result.durationMs = mac.now().getTime() - Date.parse(state.startedAt);
    const answer =
      typeof options["answer-file"] === "string" ? await mac.readFile(options["answer-file"]) : "";
    const transcript =
      typeof options["transcript-file"] === "string"
        ? await mac.readFile(options["transcript-file"])
        : "";
    Object.assign(result, await task.judge({ mac, workDir, vars }, answer));
    if (!result.pass) {
      result.cause = classifyFailure({
        transcript,
        timedOut: options["timed-out"] === true,
      });
    }
  } catch (error) {
    result.pass = false;
    result.cause = "harness";
    result.detail = String(error);
  } finally {
    try {
      const warning = await task.cleanup({ mac, workDir, vars });
      if (warning) {
        result.detail += `; ${warning}`;
      }
    } catch (error) {
      result.pass = false;
      result.cause = "harness";
      result.detail += `; cleanup failed: ${String(error)}`;
    }
  }
  await appendResult(mac, runDir, result);
  out(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), realMac(), console.log).catch((error: unknown) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
