export type TaskStatusName = "running" | "needs-you" | "idle" | "stopped";

export type AutoArchiveDecision = "leave" | "forget" | "watch" | "archive";

export type AutoArchiveFacts = {
  stoppingAll: boolean;
  present: boolean;
  archived: boolean;
  subagent: boolean;
  turnFinished: boolean;
  runningOrNeedsYou: boolean;
  draft: boolean;
  recordDone: boolean;
  openPulls: boolean;
  pullsSettled: boolean;
};

export type AgentLive = "absent" | "running" | "idle" | "waiting" | "stopped";

export type StoredActivity = "none" | "running" | "idle" | "needs-you" | "stopped";

export type PlanFile = "none" | "draft" | "approved";

export type RecordMark = "none" | "planning" | "running" | "needs-you" | "done" | "stopped";

export type PullMark = "none" | "open" | "settled";

export type TaskLife = {
  agent: AgentLive;
  activity: StoredActivity;
  plan: PlanFile;
  planCard: boolean;
  askCard: boolean;
  progressCard: boolean;
  doneCard: boolean;
  prCard: boolean;
  record: RecordMark;
  pulls: PullMark;
  archived: boolean;
  archiveStop: boolean;
  resumeFailed: boolean;
};

export type LifeEvent =
  | { type: "start" }
  | { type: "end-turn" }
  | { type: "write-plan"; plan: "draft" | "approved" }
  | { type: "write-record"; record: Exclude<RecordMark, "none"> }
  | { type: "note-pulls"; pulls: PullMark }
  | { type: "approve" }
  | { type: "ask" }
  | { type: "answer" }
  | { type: "stop" }
  | { type: "archive" }
  | { type: "auto-archive" }
  | { type: "restore" }
  | { type: "message" }
  | { type: "resume-failed" };

export function archiveBlocked(status: TaskStatusName) {
  return status === "running" || status === "needs-you";
}

export function planCardOpens(input: {
  more: boolean;
  draft: boolean;
  latest: boolean;
  idle: boolean;
}) {
  return !input.more && input.draft && input.latest && input.idle;
}

export function cardClosedOnStop(kind: string, archiveStop: boolean) {
  return !(kind === "done" && archiveStop);
}

export function autoArchiveDecision(facts: AutoArchiveFacts): AutoArchiveDecision {
  if (facts.stoppingAll) return "leave";
  if (!facts.present || facts.archived || facts.subagent) return "forget";
  if (!facts.turnFinished || facts.runningOrNeedsYou) return "leave";
  if (facts.draft) return "leave";
  if (!facts.recordDone) return "forget";
  if (facts.openPulls && !facts.pullsSettled) return "watch";
  return "archive";
}

export function initialLife(): TaskLife {
  return {
    agent: "absent",
    activity: "none",
    plan: "none",
    planCard: false,
    askCard: false,
    progressCard: false,
    doneCard: false,
    prCard: false,
    record: "none",
    pulls: "none",
    archived: false,
    archiveStop: false,
    resumeFailed: false,
  };
}

export function lifeKey(life: TaskLife) {
  return [
    life.agent,
    life.activity,
    life.plan,
    life.planCard ? 1 : 0,
    life.askCard ? 1 : 0,
    life.progressCard ? 1 : 0,
    life.doneCard ? 1 : 0,
    life.prCard ? 1 : 0,
    life.record,
    life.pulls,
    life.archived ? 1 : 0,
    life.archiveStop ? 1 : 0,
    life.resumeFailed ? 1 : 0,
  ].join("|");
}

export function eventName(event: LifeEvent) {
  switch (event.type) {
    case "write-plan":
      return `write-plan ${event.plan}`;
    case "write-record":
      return `write-record ${event.record}`;
    case "note-pulls":
      return `note-pulls ${event.pulls}`;
    default:
      return event.type;
  }
}

export function lifeEvents(): LifeEvent[] {
  const records = ["planning", "running", "needs-you", "done", "stopped"] as const;
  const pulls = ["none", "open", "settled"] as const;
  return [
    { type: "start" },
    { type: "end-turn" },
    { type: "write-plan", plan: "draft" },
    { type: "write-plan", plan: "approved" },
    ...records.map((record) => ({ type: "write-record" as const, record })),
    ...pulls.map((pulls) => ({ type: "note-pulls" as const, pulls })),
    { type: "approve" },
    { type: "ask" },
    { type: "answer" },
    { type: "stop" },
    { type: "archive" },
    { type: "auto-archive" },
    { type: "restore" },
    { type: "message" },
    { type: "resume-failed" },
  ];
}

export function agentStatus(life: TaskLife): TaskStatusName {
  if (life.agent === "absent" && life.activity === "idle") return "idle";
  switch (life.agent) {
    case "running":
      return "running";
    case "waiting":
      return "needs-you";
    case "idle":
      return "idle";
    default:
      return "stopped";
  }
}

export function viewStatus(life: TaskLife): TaskStatusName {
  const status = agentStatus(life);
  if (status === "idle" && (life.planCard || life.askCard)) return "needs-you";
  return status;
}

export function turnIsFinished(life: TaskLife) {
  if (life.agent !== "absent" && life.agent !== "stopped") return life.agent === "idle";
  return life.activity === "idle";
}

export function autoArchiveOf(life: TaskLife, stoppingAll = false) {
  return autoArchiveDecision({
    stoppingAll,
    present: true,
    archived: life.archived,
    subagent: false,
    turnFinished: turnIsFinished(life),
    runningOrNeedsYou: viewStatus(life) === "running" || viewStatus(life) === "needs-you",
    draft: life.plan === "draft",
    recordDone: life.record === "done",
    openPulls: life.pulls === "open",
    pullsSettled: life.pulls === "settled",
  });
}

function clone(life: TaskLife): TaskLife {
  return { ...life };
}

function closeStoppedCards(life: TaskLife, archiveStop: boolean): TaskLife {
  const next = clone(life);
  next.archiveStop = archiveStop;
  if (cardClosedOnStop("plan", archiveStop)) next.planCard = false;
  if (cardClosedOnStop("question", archiveStop)) next.askCard = false;
  if (cardClosedOnStop("progress", archiveStop)) next.progressCard = false;
  if (cardClosedOnStop("pr", archiveStop)) next.prCard = false;
  if (cardClosedOnStop("done", archiveStop)) next.doneCard = false;
  return next;
}

function applyStop(life: TaskLife): TaskLife | null {
  if (life.agent === "absent" && life.activity === "none") return null;
  const next = closeStoppedCards(life, life.archiveStop);
  next.agent = "stopped";
  next.activity = "stopped";
  return next;
}

function applyArchive(life: TaskLife): TaskLife | null {
  if (life.archived || archiveBlocked(viewStatus(life))) return null;
  if (life.agent === "absent" && life.activity === "none") return null;
  const next = closeStoppedCards(life, true);
  const activity =
    life.activity === "running" || life.activity === "needs-you" ? "stopped" : life.activity;
  next.activity = activity === "none" ? "stopped" : activity;
  next.agent = "absent";
  next.archived = true;
  return next;
}

function applyStart(life: TaskLife): TaskLife | null {
  if (life.archived || life.planCard || life.askCard) return null;
  if (life.agent === "running" || life.agent === "waiting") return null;
  const next = clone(life);
  next.archiveStop = false;
  next.resumeFailed = false;
  next.agent = "running";
  next.activity = "running";
  next.planCard = false;
  return next;
}

function applyEndTurn(life: TaskLife): TaskLife | null {
  if (life.agent !== "running") return null;
  const next = clone(life);
  next.agent = "idle";
  next.activity = "idle";
  next.askCard = false;
  next.resumeFailed = false;
  next.planCard = planCardOpens({
    more: false,
    draft: life.plan === "draft",
    latest: true,
    idle: true,
  });
  next.doneCard = life.record === "done";
  next.progressCard = life.record === "running";
  next.prCard = life.pulls !== "none";
  if (life.record === "done") next.progressCard = false;
  return next;
}

export function step(life: TaskLife, event: LifeEvent): TaskLife | null {
  switch (event.type) {
    case "start":
      return applyStart(life);
    case "end-turn":
      return applyEndTurn(life);
    case "write-plan": {
      if (life.agent !== "running") return null;
      const next = clone(life);
      next.plan = event.plan;
      return next;
    }
    case "write-record": {
      if (life.agent !== "running") return null;
      const next = clone(life);
      next.record = event.record;
      return next;
    }
    case "note-pulls": {
      if (life.agent !== "running") return null;
      const next = clone(life);
      next.pulls = event.pulls;
      return next;
    }
    case "approve": {
      if (!life.planCard) return null;
      const next = clone(life);
      next.planCard = false;
      next.archiveStop = false;
      next.resumeFailed = false;
      next.agent = "running";
      next.activity = "running";
      return next;
    }
    case "ask": {
      if (life.agent !== "running" || life.planCard) return null;
      const next = clone(life);
      next.agent = "waiting";
      next.activity = "needs-you";
      next.askCard = true;
      return next;
    }
    case "answer": {
      if (!life.askCard) return null;
      const next = clone(life);
      next.askCard = false;
      next.agent = "running";
      next.activity = "running";
      return next;
    }
    case "stop":
      return applyStop(life);
    case "archive":
      return applyArchive(life);
    case "auto-archive":
      return autoArchiveOf(life) === "archive" ? applyArchive(life) : null;
    case "restore": {
      if (!life.archived) return null;
      const next = clone(life);
      next.archived = false;
      return next;
    }
    case "message": {
      if (life.planCard || life.askCard) return null;
      if (life.agent === "running" || life.agent === "waiting") {
        const next = clone(life);
        next.agent = "running";
        next.activity = "running";
        next.planCard = false;
        return next;
      }
      const next = applyStart({ ...life, archived: false });
      return next;
    }
    case "resume-failed": {
      if (life.archived || life.agent === "running" || life.agent === "waiting") return null;
      if (life.agent === "absent" && life.activity === "none") return null;
      const next = clone(life);
      next.resumeFailed = true;
      next.agent = "absent";
      next.activity = "stopped";
      return next;
    }
  }
}
