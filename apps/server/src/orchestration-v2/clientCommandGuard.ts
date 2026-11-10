import type { OrchestrationV2Command } from "@t3tools/contracts";

/**
 * Why a client may not send this command, or null when it may. Only the task
 * mover changes where a thread runs; clients go through projectTeam.moveTask.
 */
export const clientCommandRefusal = (command: OrchestrationV2Command): string | null =>
  command.type === "thread.metadata.update" && command.location !== undefined
    ? "Move a task with projectTeam.moveTask, not thread.metadata.update."
    : null;
