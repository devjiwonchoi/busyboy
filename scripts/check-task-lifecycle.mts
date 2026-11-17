import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CardKind } from "../src/server/cards/model.ts";
import type { ParsedTodo } from "../src/server/records/parse-records.ts";
import { taskPhase, type PhaseRecords, type TaskPhase } from "../src/server/records/task-phase.ts";
import {
  autoArchiveDecision,
  autoArchiveOf,
  cardClosedOnStop,
  eventName,
  initialLife,
  lifeEvents,
  lifeKey,
  step,
  viewStatus,
  type AutoArchiveFacts,
  type LifeEvent,
  type TaskLife,
  type TaskStatusName,
} from "../src/server/task-lifecycle.ts";

function repositoryRoot() {
  const configured = process.env.BUSYBOY_CHECK_ROOT;
  if (configured) return configured;
  throw new Error(
    "Run this check with node scripts/run-check.mts scripts/check-task-lifecycle.mts so it can read the repository.",
  );
}

const root = repositoryRoot();

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function requireCall(file: string, needle: string, fix: string) {
  const source = readFileSync(join(root, file), "utf8");
  if (!source.includes(needle)) fail(fix);
}

requireCall(
  "src/server/tasks.ts",
  "archiveBlocked(",
  "archiveTask no longer calls archiveBlocked, so the lifecycle model can drift from the archive guard. Call archiveBlocked from archiveTask in src/server/tasks.ts.",
);
requireCall(
  "src/server/auto-archive.ts",
  "autoArchiveDecision(",
  "consider() no longer calls autoArchiveDecision, so auto-archive can drift from the model. Call autoArchiveDecision from src/server/auto-archive.ts.",
);
requireCall(
  "src/server/task-cards.ts",
  "planCardOpens(",
  "The plan card no longer uses planCardOpens, so a draft can drift from the model. Call planCardOpens from the turn-done handler in src/server/task-cards.ts.",
);
requireCall(
  "src/server/task-cards.ts",
  "cardClosedOnStop(",
  "stopTaskAgent no longer uses cardClosedOnStop, so an archive stop can drop the done card. Call cardClosedOnStop from src/server/task-cards.ts.",
);
requireCall(
  "src/server/cards/work-cards.ts",
  "cardClosedOnStop(",
  "The work-card stop handler no longer uses cardClosedOnStop, so an archive stop can drop the done card. Call cardClosedOnStop from src/server/cards/work-cards.ts.",
);

const PHASE_RULES = [
  "1. A failed resume is stopped unless the record is already done.",
  "2. A done record is PR when a pull-request card is open, and done otherwise.",
  "3. A question or approval card is needs-you.",
  "4. A plan card is aligning. A waiting draft is not working.",
  "5. A needs-you record, or blocked text, is needs-you.",
  "6. A needs-you agent is needs-you.",
  "7. A stopped record or a stopped agent is stopped.",
  "8. Verifying or reviewing text, or every todo done with a pending check, is verifying.",
  "9. A planning record, or a running agent whose plan is not approved and whose record is not already running, is aligning when the text says aligning, and planning otherwise.",
  "10. A running record or a running agent is working.",
  "11. Anything else is idle.",
].join("\n");

type PhaseInput = {
  agent: TaskStatusName;
  resumeFailed: boolean;
  state: PhaseRecords["state"];
  approved: boolean;
  cards: CardKind[];
  verifying: boolean;
  aligning: boolean;
  blocked: boolean;
  todos: "none" | "open" | "done";
  checksPending: boolean;
};

function phaseRecords(input: PhaseInput): PhaseRecords {
  const todos: ParsedTodo[] =
    input.todos === "none"
      ? []
      : [
          {
            id: "1",
            title: "Step",
            goal: null,
            result: input.todos === "done" ? "done" : "not-started",
            resultText: null,
          },
        ];
  const notes = [input.blocked ? "blocked" : "", input.aligning ? "aligning" : ""].filter(Boolean);
  return {
    approved: input.approved,
    state: input.state,
    stateText: notes.length > 0 ? notes.join(" ") : null,
    stage: input.verifying ? "Verify" : null,
    todos,
    checks: { passed: 0, failed: 0, pending: input.checksPending ? 1 : 0 },
  };
}

function expectedPhase(input: PhaseInput): TaskPhase {
  if (input.resumeFailed && input.state !== "done") return "stopped";
  if (input.state === "done") return input.cards.includes("pr") ? "pr" : "done";
  if (input.cards.includes("question") || input.cards.includes("approval")) return "needs-you";
  if (input.cards.includes("plan")) return "aligning";
  if (input.state === "needs-you" || input.blocked) return "needs-you";
  if (input.agent === "needs-you") return "needs-you";
  if (input.state === "stopped" || input.agent === "stopped") return "stopped";
  const todosDone = input.todos === "done";
  if (input.verifying || (todosDone && input.checksPending)) return "verifying";
  if (
    input.state === "planning" ||
    (input.agent === "running" && !input.approved && input.state !== "running")
  ) {
    return input.aligning ? "aligning" : "planning";
  }
  if (input.state === "running" || input.agent === "running") return "working";
  return "idle";
}

function describePhase(input: PhaseInput) {
  return JSON.stringify(input);
}

const agents: TaskStatusName[] = ["running", "needs-you", "idle", "stopped"];
const recordStates: PhaseRecords["state"][] = [
  null,
  "planning",
  "running",
  "needs-you",
  "done",
  "stopped",
];
const flags = [false, true];
let phaseRows = 0;

for (const agent of agents) {
  for (const resumeFailed of flags) {
    for (const state of recordStates) {
      for (const approved of flags) {
        for (const question of flags) {
          for (const approval of flags) {
            for (const plan of flags) {
              for (const pr of flags) {
                for (const verifying of flags) {
                  for (const aligning of flags) {
                    for (const blocked of flags) {
                      for (const todos of ["none", "open", "done"] as const) {
                        for (const checksPending of flags) {
                          const cards: CardKind[] = [];
                          if (question) cards.push("question");
                          if (approval) cards.push("approval");
                          if (plan) cards.push("plan");
                          if (pr) cards.push("pr");
                          const input: PhaseInput = {
                            agent,
                            resumeFailed,
                            state,
                            approved,
                            cards,
                            verifying,
                            aligning,
                            blocked,
                            todos,
                            checksPending,
                          };
                          phaseRows += 1;
                          const actual = taskPhase({
                            agent,
                            records: phaseRecords(input),
                            cards,
                            resumeFailed,
                          });
                          const expected = expectedPhase(input);
                          if (actual !== expected) {
                            fail(
                              [
                                "taskPhase drifted from the task lifecycle transition table.",
                                `Input: ${describePhase(input)}`,
                                `taskPhase returned ${actual}; the table says ${expected}.`,
                                "Fix src/server/records/task-phase.ts so the first matching rule wins:",
                                PHASE_RULES,
                              ].join("\n"),
                            );
                          }
                          if (actual === "working" && plan) {
                            fail(
                              [
                                "Invariant failed: a draft plan never runs work.",
                                "taskPhase returned working while a plan card is open.",
                                `Input: ${describePhase(input)}`,
                                "Fix src/server/records/task-phase.ts so a plan card is aligning, before a running record or a running agent can be working.",
                              ].join("\n"),
                            );
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

let archiveRows = 0;
for (const stoppingAll of flags) {
  for (const present of flags) {
    for (const archived of flags) {
      for (const subagent of flags) {
        for (const turnFinished of flags) {
          for (const runningOrNeedsYou of flags) {
            for (const draft of flags) {
              for (const recordDone of flags) {
                for (const openPulls of flags) {
                  for (const pullsSettled of flags) {
                    const facts: AutoArchiveFacts = {
                      stoppingAll,
                      present,
                      archived,
                      subagent,
                      turnFinished,
                      runningOrNeedsYou,
                      draft,
                      recordDone,
                      openPulls,
                      pullsSettled,
                    };
                    archiveRows += 1;
                    const decision = autoArchiveDecision(facts);
                    if (decision !== "archive") continue;
                    if (
                      stoppingAll ||
                      !present ||
                      archived ||
                      subagent ||
                      !turnFinished ||
                      runningOrNeedsYou ||
                      draft ||
                      !recordDone ||
                      (openPulls && !pullsSettled)
                    ) {
                      fail(
                        [
                          "Invariant failed: auto-archive never archives a task with an open pull request or a running turn, and it never archives a draft.",
                          `Facts: ${JSON.stringify(facts)}`,
                          `autoArchiveDecision returned ${decision}.`,
                          "Fix autoArchiveDecision in src/server/task-lifecycle.ts.",
                          "An open pull request stays on watch until it is merged or closed.",
                          "A running turn, a task that needs you, a draft plan, and a record that is not done stay put.",
                          "Keep consider() in src/server/auto-archive.ts calling that function.",
                        ].join("\n"),
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

for (const kind of ["plan", "question", "approval", "progress", "done", "pr"]) {
  if (kind === "done") {
    if (cardClosedOnStop(kind, true)) {
      fail(
        "Invariant failed: a done card survives an archive stop. cardClosedOnStop closed it. Fix cardClosedOnStop in src/server/task-lifecycle.ts so a done card stays open when the stop is an archive.",
      );
    }
    if (!cardClosedOnStop(kind, false)) {
      fail(
        "A user stop left the done card open. cardClosedOnStop keeps a done card only for an archive stop. Fix cardClosedOnStop in src/server/task-lifecycle.ts.",
      );
    }
    continue;
  }
  if (!cardClosedOnStop(kind, true) || !cardClosedOnStop(kind, false)) {
    fail(
      `cardClosedOnStop kept a ${kind} card. Only a done card survives an archive stop. Fix cardClosedOnStop in src/server/task-lifecycle.ts.`,
    );
  }
}

type FlagPreset = {
  verifying: boolean;
  aligning: boolean;
  blocked: boolean;
  todos: "none" | "open" | "done";
  checksPending: boolean;
};

const presets: FlagPreset[] = [
  { verifying: false, aligning: false, blocked: false, todos: "none", checksPending: false },
  { verifying: true, aligning: false, blocked: false, todos: "none", checksPending: false },
  { verifying: false, aligning: true, blocked: false, todos: "none", checksPending: false },
  { verifying: false, aligning: false, blocked: true, todos: "none", checksPending: false },
  { verifying: false, aligning: false, blocked: false, todos: "done", checksPending: true },
];

function shownPhase(life: TaskLife, preset: FlagPreset): TaskPhase {
  const cards: CardKind[] = [];
  if (life.askCard) cards.push("question");
  if (life.planCard) cards.push("plan");
  if (life.prCard) cards.push("pr");
  return taskPhase({
    agent: viewStatus(life),
    records: phaseRecords({
      agent: viewStatus(life),
      resumeFailed: life.resumeFailed,
      state: life.record === "none" ? null : life.record,
      approved: life.plan === "approved",
      cards,
      ...preset,
    }),
    cards,
    resumeFailed: life.resumeFailed,
  });
}

const events = lifeEvents();
const states: TaskLife[] = [initialLife()];
const parent: number[] = [-1];
const via: number[] = [-1];
const seen = new Map<string, number>([[lifeKey(states[0]!), 0]]);
const phases = new Set<TaskPhase>();
let sawArchive = false;
let sawRestore = false;
let sawPlanWhileWaiting = false;
let sawApprovedWork = false;
let transitions = 0;

function pathTo(at: number, last?: LifeEvent) {
  const names: string[] = [];
  let cursor = at;
  while (cursor > 0) {
    const event = events[via[cursor]!];
    if (event) names.push(eventName(event));
    cursor = parent[cursor]!;
  }
  names.reverse();
  if (last) names.push(eventName(last));
  return names.length > 0 ? names.join(" -> ") : "(initial)";
}

function stateLine(life: TaskLife) {
  return lifeKey(life);
}

for (let cursor = 0; cursor < states.length; cursor += 1) {
  const life = states[cursor]!;
  if (life.archived && life.planCard) {
    fail(
      [
        "Invariant failed: an archived task never shows a plan card.",
        `State: ${stateLine(life)}`,
        `Path: ${pathTo(cursor)}`,
        "Fix the archive transition in src/server/task-lifecycle.ts so it closes the plan card, and keep archiveBlocked refusing a task that still needs you.",
      ].join("\n"),
    );
  }
  if (life.plan === "draft" && autoArchiveOf(life) === "archive") {
    fail(
      [
        "Invariant failed: a draft plan never runs work, and auto-archive does not put a draft away.",
        `State: ${stateLine(life)}`,
        `Path: ${pathTo(cursor)}`,
        "Fix autoArchiveDecision in src/server/task-lifecycle.ts so a draft returns leave.",
      ].join("\n"),
    );
  }
  for (const preset of presets) {
    const phase = shownPhase(life, preset);
    phases.add(phase);
    if (life.planCard && phase === "working") {
      fail(
        [
          "Invariant failed: a draft plan never runs work.",
          "A plan card is open and taskPhase returned working.",
          `State: ${stateLine(life)}`,
          `Preset: ${JSON.stringify(preset)}`,
          `Path: ${pathTo(cursor)}`,
          "Fix src/server/records/task-phase.ts so a plan card is aligning, and fix step() in src/server/task-lifecycle.ts so a waiting draft is not a running turn.",
        ].join("\n"),
      );
    }
    if (life.planCard && (phase === "aligning" || phase === "planning")) sawPlanWhileWaiting = true;
  }
  if (
    life.plan === "approved" &&
    !life.planCard &&
    life.agent === "running" &&
    life.record === "running"
  ) {
    sawApprovedWork = true;
  }
  if (life.planCard && (life.agent === "running" || life.agent === "waiting")) {
    fail(
      [
        "Invariant failed: a draft plan never runs work.",
        "The plan card is open while the agent is running.",
        `State: ${stateLine(life)}`,
        `Path: ${pathTo(cursor)}`,
        "Fix step() in src/server/task-lifecycle.ts. Approve is the only way off a plan card, and it closes the card in that same step. start and message stay refused while the card is open.",
      ].join("\n"),
    );
  }

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]!;
    const next = step(life, event);
    if (!next) continue;
    transitions += 1;
    if (
      (event.type === "archive" || event.type === "auto-archive") &&
      life.doneCard &&
      !next.doneCard
    ) {
      fail(
        [
          "Invariant failed: a done card survives an archive stop.",
          `Before: ${stateLine(life)}`,
          `After: ${stateLine(next)}`,
          `Path: ${pathTo(cursor, event)}`,
          "Fix cardClosedOnStop and the archive transition in src/server/task-lifecycle.ts. Mark the stop as an archive before closing cards, and do not close a done card on that stop.",
        ].join("\n"),
      );
    }
    if ((event.type === "archive" || event.type === "auto-archive") && next.planCard) {
      fail(
        [
          "Invariant failed: an archived task never shows a plan card.",
          `Path: ${pathTo(cursor, event)}`,
          "Fix the archive transition in src/server/task-lifecycle.ts so the plan card closes.",
        ].join("\n"),
      );
    }
    if (event.type === "auto-archive") {
      if (life.pulls === "open" || life.agent === "running" || life.plan === "draft") {
        fail(
          [
            "Invariant failed: auto-archive never archives a task with an open pull request or a running turn.",
            `Before: ${stateLine(life)}`,
            `Path: ${pathTo(cursor, event)}`,
            "Fix autoArchiveOf in src/server/task-lifecycle.ts so this state returns watch or leave, not archive.",
          ].join("\n"),
        );
      }
      sawArchive = true;
    }
    if (event.type === "archive") sawArchive = true;
    if (event.type === "restore") sawRestore = true;
    if (event.type === "stop" && !life.archiveStop && life.doneCard && next.doneCard) {
      fail(
        [
          "A user stop left the done card open.",
          `Path: ${pathTo(cursor, event)}`,
          "A done card stays only when the stop is marked as an archive. Fix cardClosedOnStop in src/server/task-lifecycle.ts.",
        ].join("\n"),
      );
    }
    const key = lifeKey(next);
    if (seen.has(key)) continue;
    const at = states.length;
    seen.set(key, at);
    parent.push(cursor);
    via.push(eventIndex);
    states.push(next);
    if (states.length > 250_000) {
      fail(
        "The task lifecycle model passed 250000 states, so the check stopped. A guard is missing in step() in src/server/task-lifecycle.ts; the state is not finite.",
      );
    }
  }
}

const wanted: TaskPhase[] = [
  "planning",
  "aligning",
  "working",
  "verifying",
  "needs-you",
  "pr",
  "done",
  "stopped",
  "idle",
];
const missing = wanted.filter((phase) => !phases.has(phase));
if (missing.length > 0) {
  fail(
    [
      `The lifecycle model never reaches: ${missing.join(", ")}.`,
      "A transition is missing in step() in src/server/task-lifecycle.ts, or taskPhase no longer returns that phase for a state the model can reach.",
      "Planning is the unapproved turn. Aligning is the plan card. Working is an approved plan with a running record. Verifying is a finished turn whose stage says verify. Needs-you is an open question. PR is a done record with a pull-request card. Done, stopped, and idle are the record or the agent.",
    ].join("\n"),
  );
}
if (!sawArchive || !sawRestore) {
  fail(
    "The lifecycle model never archives and then restores a task. Fix the archive and restore transitions in src/server/task-lifecycle.ts.",
  );
}
if (!sawPlanWhileWaiting) {
  fail(
    "The lifecycle model never shows a waiting draft. end-turn on a draft plan has to open the plan card. Fix planCardOpens and applyEndTurn in src/server/task-lifecycle.ts.",
  );
}
if (!sawApprovedWork) {
  fail(
    "The lifecycle model never runs an approved or trivial plan. write-plan approved, then write-record running, has to be working with no plan card. Fix step() in src/server/task-lifecycle.ts.",
  );
}

console.log(
  `Task lifecycle holds for ${states.length} states, ${transitions} transitions, ${phaseRows} phase rows, and ${archiveRows} auto-archive rows.`,
);
