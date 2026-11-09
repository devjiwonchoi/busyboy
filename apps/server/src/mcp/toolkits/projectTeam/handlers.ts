import { OrchestratorMcpFailure, type ProjectTeamError, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectTeamService from "../../../projectTeam/ProjectTeamService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { ProjectTeamToolkit } from "./tools.ts";

const toMcpFailure = (error: ProjectTeamError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/**
 * Runs `use` with the calling thread and the team service. The service checks
 * the caller's team role itself; `actsAsCaller`/`readsAsCaller` guarantee a
 * thread caller.
 */
const withTeam = <A>(
  use: (
    team: ProjectTeamService.ProjectTeamService["Service"],
    callerThreadId: ThreadId,
    scope: McpInvocationContext.McpInvocationScope,
  ) => Effect.Effect<A, ProjectTeamError>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const thread = yield* McpInvocationContext.requireThreadScope(scope, "This tool");
    const team = yield* ProjectTeamService.ProjectTeamService;
    return yield* use(team, thread.thread.threadId, scope).pipe(Effect.mapError(toMcpFailure));
  });

const handlers = {
  task_create: McpToolAccess.actsAsCaller((input) =>
    withTeam((team, caller) => team.createTask(caller, input)),
  ),
  task_start: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* withTeam((team, caller, scope) =>
        team.startTask(caller, input, (delegateInput) =>
          orchestrator.delegateTask(scope, delegateInput, {
            completionWake: "never",
            // A lead starts from the latest upstream, not the PM checkout's local HEAD.
            worktreeBase: "origin-default",
          }),
        ),
      );
    }),
  ),
  task_update: McpToolAccess.actsAsCaller((input) =>
    withTeam((team, caller) => team.updateTask(caller, input)),
  ),
  task_spec_read: McpToolAccess.readsAsCaller((input) =>
    withTeam((team, caller) => team.readSpec(caller, input)),
  ),
  task_spec_write: McpToolAccess.actsAsCaller((input) =>
    withTeam((team, caller) => team.writeSpec(caller, input)),
  ),
  task_todo_set: McpToolAccess.actsAsCaller((input) =>
    withTeam((team, caller) => team.setTodo(caller, input)),
  ),
  task_evidence_set: McpToolAccess.actsAsCaller((input) =>
    withTeam((team, caller) => team.setEvidence(caller, input)),
  ),
  task_review_set: McpToolAccess.actsAsCaller((input) =>
    withTeam((team, caller) => team.setReview(caller, input)),
  ),
  task_ready: McpToolAccess.actsAsCaller((input) =>
    withTeam((team, caller) => team.markTaskReady(caller, input)),
  ),
  task_delegate: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* withTeam((team, caller, scope) =>
        team.delegateStep(caller, input, (delegateInput, onChildCreated) =>
          orchestrator.delegateTask(
            scope,
            delegateInput,
            onChildCreated === undefined ? undefined : { onChildCreated },
          ),
        ),
      );
    }),
  ),
  task_nudge: McpToolAccess.actsAsCaller((input) =>
    withTeam((team, caller) => team.nudgeTask(caller, input)),
  ),
  task_list: McpToolAccess.readsAsCaller((input) =>
    withTeam((team, caller) => team.listTasks(caller, input)),
  ),
  task_read: McpToolAccess.readsAsCaller((input) =>
    withTeam((team, caller) => team.readTask(caller, input)),
  ),
  task_search: McpToolAccess.readsAsCaller((input) =>
    withTeam((team, caller) => team.searchTasks(caller, input)),
  ),
  team_status: McpToolAccess.readsAsCaller((input) =>
    withTeam((team, caller) => team.teamStatus(caller, input)),
  ),
  team_settings_update: McpToolAccess.actsAsCaller((input) =>
    withTeam((team, caller) => team.updateSettingsAsManager(caller, input)),
  ),
  ask_user: McpToolAccess.actsAsCaller((input) =>
    withTeam((team, caller) => team.askUser(caller, input)),
  ),
  attention_answer: McpToolAccess.actsAsCaller((input) =>
    withTeam((team, caller) => team.answerAttention(caller, input)),
  ),
  attention_dismiss: McpToolAccess.actsAsCaller((input) =>
    withTeam((team, caller) => team.dismissAttention(caller, input)),
  ),
  memory_list: McpToolAccess.readsAsCaller(() =>
    withTeam((team, caller) => team.listMemory(caller)),
  ),
  memory_write: McpToolAccess.actsAsCaller((input) =>
    withTeam((team, caller) => team.writeMemory(caller, input)),
  ),
  memory_delete: McpToolAccess.actsAsCaller((input) =>
    withTeam((team, caller) => team.deleteMemory(caller, input)),
  ),
  goal_write: McpToolAccess.actsAsCaller((input) =>
    withTeam((team, caller) => team.goalWrite(caller, input)),
  ),
  goal_link: McpToolAccess.actsAsCaller((input) =>
    withTeam((team, caller) => team.goalLink(caller, input)),
  ),
  pm_nudge: McpToolAccess.actsAsCaller((input) =>
    withTeam((team, caller) => team.pmNudge(caller, input)),
  ),
} satisfies McpToolAccess.Handlers<typeof ProjectTeamToolkit.tools>;

export const layer = McpToolAccess.toLayer(ProjectTeamToolkit, handlers);
