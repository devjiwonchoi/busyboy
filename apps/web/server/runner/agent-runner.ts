import { randomUUID } from "node:crypto";

import { onServerShutdown } from "../shutdown";
import { claudeAdapter } from "./claude-adapter";
import { codexAdapter } from "./codex-adapter";
import type {
  AgentEvent,
  AgentSnapshot,
  AgentStatus,
  ProviderAdapter,
  ProviderId,
  ProviderSession,
  SignInStatus,
  StartAgentInput,
} from "./contract";
import { grokAdapter } from "./grok-adapter";

const MAX_RETAINED_EVENTS = 5_000;

type AgentRecord = {
  id: string;
  input: StartAgentInput;
  status: AgentStatus;
  events: AgentEvent[];
  listeners: Set<(event: AgentEvent) => void>;
  session: ProviderSession | null;
  interrupting: boolean;
};

type Registry = {
  agents: Map<string, AgentRecord>;
  shutdownHooked?: boolean;
  stoppingAll?: boolean;
};

const REGISTRY_KEY = Symbol.for("busyboy.agent-runner");
const globalStore = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
const registry: Registry = (globalStore[REGISTRY_KEY] ??= { agents: new Map() });

async function stopAllAgents() {
  registry.stoppingAll = true;
  await Promise.allSettled([...registry.agents.values()].map((agent) => agent.session?.stop()));
}

export function isLostSessionError(event: Extract<AgentEvent, { type: "error" }>) {
  return (
    event.code === "lost-session" || /No conversation found with session ID/i.test(event.message)
  );
}

function hookShutdown() {
  if (registry.shutdownHooked) return;
  registry.shutdownHooked = true;
  onServerShutdown(stopAllAgents);
  process.once("SIGTERM", () => void stopAllAgents());
  process.once("SIGINT", () => void stopAllAgents());
}

function adapterFor(provider: ProviderId): ProviderAdapter {
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
  return { id: record.id, provider: record.input.provider, status: record.status };
}

function record(agent: AgentRecord, event: AgentEvent) {
  if (agent.interrupting && event.type === "error" && event.code === "provider") return;
  switch (event.type) {
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
  agent.events.push(event);
  const extra = agent.events.length - MAX_RETAINED_EVENTS;
  if (extra > 0) agent.events.splice(0, extra);
  for (const listener of agent.listeners) listener(event);
}

export function startAgent(input: StartAgentInput): AgentSnapshot {
  if (registry.stoppingAll) throw new Error("BusyBoy is quitting, so no agent can start.");
  hookShutdown();
  const agent: AgentRecord = {
    id: randomUUID(),
    input,
    status: "starting",
    events: [],
    listeners: new Set(),
    session: null,
    interrupting: false,
  };
  registry.agents.set(agent.id, agent);
  try {
    agent.session = adapterFor(input.provider).start({
      ...input,
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
  return snapshot(agent);
}

export function sendMessage(agentId: string, text: string) {
  const agent = getRecord(agentId);
  if (!agent.session) throw new Error("The agent is stopped. Resume it first.");
  if (agent.status === "idle" || agent.status === "starting") agent.status = "running";
  agent.session.send(text);
}

export async function interruptAgent(agentId: string) {
  const agent = getRecord(agentId);
  if (!agent.session || agent.status !== "running") return;
  agent.interrupting = true;
  try {
    await agent.session.interrupt();
  } catch (error) {
    agent.interrupting = false;
    throw error;
  }
}

export function getAgent(agentId: string): AgentSnapshot | undefined {
  const agent = registry.agents.get(agentId);
  return agent && snapshot(agent);
}

export function subscribeToAgent(
  agentId: string,
  listener: (event: AgentEvent) => void,
): (() => void) | null {
  const agent = registry.agents.get(agentId);
  if (!agent) return null;
  for (const event of agent.events) listener(event);
  agent.listeners.add(listener);
  return () => agent.listeners.delete(listener);
}

export function providerSignInStatus(provider: ProviderId): Promise<SignInStatus> {
  return adapterFor(provider).signInStatus();
}
