import { optionLetter, type CardQuestion, type TaskCard } from "./cards/model";
import { readDraftPlan } from "./cards/plan";
import {
  answerAgent,
  getAgent,
  sendMessage,
  stopAgent,
  subscribeToAgent,
} from "./runner/agent-runner";
import type { AgentAnswer, AgentEvent, Question } from "./runner/contract";
import { cardClosedOnStop, planCardOpens } from "./task-lifecycle";

export type { CardOption, CardQuestion, TaskCard } from "./cards/model";

export type CardUpdate =
  | { type: "open"; card: TaskCard }
  | { type: "close"; card: TaskCard; outcome: string };

type CardTask = {
  id: string;
  project: string;
  title: string;
  agentId: string;
  worktree: string;
  chat?: string | null;
};

export const APPROVE_MESSAGE = "Approved.";

export const ALLOW = "Allow";
export const ALLOW_FOR_SESSION = "Allow for this session";
export const DENY = "Deny";

const RECOMMENDED = /\s*\(recommended\)\s*$/i;

type OpenCard = { card: TaskCard; agentId: string; requestId: string | null };

type CardStore = {
  open: Map<string, OpenCard>;
  outcomes: Map<string, string>;
  listeners: Set<(update: CardUpdate) => void>;
};

// why: On globalThis for the same reason as the runner's registry: `next dev` reloads.
const STORE_KEY = Symbol.for("busyboy.task-cards");
const globalStore = globalThis as typeof globalThis & { [STORE_KEY]?: Map<string, CardStore> };
const stores = (globalStore[STORE_KEY] ??= new Map());

function storeFor(folder: string): CardStore {
  let store = stores.get(folder);
  if (!store) {
    store = { open: new Map(), outcomes: new Map(), listeners: new Set() };
    stores.set(folder, store);
  }
  return store;
}

function openCard(store: CardStore, entry: OpenCard) {
  store.open.set(entry.card.id, entry);
  for (const listener of store.listeners) listener({ type: "open", card: entry.card });
}

function closeCard(store: CardStore, cardId: string) {
  const entry = store.open.get(cardId);
  if (!entry) {
    return;
  }
  store.open.delete(cardId);
  const outcome = store.outcomes.get(cardId) ?? "No longer waiting";
  store.outcomes.delete(cardId);
  for (const listener of store.listeners) listener({ type: "close", card: entry.card, outcome });
}

function toCardQuestion({ question, header, options, multiSelect }: Question): CardQuestion {
  return {
    question,
    header,
    multiSelect,
    options: options.map(({ label, description }) => ({
      label: label.replace(RECOMMENDED, ""),
      description,
      recommended: RECOMMENDED.test(label),
    })),
  };
}

function requestCard(
  task: CardTask,
  event: Extract<AgentEvent, { type: "approval" | "question" }>,
): TaskCard {
  const source = {
    id: `${task.agentId}:${event.requestId}`,
    taskId: task.id,
    chat: task.chat ?? null,
    project: task.project,
    taskTitle: task.title,
    openedAt: new Date().toISOString(),
  };
  if (event.type === "question") {
    return { ...source, kind: "question", questions: event.questions.map(toCardQuestion) };
  }

  const labels = event.canAllowForSession
    ? [ALLOW, event.allowForSessionLabel ?? ALLOW_FOR_SESSION, DENY]
    : [ALLOW, DENY];
  const options = labels.map((label) => ({ label, description: undefined, recommended: false }));
  return {
    ...source,
    kind: "approval",
    detail: event.detail,
    questions: [{ question: event.title, header: undefined, options, multiSelect: false }],
  };
}

export function trackTaskCards({
  folder,
  task,
  onChange,
}: {
  folder: string;
  task: CardTask;
  onChange: () => void;
}) {
  const store = storeFor(folder);
  const isOwn = (update: CardUpdate) => update.card.taskId === task.id;
  store.listeners.add((update) => {
    if (isOwn(update)) {
      onChange();
    }
  });
  const alignId = `align:${task.id}`;
  let latestSeq = 0;

  subscribeToAgent(task.agentId, 0, ({ seq, event }) => {
    latestSeq = seq;
    switch (event.type) {
      case "approval":
      case "question":
        openCard(store, {
          card: requestCard(task, event),
          agentId: task.agentId,
          requestId: event.requestId,
        });
        break;
      case "answered":
        closeCard(store, `${task.agentId}:${event.requestId}`);
        break;
      case "user-message":
      case "started":
      case "stopped":
        closeCard(store, alignId);
        break;
      case "turn-done":
        if (event.more) {
          break;
        }
        void readDraftPlan(folder, task)
          .then((draft) => {
            if (
              !draft ||
              !planCardOpens({
                more: event.more === true,
                draft: true,
                latest: latestSeq === seq,
                idle: getAgent(task.agentId)?.status === "idle",
              })
            ) {
              return;
            }
            const card: TaskCard = {
              id: alignId,
              taskId: task.id,
              chat: task.chat ?? null,
              project: task.project,
              taskTitle: task.title,
              openedAt: new Date().toISOString(),
              kind: "plan",
              ...draft,
            };
            openCard(store, { card, agentId: task.agentId, requestId: null });
          })
          .catch((error: unknown) =>
            console.error(`busyboy: could not read the plan of ${task.id}`, error),
          );
        break;
    }
  });
}

export function openDirectorApproval({
  folder,
  chat,
  agentId,
  event,
}: {
  folder: string;
  chat: string | null;
  agentId: string;
  event: Extract<AgentEvent, { type: "approval" }>;
}) {
  const server = /^mcp__(.+?)__/.exec(event.title)?.[1] ?? "connector";
  const labels = event.canAllowForSession
    ? [ALLOW, event.allowForSessionLabel ?? ALLOW_FOR_SESSION, DENY]
    : [ALLOW, DENY];
  const card: TaskCard = {
    id: `${agentId}:${event.requestId}`,
    taskId: agentId,
    chat,
    project: "Director",
    taskTitle: server,
    openedAt: new Date().toISOString(),
    stopsTask: false,
    kind: "approval",
    detail: event.detail,
    questions: [
      {
        question: event.title,
        header: undefined,
        options: labels.map((label) => ({ label, description: undefined, recommended: false })),
        multiSelect: false,
      },
    ],
  };
  openCard(storeFor(folder), { card, agentId, requestId: event.requestId });
}

export function closeDirectorApproval(folder: string, agentId: string, requestId?: string) {
  const store = storeFor(folder);
  for (const [id, entry] of store.open) {
    if (entry.agentId !== agentId || entry.card.stopsTask !== false) continue;
    if (requestId !== undefined && id !== `${agentId}:${requestId}`) continue;
    closeCard(store, id);
  }
}

export function openCards(folder: string) {
  return [...storeFor(folder).open.values()].map(({ card }) => card);
}

export function presentCard({
  folder,
  card,
  agentId,
  requestId = null,
}: {
  folder: string;
  card: TaskCard;
  agentId: string;
  requestId?: string | null;
}) {
  openCard(storeFor(folder), { card, agentId, requestId });
}

export function settleCard({
  folder,
  cardId,
  outcome,
}: {
  folder: string;
  cardId: string;
  outcome: string;
}) {
  const store = storeFor(folder);
  if (!store.open.has(cardId)) {
    throw new CardError("This card was already answered.");
  }
  withOutcome(store, cardId, outcome, () => closeCard(store, cardId));
}

export function subscribeToCards(folder: string, listener: (update: CardUpdate) => void) {
  const store = storeFor(folder);
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

export class CardError extends Error {}

// why: The runner closes the card synchronously inside the action, so a failed action must not label a later card with the same id.
function withOutcome(
  store: CardStore,
  cardId: string,
  outcome: string,
  action: () => boolean | void,
) {
  store.outcomes.set(cardId, outcome);
  let delivered: boolean | void;
  try {
    delivered = action();
  } catch (error) {
    store.outcomes.delete(cardId);
    throw error;
  }
  if (delivered === false) {
    store.outcomes.delete(cardId);
    throw new CardError("This card was already answered.");
  }
}

function getOpen(folder: string, cardId: string) {
  const store = storeFor(folder);
  const entry = store.open.get(cardId);
  if (!entry) {
    throw new CardError("This card was already answered.");
  }
  return { store, entry };
}

export function answerCard({
  folder,
  cardId,
  choices,
}: {
  folder: string;
  cardId: string;
  choices: string[][];
}) {
  const { store, entry } = getOpen(folder, cardId);
  const { card } = entry;
  if ((card.kind !== "question" && card.kind !== "approval") || !entry.requestId) {
    throw new CardError("Only a question or approval card takes a choice.");
  }

  const picked = card.questions.map(({ question, options, multiSelect }, index) => {
    const labels = [...new Set(choices[index] ?? [])];
    const valid =
      labels.length > 0 &&
      (multiSelect || labels.length === 1) &&
      labels.every((label) => options.some((option) => option.label === label));
    if (!valid) {
      throw new CardError(`Choose an answer for "${question}".`);
    }
    return {
      question,
      labels,
      letters: labels.map((label) =>
        optionLetter(options.findIndex((option) => option.label === label)),
      ),
    };
  });

  let answer: AgentAnswer;
  if (card.kind === "approval") {
    const [label] = picked[0].labels;
    answer = {
      kind: "approval",
      allow: label !== DENY,
      forSession: label !== ALLOW && label !== DENY,
    };
  } else {
    const answers: Record<string, string> = {};
    for (const { question, labels } of picked) {
      answers[question] = Object.hasOwn(answers, question)
        ? `${answers[question]}; ${labels.join(", ")}`
        : labels.join(", ");
    }
    answer = { kind: "question", answers };
  }
  const outcome = picked
    .map(({ labels, letters }) =>
      labels.map((label, index) => `${letters[index]} · ${label}`).join(", "),
    )
    .join("; ");
  const { agentId, requestId } = entry;
  withOutcome(store, cardId, outcome, () => answerAgent(agentId, requestId, answer));
}

export function approveCard({ folder, cardId }: { folder: string; cardId: string }) {
  const { store, entry } = getOpen(folder, cardId);
  if (entry.card.kind !== "plan") {
    throw new CardError("Only a plan card can be approved.");
  }
  withOutcome(store, cardId, "Approved", () => sendMessage(entry.agentId, APPROVE_MESSAGE));
}

export function replyToCard({
  folder,
  cardId,
  text,
}: {
  folder: string;
  cardId: string;
  text: string;
}) {
  const { store, entry } = getOpen(folder, cardId);
  const { card } = entry;
  if (card.kind === "plan") {
    withOutcome(store, cardId, "Changes requested", () => sendMessage(entry.agentId, text));
    return;
  }
  if (card.kind !== "question" && card.kind !== "approval") {
    throw new CardError("This card does not take a reply.");
  }

  const answer: AgentAnswer =
    card.kind === "approval"
      ? { kind: "approval", allow: false, message: text }
      : {
          kind: "question",
          answers: Object.fromEntries(card.questions.map(({ question }) => [question, text])),
        };
  const { agentId, requestId } = entry;
  withOutcome(
    store,
    cardId,
    card.kind === "approval" ? "Denied with a reply" : "Answered with a reply",
    () => (requestId ? answerAgent(agentId, requestId, answer) : false),
  );
}

// why: An archive stops the agent after the work is finished. That stop is not the user
// why: cancelling, so the done line stays. A later agent for the same task clears it.
const ARCHIVE_STOPS_KEY = Symbol.for("busyboy.archive-stops");
const archiveStops = ((globalThis as typeof globalThis & { [ARCHIVE_STOPS_KEY]?: Set<string> })[
  ARCHIVE_STOPS_KEY
] ??= new Set<string>());

export function markArchiveStop(taskId: string) {
  archiveStops.add(taskId);
}

export function clearArchiveStop(taskId: string) {
  archiveStops.delete(taskId);
}

export function isArchiveStop(taskId: string) {
  return archiveStops.has(taskId);
}

export async function stopTaskAgent({ folder, agentId }: { folder: string; agentId: string }) {
  if (!getAgent(agentId)) {
    return;
  }
  const store = storeFor(folder);
  const cardIds = [...store.open.values()]
    .filter(
      (entry) =>
        entry.agentId === agentId &&
        cardClosedOnStop(entry.card.kind, archiveStops.has(entry.card.taskId)),
    )
    .map(({ card }) => card.id);
  for (const cardId of cardIds) {
    store.outcomes.set(cardId, "Stopped");
  }
  try {
    await stopAgent(agentId);
  } catch (error) {
    for (const cardId of cardIds) {
      store.outcomes.delete(cardId);
    }
    throw error;
  }
}

export function hasOpenCard(agentId: string) {
  return [...stores.values()].some((store) =>
    [...store.open.values()].some(
      (entry) =>
        entry.agentId === agentId &&
        (entry.card.kind === "question" ||
          entry.card.kind === "approval" ||
          entry.card.kind === "plan"),
    ),
  );
}
