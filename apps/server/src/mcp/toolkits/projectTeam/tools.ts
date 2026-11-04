import {
  OrchestratorMcpFailure,
  ProjectTeamAskUserInput,
  ProjectTeamAttentionAnswerInput,
  ProjectTeamAttentionItemResult,
  ProjectTeamMemoryDeleteInput,
  ProjectTeamMemoryDeleteResult,
  ProjectTeamMemoryListResult,
  ProjectTeamMemoryWriteInput,
  ProjectTeamMemoryWriteResult,
  ProjectTeamSettingsResult,
  ProjectTeamSettingsUpdateInput,
  ProjectTeamStatus,
  ProjectTeamStatusInput,
  ProjectTeamTaskCreateInput,
  ProjectTeamTaskListInput,
  ProjectTeamTaskListResult,
  ProjectTeamTaskNudgeInput,
  ProjectTeamTaskNudgeResult,
  ProjectTeamTaskReadInput,
  ProjectTeamTaskReadResult,
  ProjectTeamTaskResult,
  ProjectTeamTaskSearchInput,
  ProjectTeamTaskSearchResult,
  ProjectTeamTaskStartInput,
  ProjectTeamTaskStartResult,
  ProjectTeamTaskUpdateInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectTeamService from "../../../projectTeam/ProjectTeamService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectTeamService.ProjectTeamService,
  ],
};

const TaskCreateTool = Tool.make("task_create", {
  ...shared,
  description:
    "PM only. Add a task to the project's inbox when the user asks for work. Write the request so a task lead can act on it alone. Set waitsOn for tasks touching the same files. Then start it with task_start when a slot is free.",
  parameters: ProjectTeamTaskCreateInput,
  success: ProjectTeamTaskResult,
})
  .annotate(Tool.Title, "Create a team task")
  .annotate(Tool.Destructive, false);

const TaskStartTool = Tool.make("task_start", {
  ...shared,
  dependencies: [...shared.dependencies, OrchestratorMcpService.OrchestratorMcpService],
  description:
    "PM only. Start an inbox task: a task lead runs it in its own worktree as your async child, and each of its turn ends wakes you. Refused while maxConcurrentTasks leads run or a waitsOn task is unfinished; leave the task in the inbox then.",
  parameters: ProjectTeamTaskStartInput,
  success: ProjectTeamTaskStartResult,
})
  .annotate(Tool.Title, "Start a team task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const TaskUpdateTool = Tool.make("task_update", {
  ...shared,
  description:
    "Record progress on a task: stage, approved plan, result, PR URL or a note. A task lead updates only its own task and may omit taskId; the PM passes taskId.",
  parameters: ProjectTeamTaskUpdateInput,
  success: ProjectTeamTaskResult,
})
  .annotate(Tool.Title, "Update a team task")
  .annotate(Tool.Destructive, false);

const TaskNudgeTool = Tool.make("task_nudge", {
  ...shared,
  description:
    "PM only. Push a stalled task lead to its next step; the server adds a stage hint. After repeated nudges without progress it raises a blocker for the user instead (status escalated).",
  parameters: ProjectTeamTaskNudgeInput,
  success: ProjectTeamTaskNudgeResult,
})
  .annotate(Tool.Title, "Nudge a team task")
  .annotate(Tool.Destructive, false);

const TaskListTool = Tool.make("task_list", {
  ...shared,
  description: "List the project's tasks, optionally filtered by stage.",
  parameters: ProjectTeamTaskListInput,
  success: ProjectTeamTaskListResult,
})
  .annotate(Tool.Title, "List team tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const TaskReadTool = Tool.make("task_read", {
  ...shared,
  description: "Read one task with its recent log and open questions for the user.",
  parameters: ProjectTeamTaskReadInput,
  success: ProjectTeamTaskReadResult,
})
  .annotate(Tool.Title, "Read a team task")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const TaskSearchTool = Tool.make("task_search", {
  ...shared,
  description:
    "Search past and current tasks by title, request, plan and result. Use it to recall earlier work or decisions.",
  parameters: ProjectTeamTaskSearchInput,
  success: ProjectTeamTaskSearchResult,
})
  .annotate(Tool.Title, "Search team tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const TeamStatusTool = Tool.make("team_status", {
  ...shared,
  description:
    "The team's state: tasks by stage, stalled tasks, open questions for the user, settings, and changes since a time. Call it first whenever you are woken. Pass reason 'user_asked' when the user asks about progress. For a sitrep, pass the since time from the request.",
  parameters: ProjectTeamStatusInput,
  success: ProjectTeamStatus,
})
  .annotate(Tool.Title, "Get team status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const TeamSettingsUpdateTool = Tool.make("team_settings_update", {
  ...shared,
  description:
    "PM only. Change team settings only when the user asks: max concurrent tasks, sitrep interval, sitrep notifications, quiet hours. Values set here stop automatic adjustment for 24 hours.",
  parameters: ProjectTeamSettingsUpdateInput,
  success: ProjectTeamSettingsResult,
})
  .annotate(Tool.Title, "Update team settings")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const AskUserTool = Tool.make("ask_user", {
  ...shared,
  description:
    "Task lead only. The only way a task lead reaches the user: a decision, plan approval, or blocker only a person can resolve. Ask once with a self-contained question, then end your turn; the answer arrives as a message.",
  parameters: ProjectTeamAskUserInput,
  success: ProjectTeamAttentionItemResult,
})
  .annotate(Tool.Title, "Ask the user")
  .annotate(Tool.Destructive, false);

const AttentionAnswerTool = Tool.make("attention_answer", {
  ...shared,
  description:
    "PM only. Relay the user's answer to an open question to the task lead that asked it. Pass only what the user actually said, never your own answer or another agent's.",
  parameters: ProjectTeamAttentionAnswerInput,
  success: ProjectTeamAttentionItemResult,
})
  .annotate(Tool.Title, "Answer a question for the user")
  .annotate(Tool.Destructive, false);

const MemoryListTool = Tool.make("memory_list", {
  ...shared,
  description: "List the project's core memory. Every task lead already sees it in its prompt.",
  success: ProjectTeamMemoryListResult,
})
  .annotate(Tool.Title, "List team memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const MemoryWriteTool = Tool.make("memory_write", {
  ...shared,
  description:
    "Save or replace a core memory topic, such as when the user says to remember something. Every future task lead sees it.",
  parameters: ProjectTeamMemoryWriteInput,
  success: ProjectTeamMemoryWriteResult,
})
  .annotate(Tool.Title, "Write team memory")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const MemoryDeleteTool = Tool.make("memory_delete", {
  ...shared,
  description: "PM only. Delete a core memory topic when the user says to forget it.",
  parameters: ProjectTeamMemoryDeleteInput,
  success: ProjectTeamMemoryDeleteResult,
})
  .annotate(Tool.Title, "Delete team memory")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const ProjectTeamToolkit = Toolkit.make(
  TaskCreateTool,
  TaskStartTool,
  TaskUpdateTool,
  TaskNudgeTool,
  TaskListTool,
  TaskReadTool,
  TaskSearchTool,
  TeamStatusTool,
  TeamSettingsUpdateTool,
  AskUserTool,
  AttentionAnswerTool,
  MemoryListTool,
  MemoryWriteTool,
  MemoryDeleteTool,
);
