/**
 * The few thread commands the one chat screen needs, wrapped so the screen never reaches into
 * the old chat components: send a message, stop a turn, and make or remove a temporary thread.
 */
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  UploadChatAttachment,
} from "@t3tools/contracts";

import { newMessageId, newThreadId } from "~/lib/utils";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

export interface ThreadModes {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface SendInput extends ThreadModes {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments: ReadonlyArray<UploadChatAttachment>;
}

export interface TempThreadInput extends ThreadModes {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
}

export interface OneChatCommands {
  /** Sends a user message; queues behind a running turn. Resolves true when it went out. */
  readonly send: (input: SendInput) => Promise<boolean>;
  readonly stop: (environmentId: EnvironmentId, threadId: ThreadId) => Promise<void>;
  /** Makes a thread with no worktree; resolves its id, or null when it failed. */
  readonly createTempThread: (input: TempThreadInput) => Promise<ThreadId | null>;
  readonly deleteThread: (environmentId: EnvironmentId, threadId: ThreadId) => Promise<void>;
}

export function useOneChatCommands(): OneChatCommands {
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const removeThread = useOrchestrationCommand(threadEnvironment.delete, { reportFailure: false });

  return {
    send: async (input) => {
      const result = await startTurn({
        environmentId: input.environmentId,
        input: {
          threadId: input.threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: input.text,
            attachments: input.attachments,
          },
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          dispatchMode: "queue",
        },
      });
      return result._tag === "Success";
    },
    stop: async (environmentId, threadId) => {
      await interruptTurn({ environmentId, input: { threadId } });
    },
    createTempThread: async (input) => {
      const threadId = newThreadId();
      const result = await createThread({
        environmentId: input.environmentId,
        input: {
          threadId,
          projectId: input.projectId,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          branch: null,
          worktreePath: null,
          createdAt: new Date().toISOString(),
        },
      });
      return result._tag === "Success" ? threadId : null;
    },
    deleteThread: async (environmentId, threadId) => {
      await removeThread({ environmentId, input: { threadId } });
    },
  };
}
