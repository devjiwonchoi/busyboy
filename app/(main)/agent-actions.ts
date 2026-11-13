'use server'

import { homedir } from 'node:os'
import {
  answerAgent,
  compactAgent,
  interruptAgent,
  resumeAgent,
  sendMessage,
  startAgent,
  stopAgent,
} from '@/server/runner/agent-runner'
import type { AgentAnswer, AgentSnapshot, ProviderId } from '@/server/runner/contract'

// Minimal actions for the proof-of-runner chat. The master chat replaces them.

export async function startAgentAction(text: string, provider: ProviderId = 'claude'): Promise<AgentSnapshot> {
  const agent = startAgent({ provider: provider === 'codex' ? 'codex' : 'claude', cwd: homedir() })
  sendMessage(agent.id, text)
  return agent
}

export async function sendMessageAction(agentId: string, text: string) {
  sendMessage(agentId, text)
}

export async function interruptAgentAction(agentId: string) {
  await interruptAgent(agentId)
}

export async function stopAgentAction(agentId: string) {
  await stopAgent(agentId)
}

export async function resumeAgentAction(agentId: string) {
  return resumeAgent(agentId)
}

export async function compactAgentAction(agentId: string) {
  await compactAgent(agentId)
}

export async function answerAgentAction(agentId: string, requestId: string, answer: AgentAnswer) {
  return answerAgent(agentId, requestId, answer)
}
