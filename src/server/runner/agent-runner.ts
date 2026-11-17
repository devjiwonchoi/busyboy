import { randomUUID } from "node:crypto";

import { SERVER_TOKEN_ENV } from "@/lib/server-token";

import { onServerShutdown } from "../shutdown";
import { claudeAdapter } from "./claude-adapter";
import { codexAdapter } from "./codex-adapter";
import type {
  AgentAnswer,
  AgentEvent,
  AgentEventEnvelope,
  AgentSnapshot,
  AgentStatus,
  ProviderAdapter,
  ProviderId,
  ProviderSession,
  SignInStatus,
  StartAgentInput,
} from "./contract";
import { grokAdapter } from "./grok-adapter";
import { createScriptedAdapter, hasScripts, SCRIPTS_ENV } from "./scripted-provider";
import { asTurn, displayText, type UserTurn } from "./user-turn";

const MAX_RETAINED_EVENTS = 5_000;

type AgentRecord = {
  id: string;
  input: StartAgentInput;
  status: AgentStatus;
  sessionId?: string;
  events: AgentEventEnvelope[];
  lastSeq: number;
  listeners: Set<(envelope: AgentEventEnvelope) => void>;
  session: ProviderSession | null;
  pending: Map<string, AgentAnswer["kind"]>;
  interrupting: boolean;
};

type Registry = {
  agents: Map<string, AgentRecord>;
  shutdownHooked?: boolean;
  stoppingAll?: boolean;
};

// Kept on globalThis: a module-level Map is re-created when `next dev` reloads
// this module, which would orphan running agent processes.
const REGISTRY_KEY = Symbol.for("busyboy.agent-runner");
const globalStore = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
const registry: Registry = (globalStore[REGISTRY_KEY] ??= { agents: new Map() });

// Claude's process-group watcher does not end commands the CLI detached, so quitting has to stop each agent while the server still runs.
export async function stopAllAgents() {
  registry.stoppingAll = true;
  await Promise.allSettled([...registry.agents.values()].map((agent) => agent.session?.stop()));
}

// Codex and Grok report lost-session. Claude only says so in its message.
export function isLostSessionError(event: Extract<AgentEvent, { type: "error" }>) {
  return (
    event.code === "lost-session" || /No conversation found with session ID/i.test(event.message)
  );
}

export function isStoppingAllAgents() {
  return Boolean(registry.stoppingAll);
}

function hookShutdown() {
  if (registry.shutdownHooked) return;
  registry.shutdownHooked = true;
  // Next exits on Ctrl+C once its connections close, without waiting for other signal handlers.
  onServerShutdown(stopAllAgents);
  process.once("SIGTERM", () => void stopAllAgents());
  process.once("SIGINT", () => void stopAllAgents());
}

// A launch token means a real install, so BUSYBOY_PROVIDER_SCRIPTS is ignored there.
function adapterFor(provider: ProviderId): ProviderAdapter {
  const scripts = process.env[SCRIPTS_ENV];
  if (scripts && !process.env[SERVER_TOKEN_ENV] && hasScripts(scripts, provider))
    return createScriptedAdapter(scripts);
  if (provider === "codex") return codexAdapter;
  if (provider === "grok") return grokAdapter;
  return claudeAdapter;
}

function getRecord(agentId: string) {
  const record = registry.agents.get(agentId);
  if (!record) throw new Error(`Unknown agent ${agentId}.`);
  return record;
}

function snapshot(record: AgentRecord): AgentSnapshot {
  return {
    id: record.id,
    provider: record.input.provider,
    cwd: record.input.cwd,
    permissionMode: record.input.permissionMode ?? "auto",
    status: record.status,
    sessionId: record.sessionId,
    lastSeq: record.lastSeq,
  };
}

function record(agent: AgentRecord, event: AgentEvent) {
  if (agent.interrupting && event.type === "error" && event.code === "provider") return;
  switch (event.type) {
    case "started":
      agent.status = "starting";
      break;
    case "session":
      agent.sessionId = event.sessionId;
      break;
    case "approval":
      agent.pending.set(event.requestId, "approval");
      agent.status = "waiting";
      break;
    case "question":
      agent.pending.set(event.requestId, "question");
      agent.status = "waiting";
      break;
    case "answered":
      agent.pending.delete(event.requestId);
      if (agent.status === "waiting" && agent.pending.size === 0) agent.status = "running";
      break;
    case "turn-done":
      if (agent.interrupting) {
        event = { ...event, interrupted: true };
        agent.interrupting = false;
      }
      agent.status = event.more ? "running" : "idle";
      break;
    case "stopped":
      if (agent.status === "stopped") return;
      agent.interrupting = false;
      agent.status = "stopped";
      agent.session = null;
      break;
  }
  if (event.type === "turn-done" || event.type === "stopped") {
    for (const requestId of agent.pending.keys()) push(agent, { type: "answered", requestId });
    agent.pending.clear();
  }
  push(agent, event);
}

function push(agent: AgentRecord, event: AgentEvent) {
  const envelope: AgentEventEnvelope = {
    seq: agent.lastSeq + 1,
    at: Date.now(),
    agentId: agent.id,
    event,
  };
  agent.lastSeq = envelope.seq;
  agent.events.push(envelope);
  const extra = agent.events.length - MAX_RETAINED_EVENTS;
  if (extra > 0) agent.events.splice(0, extra);
  for (const listener of agent.listeners) listener(envelope);
}

function launch(agent: AgentRecord, resumeSessionId?: string) {
  agent.status = "starting";
  agent.interrupting = false;
  record(agent, {
    type: "started",
    resumed: Boolean(resumeSessionId || agent.input.forkSessionId),
  });
  try {
    agent.session = adapterFor(agent.input.provider).start({
      provider: agent.input.provider,
      cwd: agent.input.cwd,
      instructions: agent.input.instructions,
      permissionMode: agent.input.permissionMode ?? "auto",
      resumeSessionId,
      mcpServers: agent.input.mcpServers,
      forkSessionId: resumeSessionId ? undefined : agent.input.forkSessionId,
      noTools: agent.input.noTools,
      alwaysAsk: agent.input.alwaysAsk,
      privateFolder: agent.input.privateFolder,
      noFileEdits: agent.input.noFileEdits,
      rulesFolder: agent.input.rulesFolder,
      recordFolder: agent.input.recordFolder,
      emit: (event) => record(agent, event),
    });
    if (agent.status === "starting") agent.status = "idle";
  } catch (error) {
    record(agent, {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      code: "provider",
    });
    record(agent, { type: "stopped", finished: false });
  }
}

export function startAgent(input: StartAgentInput): AgentSnapshot {
  if (registry.stoppingAll) throw new Error("BusyBoy is quitting, so no agent can start.");
  hookShutdown();
  const agent: AgentRecord = {
    id: randomUUID(),
    input: { ...input, permissionMode: input.permissionMode ?? "auto" },
    status: "starting",
    events: [],
    lastSeq: 0,
    listeners: new Set(),
    session: null,
    pending: new Map(),
    interrupting: false,
  };
  registry.agents.set(agent.id, agent);
  launch(agent, input.resumeSessionId);
  return snapshot(agent);
}

export function sendMessage(agentId: string, turn: UserTurn | string) {
  const agent = getRecord(agentId);
  if (!agent.session) throw new Error("The agent is stopped. Resume it first.");
  const message = asTurn(turn);
  record(agent, { type: "user-message", text: displayText(message) || message.text });
  if (agent.status === "idle" || agent.status === "starting") agent.status = "running";
  agent.session.send(message);
}

export async function interruptAgent(agentId: string) {
  const agent = getRecord(agentId);
  if (!agent.session || (agent.status !== "running" && agent.status !== "waiting")) return;
  agent.interrupting = true;
  try {
    await agent.session.interrupt();
  } catch (error) {
    agent.interrupting = false;
    throw error;
  }
}

export async function stopAgent(agentId: string) {
  const agent = getRecord(agentId);
  if (!agent.session) return;
  await agent.session.stop();
}

export function resumeAgent(agentId: string): AgentSnapshot {
  const agent = getRecord(agentId);
  if (agent.session) return snapshot(agent);
  launch(
    agent,
    agent.input.forkSessionId ? undefined : (agent.sessionId ?? agent.input.resumeSessionId),
  );
  return snapshot(agent);
}

export async function compactAgent(agentId: string) {
  const agent = getRecord(agentId);
  if (!agent.session) throw new Error("The agent is stopped.");
  if (agent.status === "idle") agent.status = "running";
  await agent.session.compact();
}

export function answerAgent(agentId: string, requestId: string, answer: AgentAnswer) {
  const agent = getRecord(agentId);
  const kind = agent.pending.get(requestId);
  if (!agent.session || !kind) return false;
  if (kind !== answer.kind)
    throw new Error(`Request ${requestId} takes an answer of kind ${kind}, not ${answer.kind}.`);
  agent.session.answer(requestId, answer);
  record(agent, { type: "answered", requestId });
  return true;
}

export function removeAgent(agentId: string) {
  const agent = registry.agents.get(agentId);
  if (!agent || agent.session) return false;
  agent.listeners.clear();
  registry.agents.delete(agentId);
  return true;
}

export function getAgent(agentId: string): AgentSnapshot | undefined {
  const agent = registry.agents.get(agentId);
  return agent && snapshot(agent);
}

export function listAgents(): AgentSnapshot[] {
  return [...registry.agents.values()].map(snapshot);
}

export function subscribeToAgent(
  agentId: string,
  afterSeq: number,
  listener: (envelope: AgentEventEnvelope) => void,
): (() => void) | null {
  const agent = registry.agents.get(agentId);
  if (!agent) return null;
  for (const envelope of agent.events) {
    if (envelope.seq > afterSeq) listener(envelope);
  }
  agent.listeners.add(listener);
  return () => agent.listeners.delete(listener);
}

export function lastAgentReply(agentId: string): string | null {
  const agent = registry.agents.get(agentId);
  if (!agent) return null;
  let itemId: string | undefined;
  let text = "";
  for (let index = agent.events.length - 1; index >= 0; index -= 1) {
    const { event } = agent.events[index];
    if (event.type !== "text" && event.type !== "text-delta") continue;
    if (itemId === undefined) itemId = event.itemId;
    // An item's events are contiguous, so an earlier item ends the reply.
    else if (event.itemId !== itemId) break;
    if (event.type === "text") {
      text = event.text;
      break;
    }
    text = event.text + text;
  }
  return text.trim() ? text : null;
}

export function providerSignInStatus(provider: ProviderId): Promise<SignInStatus> {
  return adapterFor(provider).signInStatus();
}
