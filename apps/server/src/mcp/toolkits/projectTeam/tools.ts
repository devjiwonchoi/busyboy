import {
  OrchestratorMcpFailure,
  ProjectTeamAskUserInput,
  ProjectTeamAttentionAnswerInput,
  ProjectTeamAttentionDismissInput,
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
  ProjectTeamTaskSpecReadInput,
  ProjectTeamTaskSpecResult,
  ProjectTeamTaskSpecWriteInput,
  ProjectTeamTaskTodoSetInput,
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
    "PM only. Add a task to the project's inbox when the user asks for work. Write the request so a task lead can act on it alone. Set waitsOn for tasks touching the same files and parentTaskId when it is part of a bigger task; both may point at tasks in other projects. Then start it with task_start when a slot is free.",
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
    "Record progress on a task: stage, plan, result, PR URL or a note. The PM can also rename it and change its waitsOn and parent. A task lead updates only its own task and may omit taskId; the PM passes taskId.",
  parameters: ProjectTeamTaskUpdateInput,
  success: ProjectTeamTaskResult,
})
  .annotate(Tool.Title, "Update a team task")
  .annotate(Tool.Destructive, false);

const TaskSpecReadTool = Tool.make("task_spec_read", {
  ...shared,
  description:
    "Read a task's current spec (background, goal, non-goals, todos) and its version number. The user may have edited it since you last read it.",
  parameters: ProjectTeamTaskSpecReadInput,
  success: ProjectTeamTaskSpecResult,
})
  .annotate(Tool.Title, "Read a task spec")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const TaskSpecWriteTool = Tool.make("task_spec_write", {
  ...shared,
  description:
    "Replace a task's spec with a new version; every version is kept and the user can restore any of them. Write the plan here: goal, non-goals and todos. Pass the version you read as baseVersion.",
  parameters: ProjectTeamTaskSpecWriteInput,
  success: ProjectTeamTaskSpecResult,
})
  .annotate(Tool.Title, "Write a task spec")
  .annotate(Tool.Destructive, false);

const TaskTodoSetTool = Tool.make("task_todo_set", {
  ...shared,
  description:
    "Check or uncheck one todo in a task's spec as you finish it. The user watches these on the task page.",
  parameters: ProjectTeamTaskTodoSetInput,
  success: ProjectTeamTaskSpecResult,
})
  .annotate(Tool.Title, "Check a task todo")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

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
    "The team's state: tasks by stage, stalled tasks, open questions for the user, the project's other threads (ones the user started, with status and any waiting question), settings, and changes since a time. Call it first whenever you are woken. For a sitrep, pass the since time from the request.",
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
    "PM only. Change team settings only when the user asks: max concurrent tasks, sitrep interval, sitrep notifications, quiet hours, your name, avatar emoji, or voice (chill, dry, or chatty), and the task key prefix (such as BB for BB-7). A sitrep interval set here is never adjusted automatically.",
  parameters: ProjectTeamSettingsUpdateInput,
  success: ProjectTeamSettingsResult,
})
  .annotate(Tool.Title, "Update team settings")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const AskUserTool = Tool.make("ask_user", {
  ...shared,
  description:
    'Task lead only. The only way a task lead reaches the user: plan approval, a decision, or a blocker only a person can resolve. For approval, write the plan into the spec first and pass goal and verification, the two sections the card shows so the user can approve from it; the user reviews that spec version in a card and answers "Approve and start" or feedback with inline comments. Ask once with a self-contained question, then end your turn; the answer arrives as a message.',
  parameters: ProjectTeamAskUserInput,
  success: ProjectTeamAttentionItemResult,
})
  .annotate(Tool.Title, "Ask the user")
  .annotate(Tool.Destructive, false);

const AttentionAnswerTool = Tool.make("attention_answer", {
  ...shared,
  description:
    "PM only. Relay the user's answer to an open question to the task lead that asked it. Pass only what the user actually said, never your own answer or another agent's. Approval and decision cards need the user's own words: the answer must quote exactly what the user wrote in this chat after the card appeared, or the call fails; otherwise let the user click the card. Blocker answers are not checked.",
  parameters: ProjectTeamAttentionAnswerInput,
  success: ProjectTeamAttentionItemResult,
})
  .annotate(Tool.Title, "Answer a question for the user")
  .annotate(Tool.Destructive, false);

const AttentionDismissTool = Tool.make("attention_dismiss", {
  ...shared,
  description:
    "Close an open question that no longer needs an answer, with a short reason: the user decided it another way, or it no longer applies. It stops counting as waiting. The PM can close any question in its project, and the task lead that asked is told why. A task lead can close only its own questions.",
  parameters: ProjectTeamAttentionDismissInput,
  success: ProjectTeamAttentionItemResult,
})
  .annotate(Tool.Title, "Close a question")
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
    "Save or replace a whole core memory topic, such as when the user says to remember something. The PM and every future task lead see it in their prompt.",
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
  TaskSpecReadTool,
  TaskSpecWriteTool,
  TaskTodoSetTool,
  TaskNudgeTool,
  TaskListTool,
  TaskReadTool,
  TaskSearchTool,
  TeamStatusTool,
  TeamSettingsUpdateTool,
  AskUserTool,
  AttentionAnswerTool,
  AttentionDismissTool,
  MemoryListTool,
  MemoryWriteTool,
  MemoryDeleteTool,
);
