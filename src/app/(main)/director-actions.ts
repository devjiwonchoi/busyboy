"use server";

import type { AttachmentInput } from "@/lib/chat-attachments";
import { mergePullRequests, readTaskPlan } from "@/server/cards/work-cards";
import { AttachmentError } from "@/server/chat-attachments";
import { dataFolder } from "@/server/config";
import {
  replyToTaskCard,
  reviseDirectorMessage,
  sendDirectorQueueNow,
  sendToDirector,
  sendToTask,
  stopDirector,
} from "@/server/director/chat";
import { getManagerAt } from "@/server/managers";
import { busyboyMcpServers } from "@/server/mcp-tools";
import { defaultProvider, providerState } from "@/server/providers";
import type { ProviderId } from "@/server/runner/contract";
import { answerCard, approveCard } from "@/server/task-cards";
import { archiveTask, restoreTask, stopTask, TaskError } from "@/server/tasks";

const MAX_MESSAGE_LENGTH = 100_000;

async function resolveDirectorProvider(current?: ProviderId): Promise<ProviderId | null> {
  const provider = await defaultProvider();
  if (provider) return provider;
  if (current && (await providerState(current)).state === "unknown") return current;
  return null;
}

async function checkChat(chat: unknown) {
  if (chat === null || chat === undefined) return null;
  if (typeof chat !== "string" || !(await getManagerAt(await dataFolder(), chat)))
    throw new Error("That manager no longer exists.");
  return chat;
}

function attachmentInputs(value: unknown): AttachmentInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AttachmentError("Attachments must be a list of files.");
  return value.map((item) => {
    if (!item || typeof item !== "object")
      throw new AttachmentError("An attachment is missing its name or contents.");
    const record = item as Record<string, unknown>;
    if (
      typeof record.name !== "string" ||
      typeof record.mediaType !== "string" ||
      typeof record.data !== "string"
    ) {
      throw new AttachmentError("An attachment is missing its name or contents.");
    }
    return { name: record.name, mediaType: record.mediaType, data: record.data };
  });
}

export async function sendToDirectorAction(
  text: string,
  chat?: string | null,
  attachments?: AttachmentInput[],
): Promise<{ error?: string }> {
  if (typeof text !== "string" || text.length > MAX_MESSAGE_LENGTH) {
    throw new Error("A message must be non-empty text of at most 100,000 characters.");
  }
  try {
    const files = attachmentInputs(attachments);
    if (!text.trim() && files.length === 0)
      throw new Error("A message must be non-empty text of at most 100,000 characters.");
    const manager = await checkChat(chat);
    await sendToDirector({
      folder: await dataFolder(),
      chat: manager,
      text,
      attachments: files,
      resolveProvider: (current) => resolveDirectorProvider(current),
      mcp: await busyboyMcpServers(undefined, undefined, manager ?? undefined),
    });
    return {};
  } catch (error) {
    if (error instanceof AttachmentError) return { error: error.message };
    throw error;
  }
}

export async function stopDirectorAction(chat?: string | null) {
  await stopDirector(await dataFolder(), await checkChat(chat));
}

export async function sendDirectorQueueNowAction(chat?: string | null) {
  await sendDirectorQueueNow(await dataFolder(), await checkChat(chat));
}

export async function reviseDirectorMessageAction(
  entryId: string,
  text: string,
  chat?: string | null,
  attachments?: AttachmentInput[],
  keepImages?: boolean,
): Promise<{ error?: string }> {
  checkId(entryId, "The message");
  if (typeof text !== "string" || text.length > MAX_MESSAGE_LENGTH) {
    throw new Error("A message must be non-empty text of at most 100,000 characters.");
  }
  try {
    const files = attachmentInputs(attachments);
    if (!text.trim() && files.length === 0 && keepImages !== true)
      throw new Error("A message must be non-empty text of at most 100,000 characters.");
    const manager = await checkChat(chat);
    await reviseDirectorMessage({
      folder: await dataFolder(),
      chat: manager,
      entryId,
      text,
      attachments: files,
      keepImages: keepImages === true,
      resolveProvider: (current) => resolveDirectorProvider(current),
      mcp: await busyboyMcpServers(undefined, undefined, manager ?? undefined),
    });
    return {};
  } catch (error) {
    if (error instanceof AttachmentError) return { error: error.message };
    throw error;
  }
}

function checkId(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 500) {
    throw new Error(`${name} must be a non-empty id.`);
  }
}

export async function answerCardAction(cardId: string, choices: string[][]) {
  checkId(cardId, "The card");
  const valid =
    Array.isArray(choices) &&
    choices.every(
      (labels) => Array.isArray(labels) && labels.every((label) => typeof label === "string"),
    );
  if (!valid) {
    throw new Error("Choices must list the chosen option labels of each question, in order.");
  }
  answerCard({ folder: await dataFolder(), cardId, choices });
}

export async function approveCardAction(cardId: string) {
  checkId(cardId, "The card");
  approveCard({ folder: await dataFolder(), cardId });
}

export async function readTaskPlanAction(taskId: string) {
  checkId(taskId, "The task");
  return readTaskPlan({ folder: await dataFolder(), taskId });
}

export async function mergePullRequestsAction(cardId: string) {
  checkId(cardId, "The card");
  await mergePullRequests({ folder: await dataFolder(), cardId });
}

export async function replyToCardAction(
  cardId: string,
  text: string,
  attachments?: AttachmentInput[],
): Promise<{ error?: string }> {
  checkId(cardId, "The card");
  if (typeof text !== "string" || text.length > MAX_MESSAGE_LENGTH) {
    throw new Error("A message must be non-empty text of at most 100,000 characters.");
  }
  try {
    const files = attachmentInputs(attachments);
    if (!text.trim() && files.length === 0)
      throw new Error("A message must be non-empty text of at most 100,000 characters.");
    await replyToTaskCard({ folder: await dataFolder(), cardId, text, attachments: files });
    return {};
  } catch (error) {
    if (error instanceof AttachmentError) return { error: error.message };
    throw error;
  }
}

export async function stopTaskAction(taskId: string) {
  checkId(taskId, "The task");
  await stopTask(taskId);
}

// A thrown server-action error's message does not reach the window in a production build.
export async function messageTaskAction(
  taskId: string,
  text: string,
  attachments?: AttachmentInput[],
): Promise<{ error?: string }> {
  checkId(taskId, "The task");
  if (typeof text !== "string" || text.length > MAX_MESSAGE_LENGTH) {
    throw new Error("A message must be non-empty text of at most 100,000 characters.");
  }
  try {
    const files = attachmentInputs(attachments);
    if (!text.trim() && files.length === 0)
      throw new Error("A message must be non-empty text of at most 100,000 characters.");
    await sendToTask({ folder: await dataFolder(), taskId, text, attachments: files });
    return {};
  } catch (error) {
    if (error instanceof AttachmentError || error instanceof TaskError)
      return { error: error.message };
    throw error;
  }
}

export async function archiveTaskAction(
  taskId: string,
): Promise<{ error?: string; worktreeKept?: boolean }> {
  checkId(taskId, "The task");
  try {
    return { worktreeKept: (await archiveTask(taskId)).worktreeKept };
  } catch (error) {
    if (error instanceof TaskError) return { error: error.message };
    throw error;
  }
}

export async function restoreTaskAction(taskId: string): Promise<{ error?: string }> {
  checkId(taskId, "The task");
  try {
    await restoreTask(taskId);
    return {};
  } catch (error) {
    if (error instanceof TaskError) return { error: error.message };
    throw error;
  }
}
