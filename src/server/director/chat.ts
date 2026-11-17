import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  isMessageImages,
  textWithImages,
  type AttachmentInput,
  type MessageImage,
} from "@/lib/chat-attachments";

import { alwaysAskRulesAt } from "../always-ask-list";
import { cardRecordTitle, isStoredCardKind, type StoredCardKind } from "../cards/model";
import { AttachmentError, attachmentsTurn, messageImages, readSavedImage } from "../chat-attachments";
import { getManagerAt, isListedManager, listManagersAt, subscribeToManagers } from "../managers";
import { pathKey, samePath } from "../paths";
import { PROVIDERS } from "../providers";
import {
  answerAgent,
  compactAgent,
  getAgent,
  interruptAgent,
  isStoppingAllAgents,
  resumeAgent,
  sendMessage,
  startAgent,
  stopAgent,
  subscribeToAgent,
} from "../runner/agent-runner";
import { BUSYBOY_FILES_RULE } from "../runner/always-ask";
import type { AgentEventEnvelope, McpServer, ProviderId } from "../runner/contract";
import { rulesFolderFor } from "../runner/user-rules";
import { combineTurns, displayText, modelText, type TurnImage, type UserTurn } from "../runner/user-turn";
import {
  closeDirectorApproval,
  openCards,
  openDirectorApproval,
  replyToCard,
  subscribeToCards,
  type TaskCard,
} from "../task-cards";
import { listTasksAt, messageTaskAt, readTasksAt, subscribeToTasks, type TaskView } from "../tasks";
import { directorTiming } from "./context";
import { directorPrompt, managerPrompt } from "./prompt";
import { appendTranscriptLine, readTranscript, type TranscriptCursor } from "./transcript-log";

type McpServers = Record<string, McpServer>;

// The display transcript is our own file, so it does not depend on what the provider still holds after compaction.

export const DIRECTOR_FOLDER = "director";
export const MANAGERS_FOLDER = "managers";
const STATE_FILE = "state.json";

export type ChatEntry =
  | {
      id: string;
      at: string;
      kind: "user";
      text: string;
      to?: string;
      images?: MessageImage[];
    }
  | { id: string; at: string; kind: "director"; text: string; interrupted?: boolean }
  /** Tasks the Director created in one turn. */
  | { id: string; at: string; kind: "tasks"; taskIds: string[] }
  | {
      id: string;
      at: string;
      kind: "note";
      text: string;
      tone: "info" | "error";
      compacted?: boolean;
    }
  /** A task agent's card once it closed: what it asked and how it ended. */
  | {
      id: string;
      at: string;
      kind: "card";
      cardKind: StoredCardKind;
      project: string;
      taskTitle: string;
      title: string;
      outcome: string;
    };

export type DirectorStatus = "idle" | "answering" | "compacting";

export type DirectorUpdate =
  | {
      type: "reset";
      entries: ChatEntry[];
      tasks: TaskView[];
      cards: TaskCard[];
      status: DirectorStatus;
      draft: string;
      queue: string[];
    }
  /** Appends the entry, or replaces the one with the same id. */
  | { type: "entry"; entry: ChatEntry }
  /** Replaces the transcript, after a message is edited away. */
  | { type: "entries"; entries: ChatEntry[] }
  /** Messages waiting to be sent after the current reply. Empty when nothing is queued. */
  | { type: "queue"; messages: string[] }
  /** The Director's reply as it streams; empty when no reply is streaming. */
  | { type: "draft"; text: string }
  | { type: "status"; status: DirectorStatus }
  | { type: "task"; task: TaskView }
  /** A task agent's card opened; it stays in the timeline until `card-closed`. */
  | { type: "card-opened"; card: TaskCard }
  | { type: "card-closed"; cardId: string };

type DirectorState = {
  provider?: ProviderId;
  sessionId?: string;
  // A turn that a quit cut off stays marked, so the next start can say so.
  turnOpen?: boolean;
};

// A cut-off turn may have created tasks already, so BusyBoy does not send it again.
export const REPLY_CUT_OFF_NOTE =
  "BusyBoy restarted before the Director finished replying. Send your message again if you still need an answer.";

export type ChatSummary = {
  chat: string | null;
  name: string;
  project: string | null;
  preview: string;
  status: DirectorStatus;
  waiting: number;
};

type Director = {
  folder: string;
  chat: string | null;
  closed?: boolean;
  ready: Promise<void>;
  loaded: boolean;
  entries: ChatEntry[];
  state: DirectorState;
  agentId?: string;
  instructions?: string;
  alwaysAsk?: string;
  status: DirectorStatus;
  draft: string;
  blocks: Map<string, string>;
  pending: UserTurn[];
  lastSent?: UserTurn;
  unconfirmedResume?: boolean;
  lostSession?: boolean;
  probing: number;
  turn: number;
  batchTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  turnTasksId?: string;
  charsSinceCompact: number;
  compactFailed?: boolean;
  compactBlocked?: boolean;
  stopRequested?: boolean;
  target?: { provider: ProviderId; mcp: McpServers };
  writes: Promise<unknown>;
  transcriptFile: TranscriptCursor;
  listeners: Set<(update: DirectorUpdate) => void>;
};

// Kept on globalThis so `next dev` reloads keep the running director.
const DIRECTORS_KEY = Symbol.for("busyboy.directors");
const globalStore = globalThis as typeof globalThis & { [DIRECTORS_KEY]?: Map<string, Director> };
const directors = (globalStore[DIRECTORS_KEY] ??= new Map());

const directorFolder = (director: Director) =>
  director.chat
    ? join(director.folder, MANAGERS_FOLDER, director.chat)
    : join(director.folder, DIRECTOR_FOLDER);

const directorKey = (folder: string, chat: string | null) =>
  chat ? `${pathKey(folder)}\n${chat}` : pathKey(folder);

function chatOf(folder: string, owner: string | null | undefined) {
  return owner && isListedManager(folder, owner) ? owner : null;
}

const WATCHED_KEY = Symbol.for("busyboy.director-folders");
const watchedStore = globalThis as typeof globalThis & { [WATCHED_KEY]?: Set<string> };
const watched = (watchedStore[WATCHED_KEY] ??= new Set());

function watchFolder(folder: string) {
  const key = pathKey(folder);
  if (watched.has(key)) return;
  watched.add(key);
  void listManagersAt(folder).catch(() => {});
  subscribeToTasks(folder, (task) => {
    for (const director of directors.values()) {
      if (samePath(director.folder, folder)) broadcast(director, { type: "task", task });
    }
  });
  subscribeToCards(folder, (update) => {
    const director = getDirector(folder, chatOf(folder, update.card.chat));
    if (update.type === "open") {
      broadcast(director, { type: "card-opened", card: update.card });
      return;
    }
    const { card, outcome } = update;
    broadcast(director, { type: "card-closed", cardId: card.id });
    const title = cardRecordTitle(card);
    const save = () =>
      saveEntry(
        director,
        newEntry("card", {
          cardKind: card.kind,
          project: card.project,
          taskTitle: card.taskTitle,
          title,
          outcome,
        }),
      );
    if (director.loaded) {
      save();
    } else {
      void director.ready.then(save);
    }
  });
}

function cardsOf(director: Director) {
  return openCards(director.folder).filter(
    (card) => chatOf(director.folder, card.chat) === director.chat,
  );
}

function getDirector(folder: string, chat: string | null = null): Director {
  const key = directorKey(folder, chat);
  let director = directors.get(key);
  if (director) return director;
  director = {
    folder,
    chat,
    ready: Promise.resolve(),
    loaded: false,
    entries: [],
    state: {},
    status: "idle",
    draft: "",
    blocks: new Map(),
    pending: [],
    probing: 0,
    turn: 0,
    charsSinceCompact: 0,
    writes: Promise.resolve(),
    transcriptFile: {},
    listeners: new Set(),
  };
  director.ready = load(director).finally(() => {
    director.loaded = true;
  });
  directors.set(key, director);
  watchFolder(folder);
  return director;
}

const roleOf = (director: Director) => (director.chat ? "manager" : "Director");

async function promptOf(director: Director) {
  if (!director.chat) return directorPrompt(director.folder);
  const manager = await getManagerAt(director.folder, director.chat);
  if (!manager) throw new Error("This manager was removed.");
  return managerPrompt(director.folder, manager);
}

async function load(director: Director) {
  const folder = directorFolder(director);
  const lines = (await readTranscript(folder).catch(() => "")).split("\n");
  const byId = new Map<string, ChatEntry>();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isRemoval(value)) {
        byId.delete(value.id);
        continue;
      }
      if (isEntry(value)) byId.set(value.id, value);
    } catch {
      // A line cut short by a crash; skip it.
    }
  }
  director.entries = [...byId.values()];
  const lastCompaction = director.entries.findLastIndex(
    (entry) => entry.kind === "note" && entry.compacted,
  );
  director.charsSinceCompact = director.entries
    .slice(lastCompaction + 1)
    .reduce((sum, entry) => sum + entryLength(entry), 0);
  try {
    const state = JSON.parse(await readFile(join(folder, STATE_FILE), "utf8")) as Partial<
      Record<keyof DirectorState, unknown>
    > | null;
    director.state =
      state &&
      PROVIDERS.some(({ id }) => id === state.provider) &&
      typeof state.sessionId === "string"
        ? { provider: state.provider as ProviderId, sessionId: state.sessionId as string }
        : {};
    if (state?.turnOpen === true) {
      const text = director.chat
        ? REPLY_CUT_OFF_NOTE.replace("the Director", "the manager")
        : REPLY_CUT_OFF_NOTE;
      saveEntry(director, newEntry("note", { text, tone: "info" }));
      saveState(director);
    }
  } catch {
    director.state = {};
  }
}

function isRemoval(value: unknown): value is { id: string; kind: "removed" } {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return entry.kind === "removed" && typeof entry.id === "string";
}

function isEntry(value: unknown): value is ChatEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || typeof entry.at !== "string") return false;
  switch (entry.kind) {
    case "user":
      return (
        typeof entry.text === "string" &&
        (entry.to === undefined || typeof entry.to === "string") &&
        (entry.images === undefined || isMessageImages(entry.images))
      );
    case "director":
      return typeof entry.text === "string";
    case "card":
      return (
        isStoredCardKind(entry.cardKind) &&
        ["project", "taskTitle", "title", "outcome"].every((key) => typeof entry[key] === "string")
      );
    case "note":
      return typeof entry.text === "string" && (entry.tone === "info" || entry.tone === "error");
    case "tasks":
      return Array.isArray(entry.taskIds) && entry.taskIds.every((id) => typeof id === "string");
    default:
      return false;
  }
}

function entryLength(entry: ChatEntry) {
  if (entry.kind === "user") {
    return entry.to ? 0 : entry.text.length;
  }
  return entry.kind === "director" ? entry.text.length : 0;
}

function broadcast(director: Director, update: DirectorUpdate) {
  for (const listener of director.listeners) listener(update);
}

function noteQueue(director: Director) {
  broadcast(director, {
    type: "queue",
    messages: director.pending.map((turn) => displayText(turn)),
  });
}

function recount(director: Director) {
  const lastCompaction = director.entries.findLastIndex(
    (entry) => entry.kind === "note" && entry.compacted,
  );
  director.charsSinceCompact = director.entries
    .slice(lastCompaction + 1)
    .reduce((sum, entry) => sum + entryLength(entry), 0);
}

function setStatus(director: Director, status: DirectorStatus) {
  if (director.status === status) return;
  director.status = status;
  broadcast(director, { type: "status", status });
}

function setBlock(director: Director, itemId: string, text: string) {
  director.blocks.set(itemId, text);
  setDraft(director, [...director.blocks.values()].filter((block) => block.trim()).join("\n\n"));
}

function setDraft(director: Director, text: string) {
  director.draft = text;
  broadcast(director, { type: "draft", text });
}

function rememberRemoval(director: Director, id: string) {
  const folder = directorFolder(director);
  const line = `${JSON.stringify({ id, at: new Date().toISOString(), kind: "removed" })}\n`;
  director.writes = director.writes
    .catch(() => {})
    .then(() => appendTranscriptLine(folder, line, director.transcriptFile))
    .catch((error: unknown) =>
      console.error(`busyboy: could not save the ${roleOf(director)} transcript`, error),
    );
}

function saveEntry(director: Director, entry: ChatEntry) {
  const index = director.entries.findIndex(({ id }) => id === entry.id);
  if (index === -1) {
    director.entries.push(entry);
    director.charsSinceCompact += entryLength(entry);
  } else director.entries[index] = entry;
  broadcast(director, { type: "entry", entry });
  const folder = directorFolder(director);
  director.writes = director.writes
    .catch(() => {})
    .then(() => appendTranscriptLine(folder, `${JSON.stringify(entry)}\n`, director.transcriptFile))
    .catch((error: unknown) =>
      console.error(`busyboy: could not save the ${roleOf(director)} transcript`, error),
    );
}

function newEntry<K extends ChatEntry["kind"]>(
  kind: K,
  fields: Omit<Extract<ChatEntry, { kind: K }>, "id" | "at" | "kind">,
) {
  return { id: randomUUID(), at: new Date().toISOString(), kind, ...fields } as Extract<
    ChatEntry,
    { kind: K }
  >;
}

function saveState(director: Director) {
  const folder = directorFolder(director);
  const state = { ...director.state };
  director.writes = director.writes
    .catch(() => {})
    .then(async () => {
      await mkdir(folder, { recursive: true });
      const file = join(folder, STATE_FILE);
      await writeFile(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
      await rename(`${file}.tmp`, file);
    })
    .catch((error: unknown) => console.error("busyboy: could not save the Director state", error));
}

async function ensureAgent(
  director: Director,
  provider: ProviderId,
  mcp: McpServers,
  instructions: string,
  alwaysAsk: string[],
) {
  const existing = director.agentId ? getAgent(director.agentId) : undefined;
  const sameSetup =
    director.instructions === instructions && director.alwaysAsk === JSON.stringify(alwaysAsk);
  if (existing && existing.provider === provider && sameSetup) {
    if (existing.status === "stopped") {
      director.unconfirmedResume = Boolean(existing.sessionId);
      resumeAgent(existing.id);
    }
    return existing.id;
  }
  if (existing && existing.provider === provider) {
    director.agentId = undefined;
    await stopAgent(existing.id).catch(() => {});
  } else if (existing) {
    director.agentId = undefined;
    void stopAgent(existing.id);
    saveEntry(
      director,
      newEntry("note", { text: `Started a new conversation on ${provider}.`, tone: "info" }),
    );
  }
  const cwd = directorFolder(director);
  await mkdir(cwd, { recursive: true });
  const resumeSessionId =
    director.state.provider === provider ? director.state.sessionId : undefined;
  director.unconfirmedResume = Boolean(resumeSessionId);
  // A connector write waits. Every other always-ask match is refused, because this folder sits next to settings.
  const agent = startAgent({
    provider,
    cwd,
    instructions,
    mcpServers: mcp,
    resumeSessionId,
    alwaysAsk,
    privateFolder: director.folder,
    rulesFolder: rulesFolderFor(director.folder),
  });
  director.agentId = agent.id;
  director.instructions = instructions;
  director.alwaysAsk = JSON.stringify(alwaysAsk);
  subscribeToAgent(agent.id, 0, (envelope) => onAgentEvent(director, agent.id, envelope));
  return agent.id;
}

function onAgentEvent(director: Director, agentId: string, { event }: AgentEventEnvelope) {
  if (director.agentId !== agentId) return;
  const compacting = director.status === "compacting";
  switch (event.type) {
    case "session":
      director.unconfirmedResume = false;
      if (director.state.sessionId !== event.sessionId) {
        director.state = {
          ...director.state,
          provider: getAgent(agentId)?.provider,
          sessionId: event.sessionId,
        };
        saveState(director);
      }
      break;
    case "text-delta":
      if (!compacting)
        setBlock(director, event.itemId, (director.blocks.get(event.itemId) ?? "") + event.text);
      break;
    case "text":
      if (!compacting) setBlock(director, event.itemId, event.text);
      break;
    case "approval":
      if (event.title.startsWith("mcp__") && !event.detail?.startsWith(BUSYBOY_FILES_RULE)) {
        openDirectorApproval({ folder: director.folder, chat: director.chat, agentId, event });
        break;
      }
      queueMicrotask(() =>
        answerAgent(agentId, event.requestId, {
          kind: "approval",
          allow: false,
          message: event.detail?.startsWith(BUSYBOY_FILES_RULE)
            ? `The ${roleOf(director)} cannot touch BusyBoy's own files. Use BusyBoy's tools to read or change tasks and settings.`
            : `The ${roleOf(director)} cannot run this. Create a task for work in a project instead.`,
        }),
      );
      break;
    case "answered":
      closeDirectorApproval(director.folder, agentId, event.requestId);
      break;
    case "question":
      queueMicrotask(() =>
        answerAgent(agentId, event.requestId, {
          kind: "question",
          answers: Object.fromEntries(
            event.questions.map(({ question }) => [
              question,
              "No answer. Ask this in your reply text instead.",
            ]),
          ),
        }),
      );
      break;
    case "error":
      if (
        director.unconfirmedResume &&
        (event.code === "lost-session" || LOST_SESSION.test(event.message))
      ) {
        director.lostSession = true;
        break;
      }
      if (compacting) director.compactFailed = true;
      saveEntry(director, newEntry("note", { text: event.message, tone: "error" }));
      break;
    case "turn-done":
      closeDirectorApproval(director.folder, agentId);
      if (director.lostSession) {
        recoverLostSession(director, agentId);
        break;
      }
      if (compacting) {
        if (!director.compactFailed && !event.interrupted) {
          saveEntry(
            director,
            newEntry("note", { text: "Context compacted", tone: "info", compacted: true }),
          );
          director.charsSinceCompact = 0;
        }
        if (director.compactFailed) director.compactBlocked = true;
        director.compactFailed = false;
      } else if (director.draft.trim()) {
        saveEntry(
          director,
          newEntry("director", {
            text: director.draft,
            interrupted: Boolean(event.interrupted) || undefined,
          }),
        );
      }
      endTurn(director);
      break;
    case "stopped":
      closeDirectorApproval(director.folder, agentId);
      if (director.lostSession) {
        recoverLostSession(director, agentId, { resend: !director.stopRequested });
        break;
      }
      if (director.draft.trim())
        saveEntry(director, newEntry("director", { text: director.draft, interrupted: true }));
      else if (director.stopRequested)
        saveEntry(director, newEntry("note", { text: "Stopped.", tone: "info" }));
      endTurn(director);
      break;
  }
}

// Claude says a missing session in its message. Codex reports the lost-session code.
const LOST_SESSION = /No conversation found with session ID/i;

function recoverLostSession(director: Director, agentId: string, { resend = true } = {}) {
  director.lostSession = false;
  director.unconfirmedResume = false;
  director.agentId = undefined;
  void stopAgent(agentId).catch(() => {});
  director.state = { turnOpen: director.state.turnOpen };
  saveState(director);
  saveEntry(
    director,
    newEntry("note", {
      text: "The previous conversation could not be resumed. Started a new one.",
      tone: "info",
    }),
  );
  if (resend && director.lastSent) {
    director.pending.unshift(director.lastSent);
    noteQueue(director);
  }
  endTurn(director);
}

function markTurnOpen(director: Director, open: boolean) {
  if (Boolean(director.state.turnOpen) === open) return;
  director.state = { ...director.state, turnOpen: open || undefined };
  saveState(director);
}

function endTurn(director: Director) {
  if (!isStoppingAllAgents() && director.pending.length === 0) markTurnOpen(director, false);
  director.stopRequested = false;
  director.blocks.clear();
  setDraft(director, "");
  director.turnTasksId = undefined;
  setStatus(director, "idle");
  if (isStoppingAllAgents()) return;
  if (director.pending.length && !director.batchTimer && !director.probing) void flush(director);
  else scheduleCompaction(director);
}

// Read through a call so TypeScript does not keep status narrowed to idle from before an await.
function isAnswering(director: Director) {
  return director.status === "answering";
}

async function flush(director: Director) {
  director.batchTimer = undefined;
  if (director.status !== "idle" || director.pending.length === 0) return;
  const target = director.target;
  if (!target) return;
  const outgoing = combineTurns(director.pending);
  director.pending = [];
  noteQueue(director);
  director.lastSent = outgoing;
  setStatus(director, "answering");
  const turn = ++director.turn;
  try {
    const [instructions, alwaysAsk] = await Promise.all([
      promptOf(director),
      alwaysAskRulesAt(director.folder),
    ]);
    if (director.turn !== turn || !isAnswering(director)) return;
    const agentId = await ensureAgent(
      director,
      target.provider,
      target.mcp,
      instructions,
      alwaysAsk,
    );
    if (director.closed) {
      director.agentId = undefined;
      void stopAgent(agentId).catch(() => {});
      return;
    }
    if (director.stopRequested && getAgent(agentId)?.status !== "stopped") {
      saveEntry(director, newEntry("note", { text: "Stopped.", tone: "info" }));
      endTurn(director);
      return;
    }
    // It stopped while starting: a lost session was already recovered and the
    // turn queued again, and any other failure was reported by its events.
    if (director.agentId !== agentId || getAgent(agentId)?.status === "stopped") return;
    sendMessage(agentId, outgoing);
  } catch (error) {
    saveEntry(
      director,
      newEntry("note", {
        text: error instanceof Error ? error.message : String(error),
        tone: "error",
      }),
    );
    setStatus(director, "idle");
  }
}

function scheduleCompaction(director: Director) {
  clearTimeout(director.idleTimer);
  const { idleCompactMs, compactChars } = directorTiming();
  if (director.compactBlocked || director.charsSinceCompact < compactChars) return;
  director.idleTimer = setTimeout(() => {
    director.idleTimer = undefined;
    const agent = director.agentId ? getAgent(director.agentId) : undefined;
    if (!agent || agent.status !== "idle" || director.status !== "idle" || director.pending.length)
      return;
    if (director.charsSinceCompact < compactChars) return;
    setStatus(director, "compacting");
    director.compactFailed = false;
    compactAgent(agent.id).catch((error: unknown) => {
      saveEntry(
        director,
        newEntry("note", {
          text: error instanceof Error ? error.message : String(error),
          tone: "error",
        }),
      );
      director.compactBlocked = true;
      if (director.status === "compacting") endTurn(director);
    });
  }, idleCompactMs);
  director.idleTimer.unref?.();
}

export type SendToDirectorInput = {
  folder: string;
  chat?: string | null;
  text: string;
  attachments?: AttachmentInput[];
  resolveProvider: (current: ProviderId | undefined) => Promise<ProviderId | null>;
  mcp: McpServers;
};

export async function sendToDirector(input: SendToDirectorInput) {
  const director = getDirector(input.folder, input.chat ?? null);
  await director.ready;
  const turn = await attachmentsTurn({
    folder: directorFolder(director),
    text: input.text,
    attachments: input.attachments ?? [],
  });
  await sendTurn(director, turn, input);
}

async function sendTurn(
  director: Director,
  turn: UserTurn,
  { resolveProvider, mcp }: Pick<SendToDirectorInput, "resolveProvider" | "mcp">,
) {
  if (!displayText(turn)) return;
  saveEntry(director, newEntry("user", { text: modelText(turn), images: messageImages(turn) }));
  clearTimeout(director.idleTimer);
  director.idleTimer = undefined;
  if (director.status === "compacting" && director.agentId) {
    interruptAgent(director.agentId).catch((error: unknown) =>
      console.error("busyboy: could not interrupt the Director", error),
    );
  }
  director.pending.push(turn);
  noteQueue(director);
  markTurnOpen(director, true);
  const live = director.agentId ? getAgent(director.agentId) : undefined;
  director.probing++;
  const provider = await resolveProvider(live?.provider ?? director.state.provider)
    .catch(() => null)
    .finally(() => director.probing--);
  clearTimeout(director.idleTimer);
  director.idleTimer = undefined;
  if (!provider) {
    const index = director.pending.lastIndexOf(turn);
    if (index !== -1) {
      director.pending.splice(index, 1);
      noteQueue(director);
      saveEntry(
        director,
        newEntry("note", {
          text: "No provider is signed in. Open Setup to sign in.",
          tone: "error",
        }),
      );
      if (director.status === "idle" && director.pending.length === 0)
        markTurnOpen(director, false);
    }
    scheduleCompaction(director);
    return;
  }
  director.compactBlocked = false;
  director.target = { provider, mcp };
  if (director.status === "answering") return;
  clearTimeout(director.batchTimer);
  director.batchTimer = setTimeout(() => void flush(director), directorTiming().batchMs);
}

export async function sendDirectorQueueNow(folder: string, chat: string | null = null) {
  const director = getDirector(folder, chat);
  await director.ready;
  if (director.pending.length === 0 || director.closed) return;
  clearTimeout(director.batchTimer);
  director.batchTimer = undefined;
  clearTimeout(director.idleTimer);
  director.idleTimer = undefined;
  if (isAnswering(director) && director.agentId) {
    const agentId = director.agentId;
    const agent = getAgent(agentId);
    if (agent && agent.status !== "stopped") {
      await interruptAgent(agentId);
      if (!isAnswering(director) && !director.probing) void flush(director);
      return;
    }
  }
  if (!director.probing) void flush(director);
}

async function imageFolder(folder: string, chat: string | null, task: string | null | undefined) {
  if (task) return (await readTasksAt(folder)).find(({ id }) => id === task)?.worktree ?? null;
  if (chat && !(await getManagerAt(folder, chat))) return null;
  return chat ? join(folder, MANAGERS_FOLDER, chat) : join(folder, DIRECTOR_FOLDER);
}

async function savedImages(director: Director, images: MessageImage[]): Promise<TurnImage[]> {
  const read = await Promise.all(
    images.map(async ({ name, file, task }) => {
      const from = await imageFolder(director.folder, director.chat, task);
      const saved = from ? await readSavedImage(from, file) : null;
      return (
        saved && {
          name,
          mediaType: saved.mediaType,
          data: saved.bytes.toString("base64"),
          path: saved.path,
        }
      );
    }),
  );
  return read.filter((image) => image !== null);
}

export async function reviseDirectorMessage(
  input: SendToDirectorInput & { entryId: string; keepImages?: boolean },
) {
  const director = getDirector(input.folder, input.chat ?? null);
  await director.ready;
  if (director.closed) return;
  const editable = () => {
    if (director.status !== "idle" || director.pending.length > 0) {
      throw new Error("Wait for the reply to finish before editing.");
    }
    const index = director.entries.findIndex((entry) => entry.id === input.entryId);
    const entry = director.entries[index];
    if (!entry || entry.kind !== "user" || entry.to)
      throw new Error("That message cannot be edited.");
    const last = director.entries.findLast((item) => item.kind === "user" && !item.to);
    if (!last || last.id !== entry.id) throw new Error("Only the latest message can be edited.");
    return { index, entry };
  };
  const sent = editable().entry.images ?? [];
  const again = input.keepImages ? sent : [];
  const turn = await attachmentsTurn({
    folder: directorFolder(director),
    text: input.text,
    attachments: input.attachments ?? [],
  });
  if (again.length) turn.images.unshift(...(await savedImages(director, again)));
  if (!displayText(turn)) {
    if (again.length)
      throw new AttachmentError(
        again.length > 1 ? "The images are no longer available." : "The image is no longer available.",
      );
    throw new Error("A message must be non-empty text of at most 100,000 characters.");
  }
  const { index } = editable();
  const removed: ChatEntry[] = [];
  const kept: ChatEntry[] = [];
  director.entries.forEach((item, itemIndex) => {
    if (itemIndex >= index && item.kind !== "tasks" && item.kind !== "card") removed.push(item);
    else kept.push(item);
  });
  director.entries = kept;
  recount(director);
  for (const item of removed) rememberRemoval(director, item.id);
  broadcast(director, { type: "entries", entries: director.entries });
  await sendTurn(director, turn, input);
}

export async function stopDirector(folder: string, chat: string | null = null) {
  const director = getDirector(folder, chat);
  await director.ready;
  clearTimeout(director.batchTimer);
  director.batchTimer = undefined;
  director.pending = [];
  noteQueue(director);
  if (director.status !== "answering") {
    markTurnOpen(director, false);
    return;
  }
  director.stopRequested = true;
  const agent = director.agentId ? getAgent(director.agentId) : undefined;
  if (!agent || agent.status === "stopped") return;
  try {
    await stopAgent(agent.id);
  } catch (error) {
    director.stopRequested = false;
    throw error;
  }
}

export async function replyToTaskCard({
  folder,
  cardId,
  text,
  attachments,
}: {
  folder: string;
  cardId: string;
  text: string;
  attachments?: AttachmentInput[];
}) {
  const card = openCards(folder).find(({ id }) => id === cardId);
  const director = getDirector(folder, chatOf(folder, card?.chat));
  await director.ready;
  const task = card ? (await readTasksAt(folder)).find(({ id }) => id === card.taskId) : undefined;
  const turn = await attachmentsTurn({
    folder: task?.worktree ?? directorFolder(director),
    text,
    attachments: attachments ?? [],
  });
  if (!displayText(turn)) return;
  const imagePaths = turn.images.map((image) => `Attached image: ${image.path}`).join("\n");
  replyToCard({ folder, cardId, text: [modelText(turn), imagePaths].filter(Boolean).join("\n") });
  if (card) {
    saveEntry(
      director,
      newEntry("user", {
        text: modelText(turn),
        images: messageImages(turn, task?.id),
        to: `${card.project} · ${card.taskTitle}`,
      }),
    );
  }
}

export async function sendToTask({
  folder,
  taskId,
  text,
  attachments,
}: {
  folder: string;
  taskId: string;
  text: string;
  attachments?: AttachmentInput[];
}) {
  const sent = await messageTaskAt(folder, taskId, { text, attachments });
  const { view } = sent;
  const director = getDirector(folder, chatOf(folder, view.chat));
  await director.ready;
  saveEntry(
    director,
    newEntry("user", {
      text: sent.text,
      images: sent.images,
      to: `${view.project} · ${view.title}`,
    }),
  );
}

export async function readChatImage({
  folder,
  chat,
  task,
  file,
}: {
  folder: string;
  chat: string | null;
  task: string | null;
  file: string;
}) {
  const from = await imageFolder(folder, chat, task);
  return from ? readSavedImage(from, file) : null;
}
}

export async function attachTaskToDirector(
  folder: string,
  task: TaskView,
  chat: string | null = null,
) {
  const director = getDirector(folder, chat);
  await director.ready;
  const current =
    director.turnTasksId && director.entries.find(({ id }) => id === director.turnTasksId);
  if (current && current.kind === "tasks") {
    saveEntry(director, { ...current, taskIds: [...current.taskIds, task.id] });
    return;
  }
  const entry = newEntry("tasks", { taskIds: [task.id] });
  saveEntry(director, entry);
  if (director.status === "answering") director.turnTasksId = entry.id;
}

export async function subscribeToDirector(
  folder: string,
  listener: (update: DirectorUpdate) => void,
  chat: string | null = null,
) {
  const director = getDirector(folder, chat);
  await director.ready;
  const tasks = await listTasksAt(folder);
  listener({
    type: "reset",
    entries: director.entries,
    tasks,
    cards: cardsOf(director),
    status: director.status,
    draft: director.draft,
    queue: director.pending.map((turn) => displayText(turn)),
  });
  director.listeners.add(listener);
  return () => {
    director.listeners.delete(listener);
  };
}

const PREVIEW_LENGTH = 120;

function previewOf(director: Director) {
  const last = director.entries.findLast(
    (entry) => entry.kind === "user" || entry.kind === "director",
  );
  const shown = last?.kind === "user" ? textWithImages(last.text, last.images) : (last?.text ?? "");
  const text = shown.replace(/\s+/g, " ").trim();
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text;
}

async function chatSummaries(
  folder: string,
): Promise<{ chats: ChatSummary[]; directors: Director[] }> {
  const managers = await listManagersAt(folder);
  const all = [getDirector(folder), ...managers.map(({ id }) => getDirector(folder, id))];
  await Promise.all(all.map(({ ready }) => ready));
  const chats = all.map((director, index) => ({
    chat: director.chat,
    name: index === 0 ? "" : managers[index - 1].name,
    project: index === 0 ? null : managers[index - 1].project,
    preview: previewOf(director),
    status: director.status,
    waiting: cardsOf(director).filter(
      (card) => card.kind === "question" || card.kind === "approval" || card.kind === "plan",
    ).length,
  }));
  return { chats, directors: all };
}

export async function subscribeToChats(folder: string, listener: (chats: ChatSummary[]) => void) {
  let closed = false;
  let following: Director[] = [];
  let queued = false;
  const onUpdate = (update: DirectorUpdate) => {
    if (update.type === "draft" || update.type === "task" || update.type === "queue") return;
    refresh();
  };
  const send = async () => {
    queued = false;
    const { chats, directors: current } = await chatSummaries(folder);
    if (closed) return;
    for (const director of following) director.listeners.delete(onUpdate);
    following = current;
    for (const director of following) director.listeners.add(onUpdate);
    listener(chats);
  };
  const refresh = () => {
    if (queued || closed) return;
    queued = true;
    queueMicrotask(
      () =>
        void send().catch((error: unknown) =>
          console.error("busyboy: could not read the chat list", error),
        ),
    );
  };
  const unsubscribe = subscribeToManagers(folder, refresh);
  await send();
  return () => {
    closed = true;
    unsubscribe();
    for (const director of following) director.listeners.delete(onUpdate);
  };
}

export async function adoptTasks(folder: string, taskIds: string[]) {
  if (taskIds.length === 0) return;
  const director = getDirector(folder);
  await director.ready;
  saveEntry(director, newEntry("tasks", { taskIds }));
}

export async function closeChat(folder: string, chat: string) {
  const key = directorKey(folder, chat);
  const director = directors.get(key);
  if (!director) return;
  director.closed = true;
  clearTimeout(director.batchTimer);
  clearTimeout(director.idleTimer);
  director.pending = [];
  const agentId = director.agentId;
  director.agentId = undefined;
  if (agentId) await stopAgent(agentId).catch(() => {});
  directors.delete(key);
}
