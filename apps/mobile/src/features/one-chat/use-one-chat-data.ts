import { deriveThreadRuntime } from "@t3tools/client-runtime/state/thread-execution";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  NodeGraph,
  OrchestrationV2ThreadProjection,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  buildActionCards,
  buildWorkItems,
  type ActionCard,
  type OneChatProject,
  type WorkItem,
} from "@t3tools/shared/one-chat";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { useMemo } from "react";

import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useProjectManagerEntries } from "../../state/projectTeam";
import { useEnvironmentThread } from "../../state/threads";
import { useNodeGraph } from "./node-graph";

export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "notice";
  readonly text: string;
  readonly createdAt: string;
  readonly streaming: boolean;
}

export interface ThreadChat {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly running: boolean;
  readonly activeRunId: RunId | null;
}

/** Chat messages of one thread, without tool calls or work log. */
export function chatMessagesOf(
  projection: OrchestrationV2ThreadProjection | null,
): ReadonlyArray<ChatMessage> {
  if (projection === null) return [];
  const messages: ChatMessage[] = [];
  for (const message of projection.messages) {
    const createdAt = DateTime.formatIso(message.createdAt);
    if (message.notification) {
      messages.push({
        id: message.id,
        role: "notice",
        text: message.notification.summary,
        createdAt,
        streaming: false,
      });
      continue;
    }
    if (message.role === "system" || message.text.trim().length === 0) continue;
    messages.push({
      id: message.id,
      role: message.role,
      text: message.text,
      createdAt,
      streaming: message.streaming,
    });
  }
  return messages;
}

/** Messages and run state of a thread, subscribed live. */
export function useThreadChat(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ThreadChat {
  const state = useEnvironmentThread(environmentId, threadId);
  const projection = Option.getOrNull(state.data);
  return useMemo(() => {
    const runtime = projection ? deriveThreadRuntime(projection) : null;
    const running = threadRuntimeIsActive(runtime);
    return {
      messages: chatMessagesOf(projection),
      running,
      activeRunId: running ? (runtime?.activeRunId ?? null) : null,
    };
  }, [projection]);
}

export interface OneChatData {
  readonly environmentId: EnvironmentId | null;
  readonly directorThreadId: ThreadId | null;
  readonly directorProjectId: ProjectId | null;
  readonly projects: ReadonlyArray<OneChatProject>;
  /** Skill-based work; null while it loads or when the adapter is unavailable. */
  readonly graph: NodeGraph | null;
  readonly cards: ReadonlyArray<ActionCard>;
  readonly workItems: ReadonlyArray<WorkItem>;
  readonly chat: ThreadChat;
}

/** The Director chat and every project's work in the Director's environment. */
export function useOneChatData(): OneChatData {
  const { environments } = useEnvironments();
  const entries = useProjectManagerEntries(
    environments.map((environment) => environment.environmentId),
  );
  const allProjects = useProjects();
  const director = entries.find((entry) => entry.summary.kind === "director") ?? null;
  const environmentId = director?.environmentId ?? null;
  const projects = useMemo(
    () =>
      entries
        .filter(
          (entry) => entry.environmentId === environmentId && entry.summary.kind !== "director",
        )
        .map(
          (entry): OneChatProject => ({
            projectId: entry.summary.projectId,
            name:
              allProjects.find(
                (project) =>
                  project.environmentId === entry.environmentId &&
                  project.id === entry.summary.projectId,
              )?.title ?? entry.summary.projectId,
            summary: entry.summary,
          }),
        ),
    [entries, environmentId, allProjects],
  );
  const cards = useMemo(() => buildActionCards(projects), [projects]);
  const graph = useNodeGraph(environmentId);
  const workItems = useMemo(() => buildWorkItems(projects, graph), [projects, graph]);
  const directorThreadId = director?.summary.pmThreadId ?? null;
  const chat = useThreadChat(environmentId, directorThreadId);
  return {
    environmentId,
    directorThreadId,
    directorProjectId: director?.summary.projectId ?? null,
    projects,
    graph,
    cards,
    workItems,
    chat,
  };
}
