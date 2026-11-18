import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { MessageAttachment } from "@/lib/chat-attachments";

import { readSettings } from "../config";
import { pathKey } from "../paths";
import { defaultProvider, PROVIDERS } from "../providers";
import {
  getAgent,
  interruptAgent,
  isLostSessionError,
  sendMessage,
  startAgent,
  subscribeToAgent,
} from "../runner/agent-runner";
import type { AgentEvent, ProviderId } from "../runner/contract";
import { AttachmentError, saveAttachments } from "./attachments";
import { DIRECTOR_INSTRUCTIONS } from "./context";
import { appendTranscriptLine, readTranscript, type TranscriptCursor } from "./transcript-log";

const DIRECTOR_FOLDER = "director";
const STATE_FILE = "state.json";

export type ChatEntry =
  | { id: string; at: string; kind: "user"; text: string; attachments?: MessageAttachment[] }
  | { id: string; at: string; kind: "director"; text: string; interrupted?: boolean }
  | { id: string; at: string; kind: "note"; text: string; tone: "info" | "error" };

export type DirectorStatus = "idle" | "answering";

export type DirectorUpdate =
  | { type: "reset"; entries: ChatEntry[]; status: DirectorStatus; draft: string }
  | { type: "entry"; entry: ChatEntry }
  | { type: "draft"; text: string }
  | { type: "status"; status: DirectorStatus };

type DirectorState = {
  provider?: ProviderId;
  sessionId?: string;
};

type Director = {
  folder: string;
  ready: Promise<void>;
  loaded: boolean;
  entries: ChatEntry[];
  state: DirectorState;
  agentId?: string;
  stopBeforeStart: boolean;
  unsubscribe?: () => void;
  status: DirectorStatus;
  draftItems: Map<string, string>;
  draftOrder: string[];
  writes: Promise<unknown>;
  transcriptFile: TranscriptCursor;
  listeners: Set<(update: DirectorUpdate) => void>;
};

const DIRECTORS_KEY = Symbol.for("busyboy.directors");
const globalStore = globalThis as typeof globalThis & { [DIRECTORS_KEY]?: Map<string, Director> };
const directors = (globalStore[DIRECTORS_KEY] ??= new Map());

const MAX_MESSAGE_LENGTH = 100_000;

function directorFolder(director: Director) {
  return join(director.folder, DIRECTOR_FOLDER);
}

export function directorDataFolder(folder: string) {
  return join(folder, DIRECTOR_FOLDER);
}

function getDirector(folder: string): Director {
  const key = pathKey(folder);
  let director = directors.get(key);
  if (director) return director;
  director = {
    folder,
    ready: Promise.resolve(),
    loaded: false,
    entries: [],
    state: {},
    status: "idle",
    stopBeforeStart: false,
    draftItems: new Map(),
    draftOrder: [],
    writes: Promise.resolve(),
    transcriptFile: {},
    listeners: new Set(),
  };
  director.ready = load(director).finally(() => {
    director.loaded = true;
  });
  directors.set(key, director);
  return director;
}

async function load(director: Director) {
  const folder = directorFolder(director);
  const lines = (await readTranscript(folder).catch(() => "")).split("\n");
  const byId = new Map<string, ChatEntry>();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isEntry(value)) byId.set(value.id, value);
    } catch {}
  }
  director.entries = [...byId.values()];
  try {
    const state = JSON.parse(await readFile(join(folder, STATE_FILE), "utf8")) as Partial<
      Record<keyof DirectorState, unknown>
    > | null;
    director.state =
      state &&
      PROVIDERS.some(({ id }) => id === state.provider) &&
      typeof state.sessionId === "string"
        ? { provider: state.provider as ProviderId, sessionId: state.sessionId }
        : {};
  } catch {
    director.state = {};
  }
}

function isEntry(value: unknown): value is ChatEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || typeof entry.at !== "string") return false;
  if (entry.kind === "user")
    return (
      typeof entry.text === "string" &&
      (entry.attachments === undefined || isAttachments(entry.attachments))
    );
  if (entry.kind === "director") return typeof entry.text === "string";
  if (entry.kind === "note")
    return typeof entry.text === "string" && (entry.tone === "info" || entry.tone === "error");
  return false;
}

function isAttachments(value: unknown): value is MessageAttachment[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item: Record<string, unknown> | null) =>
        item !== null &&
        typeof item === "object" &&
        typeof item.name === "string" &&
        typeof item.file === "string" &&
        typeof item.image === "boolean",
    )
  );
}

function newEntry(kind: "director", text: string, interrupted?: boolean): ChatEntry;
function newEntry(kind: "note", text: string, tone: "info" | "error"): ChatEntry;
function newEntry(
  kind: "director" | "note",
  text: string,
  extra?: boolean | "info" | "error",
): ChatEntry {
  const base = { id: randomUUID(), at: new Date().toISOString(), text };
  if (kind === "note") return { ...base, kind, tone: extra === "error" ? "error" : "info" };
  return { ...base, kind, ...(extra === true ? { interrupted: true } : {}) };
}

function saveEntry(director: Director, entry: ChatEntry) {
  const index = director.entries.findIndex(({ id }) => id === entry.id);
  if (index === -1) director.entries.push(entry);
  else director.entries[index] = entry;
  broadcast(director, { type: "entry", entry });
  const line = `${JSON.stringify(entry)}\n`;
  director.writes = director.writes
    .catch(() => {})
    .then(() => appendTranscriptLine(directorFolder(director), line, director.transcriptFile));
}

function saveState(director: Director) {
  const file = join(directorFolder(director), STATE_FILE);
  const body = `${JSON.stringify(director.state)}\n`;
  director.writes = director.writes
    .catch(() => {})
    .then(async () => {
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, body);
      await rename(temporary, file);
    });
}

function broadcast(director: Director, update: DirectorUpdate) {
  for (const listener of director.listeners) listener(update);
}

function draftText(director: Director) {
  return director.draftOrder
    .map((id) => director.draftItems.get(id) ?? "")
    .filter((part) => part.length > 0)
    .join("");
}

function publishDraft(director: Director) {
  broadcast(director, { type: "draft", text: draftText(director) });
}

function setStatus(director: Director, status: DirectorStatus) {
  if (director.status === status) return;
  director.status = status;
  broadcast(director, { type: "status", status });
}

function onAgentEvent(director: Director, event: AgentEvent) {
  switch (event.type) {
    case "session":
      director.state.sessionId = event.sessionId;
      saveState(director);
      return;
    case "text-delta": {
      if (!director.draftItems.has(event.itemId)) director.draftOrder.push(event.itemId);
      director.draftItems.set(
        event.itemId,
        (director.draftItems.get(event.itemId) ?? "") + event.text,
      );
      publishDraft(director);
      return;
    }
    case "text": {
      if (!director.draftItems.has(event.itemId)) director.draftOrder.push(event.itemId);
      director.draftItems.set(event.itemId, event.text);
      publishDraft(director);
      return;
    }
    case "turn-done": {
      const text = draftText(director);
      director.draftItems.clear();
      director.draftOrder = [];
      publishDraft(director);
      if (text) saveEntry(director, newEntry("director", text, event.interrupted));
      else if (event.interrupted) saveEntry(director, newEntry("note", "Stopped.", "info"));
      setStatus(director, "idle");
      return;
    }
    case "error":
      if (isLostSessionError(event)) {
        director.state.sessionId = undefined;
        saveState(director);
      }
      saveEntry(director, newEntry("note", event.message, "error"));
      return;
    case "stopped":
      if (director.status === "answering") {
        const text = draftText(director);
        director.draftItems.clear();
        director.draftOrder = [];
        publishDraft(director);
        if (text) saveEntry(director, newEntry("director", text, true));
        setStatus(director, "idle");
      }
      return;
    default:
      return;
  }
}

async function ensureAgent(director: Director) {
  const running = director.agentId ? getAgent(director.agentId) : undefined;
  if (running && running.status !== "stopped") {
    const chosen = (await readSettings()).defaultProvider;
    if (!chosen || chosen === running.provider) return running;
  }
  const provider = await defaultProvider();
  if (!provider) throw new Error("No agent is signed in. Open Setup to sign in.");
  if (running && running.status !== "stopped" && running.provider === provider) return running;
  if (director.state.provider && director.state.provider !== provider) {
    director.state.sessionId = undefined;
    director.state.provider = provider;
    saveState(director);
  } else director.state.provider = provider;
  const snapshot = startAgent({
    provider,
    cwd: homedir(),
    instructions: DIRECTOR_INSTRUCTIONS,
    resumeSessionId: director.state.sessionId,
  });
  director.agentId = snapshot.id;
  director.unsubscribe?.();
  director.unsubscribe =
    subscribeToAgent(snapshot.id, (event) => onAgentEvent(director, event)) ?? undefined;
  return snapshot;
}

export async function sendToDirector(input: {
  folder: string;
  text: string;
  files: File[];
}): Promise<{ error?: string }> {
  const text = input.text.trim();
  if ((!text && input.files.length === 0) || input.text.length > MAX_MESSAGE_LENGTH) {
    return { error: "A message must be non-empty text of at most 100,000 characters." };
  }
  const director = getDirector(input.folder);
  await director.ready;
  if (director.status === "answering") {
    return { error: "Wait for the reply to finish, or stop it." };
  }
  director.stopBeforeStart = false;
  setStatus(director, "answering");
  let prepared: Awaited<ReturnType<typeof saveAttachments>>;
  try {
    prepared = await saveAttachments(directorFolder(director), text, input.files);
  } catch (error) {
    setStatus(director, "idle");
    if (error instanceof AttachmentError) return { error: error.message };
    throw error;
  }
  saveEntry(director, {
    id: randomUUID(),
    at: new Date().toISOString(),
    kind: "user",
    text,
    ...(prepared.saved.length > 0 ? { attachments: prepared.saved } : {}),
  });
  try {
    const agent = await ensureAgent(director);
    if (!agent || getAgent(agent.id)?.status === "stopped") {
      throw new Error("The agent stopped before the message was sent.");
    }
    if (director.stopBeforeStart) {
      director.stopBeforeStart = false;
      saveEntry(director, newEntry("note", "Stopped.", "info"));
      setStatus(director, "idle");
      return {};
    }
    sendMessage(agent.id, prepared.turn);
    return {};
  } catch (error) {
    setStatus(director, "idle");
    const message = error instanceof Error ? error.message : String(error);
    saveEntry(director, newEntry("note", message, "error"));
    return { error: message };
  }
}

export async function stopDirector(folder: string) {
  const director = getDirector(folder);
  await director.ready;
  if (director.status !== "answering") return;
  const agent = director.agentId ? getAgent(director.agentId) : undefined;
  if (agent?.status === "running") await interruptAgent(agent.id);
  else director.stopBeforeStart = true;
}

export async function subscribeToDirector(
  folder: string,
  listener: (update: DirectorUpdate) => void,
) {
  const director = getDirector(folder);
  void defaultProvider();
  await director.ready;
  listener({
    type: "reset",
    entries: director.entries,
    status: director.status,
    draft: draftText(director),
  });
  director.listeners.add(listener);
  return () => {
    director.listeners.delete(listener);
  };
}
