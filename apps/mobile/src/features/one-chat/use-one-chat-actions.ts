import type { DraftComposerAttachment } from "../../lib/composerImages";
import {
  CommandId,
  MessageId,
  ThreadId,
  type EnvironmentId,
  type ProjectId,
  type RunId,
} from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { uuidv4 } from "../../lib/uuid";
import { useThreadShell } from "../../state/entities";
import { useAnswerDecision } from "../../state/projectTeam";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/** Everything the one chat screen sends: Director messages, card answers, stop, side chats. */
export function useOneChatActions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly directorThreadId: ThreadId | null;
  readonly directorProjectId: ProjectId | null;
}) {
  const { environmentId, directorThreadId, directorProjectId } = input;
  const answerDecision = useAnswerDecision();
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, "stop the Director");
  const createThread = useAtomCommand(threadEnvironment.create, "open side chat");
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const startTurn = useAtomCommand(threadEnvironment.startTurn, "send side chat message");
  const director = useThreadShell(
    environmentId !== null && directorThreadId !== null
      ? { environmentId, threadId: directorThreadId }
      : null,
  );

  /** Sends through the durable outbox, the same path every thread composer uses. */
  const sendToDirector = useCallback(
    async (text: string, attachments: ReadonlyArray<DraftComposerAttachment> = []) => {
      if (environmentId === null || directorThreadId === null) return false;
      const metadata = makeQueuedMessageMetadata();
      await enqueueThreadOutboxMessage({
        environmentId,
        threadId: directorThreadId,
        messageId: MessageId.make(metadata.messageId),
        commandId: CommandId.make(metadata.commandId),
        text,
        attachments,
        createdAt: metadata.createdAt,
      });
      return true;
    },
    [environmentId, directorThreadId],
  );

  const answerCard = useCallback(
    (projectId: string, attentionItemId: string, answer: string) => {
      if (environmentId === null) return;
      return answerDecision(environmentId, {
        projectId: projectId as ProjectId,
        attentionItemId: attentionItemId as never,
        answer,
      });
    },
    [answerDecision, environmentId],
  );

  const stopDirector = useCallback(
    (runId: RunId | null) => {
      if (environmentId === null || directorThreadId === null || runId === null) return;
      return interruptTurn({ environmentId, input: { threadId: directorThreadId, runId } });
    },
    [environmentId, directorThreadId, interruptTurn],
  );

  /** A temporary thread in the Director's project; it never touches the Director thread. */
  const createSideChat = useCallback(async (): Promise<ThreadId | null> => {
    if (environmentId === null || directorProjectId === null || director === null) return null;
    const threadId = ThreadId.make(uuidv4());
    const result = await createThread({
      environmentId,
      input: {
        threadId,
        projectId: directorProjectId,
        title: "Side chat",
        modelSelection: director.modelSelection,
        runtimeMode: director.runtimeMode,
        interactionMode: director.interactionMode,
        branch: null,
        worktreePath: null,
      },
    });
    return result._tag === "Success" ? threadId : null;
  }, [createThread, director, directorProjectId, environmentId]);

  const sendToSideChat = useCallback(
    (threadId: ThreadId, text: string) => {
      if (environmentId === null || director === null) return;
      const metadata = makeQueuedMessageMetadata();
      return startTurn({
        environmentId,
        input: {
          threadId,
          commandId: CommandId.make(metadata.commandId),
          createdAt: metadata.createdAt,
          message: {
            messageId: MessageId.make(metadata.messageId),
            role: "user",
            text,
            attachments: [],
          },
          modelSelection: director.modelSelection,
          runtimeMode: director.runtimeMode,
          interactionMode: director.interactionMode,
        },
      });
    },
    [director, environmentId, startTurn],
  );

  const deleteSideChat = useCallback(
    (threadId: ThreadId) => {
      if (environmentId === null) return;
      return deleteThread({ environmentId, input: { threadId } });
    },
    [deleteThread, environmentId],
  );

  return useMemo(
    () => ({
      sendToDirector,
      answerCard,
      stopDirector,
      createSideChat,
      sendToSideChat,
      deleteSideChat,
    }),
    [answerCard, createSideChat, deleteSideChat, sendToDirector, sendToSideChat, stopDirector],
  );
}

export type OneChatActions = ReturnType<typeof useOneChatActions>;
