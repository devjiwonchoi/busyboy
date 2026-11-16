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
import type { AgentAnswer, AgentSnapshot } from '@/server/runner/contract'
import { companionInstructions, currentCompanion } from '@/server/companions'
import { readSettings } from '@/server/config'

// Minimal actions for the proof-of-runner chat. The Director chat replaces them.
// Server actions are public endpoints, so every argument is checked at runtime.

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string.`)
  return value
}

function parseAnswer(value: unknown): AgentAnswer {
  if (typeof value !== 'object' || value === null) throw new Error('The answer must be an object.')
  const answer = value as Record<string, unknown>
  if (answer.kind === 'approval') {
    if (typeof answer.allow !== 'boolean') throw new Error('An approval answer needs a boolean `allow`.')
    if (answer.message !== undefined && typeof answer.message !== 'string') throw new Error('`message` must be a string.')
    if (answer.forSession !== undefined && typeof answer.forSession !== 'boolean') {
      throw new Error('`forSession` must be a boolean.')
    }
    return { kind: 'approval', allow: answer.allow, forSession: answer.forSession, message: answer.message }
  }
  if (answer.kind === 'question') {
    const answers = answer.answers
    if (
      typeof answers !== 'object' ||
      answers === null ||
      Array.isArray(answers) ||
      !Object.values(answers).every((label) => typeof label === 'string')
    ) {
      throw new Error('A question answer needs `answers` mapping each question to a label.')
    }
    return { kind: 'question', answers: { ...(answers as Record<string, string>) } }
  }
  throw new Error('The answer kind must be "approval" or "question".')
}

export async function startAgentAction(message: unknown): Promise<AgentSnapshot> {
  const body = text(message, 'The message')
  // The stored choice, not defaultProvider(): that probes sign-in by starting the CLI on every message.
  const [{ defaultProvider: provider }, companion] = await Promise.all([readSettings(), currentCompanion()])
  // No project is needed to chat: the agent starts in the home folder and,
  // following its instructions, asks for a project folder when a task needs one.
  const agent = startAgent({
    provider: provider ?? 'claude',
    cwd: homedir(),
    instructions: companionInstructions(companion),
  })
  sendMessage(agent.id, body)
  return agent
}

export async function sendMessageAction(agentId: unknown, message: unknown) {
  sendMessage(text(agentId, 'The agent id'), text(message, 'The message'))
}

export async function interruptAgentAction(agentId: unknown) {
  await interruptAgent(text(agentId, 'The agent id'))
}

export async function stopAgentAction(agentId: unknown) {
  await stopAgent(text(agentId, 'The agent id'))
}

export async function resumeAgentAction(agentId: unknown) {
  return resumeAgent(text(agentId, 'The agent id'))
}

export async function compactAgentAction(agentId: unknown) {
  await compactAgent(text(agentId, 'The agent id'))
}

export async function answerAgentAction(agentId: unknown, requestId: unknown, answer: unknown) {
  return answerAgent(text(agentId, 'The agent id'), text(requestId, 'The request id'), parseAnswer(answer))
}
