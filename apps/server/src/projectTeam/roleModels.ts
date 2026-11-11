import {
  effectiveRoleModel,
  type OrchestratorMcpTarget,
  type OrchestratorMcpTaskRole,
  PROJECT_TASK_MODEL_ROLES,
  type ProjectTaskDelegatedRole,
  type ProjectTaskModelRole,
  type ProjectTaskModelSource,
  type ProjectTaskModelTarget,
  type ProjectTaskRoleModels,
  type ProjectTaskStepModels,
  isProviderAvailable,
  type ServerProvider,
} from "@t3tools/contracts";

/** The model each role runs on for a task, or null when it runs on the lead's own model. */
export type ResolvedRoleModels = Readonly<
  Record<
    ProjectTaskModelRole,
    { readonly target: ProjectTaskModelTarget; readonly source: ProjectTaskModelSource } | null
  >
>;

/** Each role's model: the task's, else the project's, else the app's step model. */
export function resolveRoleModels(
  task: ProjectTaskRoleModels,
  project: ProjectTaskRoleModels | undefined,
  app: ProjectTaskStepModels | undefined,
): ResolvedRoleModels {
  return {
    plan: effectiveRoleModel("plan", task, project, app),
    implement: effectiveRoleModel("implement", task, project, app),
    review: effectiveRoleModel("review", task, project, app),
    fix: effectiveRoleModel("fix", task, project, app),
  };
}

/**
 * Drops an app step whose provider or model this server cannot run, so the role falls back
 * to the lead's model as before. An empty registry is unknown (still probing), not missing.
 * Models set on the task or project are the user's explicit choice and stay as they are.
 */
export function withoutUnavailableAppSteps(
  resolved: ResolvedRoleModels,
  providers: ReadonlyArray<ServerProvider>,
): ResolvedRoleModels {
  if (providers.length === 0) return resolved;
  const usable = (target: ProjectTaskModelTarget) => {
    const provider = providers.find(
      (candidate) => candidate.instanceId === target.providerInstanceId,
    );
    return (
      provider !== undefined &&
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      (provider.models.length === 0 ||
        provider.models.some((model) => model.slug === target.model))
    );
  };
  const keep = (entry: ResolvedRoleModels[ProjectTaskModelRole]) =>
    entry === null || entry.source !== "app" || usable(entry.target) ? entry : null;
  return {
    plan: keep(resolved.plan),
    implement: keep(resolved.implement),
    review: keep(resolved.review),
    fix: keep(resolved.fix),
  };
}

/** The session target, with the thinking level and other options the step saved. */
export function toDelegateTarget(target: ProjectTaskModelTarget): OrchestratorMcpTarget {
  return {
    providerInstanceId: target.providerInstanceId,
    model: target.model,
    ...(target.options === undefined || target.options.length === 0
      ? {}
      : { options: target.options }),
  };
}

const SOURCE_LABEL: Readonly<Record<ProjectTaskModelSource, string>> = {
  task: "set on this task",
  project: "project default",
  app: "app default",
};

/** "high" from a target's thinking-level option, if it has one. */
function thinkingLevel(target: ProjectTaskModelTarget): string | null {
  const option = target.options?.find(
    (candidate) => candidate.id === "effort" || candidate.id === "reasoningEffort",
  );
  return typeof option?.value === "string" ? option.value : null;
}

/** The delegate_task role that matches a task role. */
export const DELEGATE_ROLE: Readonly<Record<ProjectTaskDelegatedRole, OrchestratorMcpTaskRole>> = {
  implement: "implementation",
  review: "review",
  fix: "implementation",
};

/** Log body of a model step, such as "implement → codex · gpt-5.5". */
export function modelStepEventBody(
  role: ProjectTaskModelRole,
  providerInstanceId: string,
  model: string | null,
): string {
  return `${role} → ${providerInstanceId} · ${model ?? "default model"}`;
}

const ROLE_WORK: Readonly<Record<ProjectTaskModelRole, string>> = {
  plan: "Plan",
  implement: "Implement",
  review: "Review",
  fix: "Fix",
};

/** The lead prompt section that says which model runs each role. */
export function roleModelsPromptSection(resolved: ResolvedRoleModels): string {
  const describe = (role: ProjectTaskModelRole) => {
    const entry = resolved[role];
    if (entry === null) return null;
    const level = thinkingLevel(entry.target);
    return `${entry.target.providerInstanceId} · ${entry.target.model}${level === null ? "" : ` · ${level}`} (${SOURCE_LABEL[entry.source]})`;
  };
  const lines = PROJECT_TASK_MODEL_ROLES.map((role) => {
    const model = describe(role);
    if (role === "plan") {
      return model === null
        ? `- ${ROLE_WORK.plan}: you, on your own model.`
        : `- ${ROLE_WORK.plan}: you, started on ${model}.`;
    }
    return model === null
      ? `- ${ROLE_WORK[role]}: no model set. Do it yourself, or fan out with delegate_task as usual.`
      : `- ${ROLE_WORK[role]}: ${model}. Hand it off with task_delegate(role: "${role}").`;
  });
  const anyDelegated = PROJECT_TASK_MODEL_ROLES.some(
    (role) => role !== "plan" && resolved[role] !== null,
  );
  const how = anyDelegated
    ? `\ntask_delegate starts a child on the role's model and records which model ran the step, so the user sees it on the task. Write each brief so the child can act alone:
- implement: the todos to build, the relevant spec parts (goal, criteria, files), and how to verify.
- review: the base branch and HEAD sha to diff, the spec's goal and criteria, and the changed files (\`git diff --stat <base>...HEAD\`). Tell it to read the diff and those files rather than explore the whole repository, list findings one per line, and record the result itself with task_review_set(clean, findings, head). Its clean review is the one that lets the task ship; yours does not count while a review model is set.
- fix: the review findings to fix, the spec's criteria, and to commit when done.
Merge each child's result, then go on. A role's model can change while you work; task_delegate always uses the current one.`
    : "";
  return `${lines.join("\n")}${how}`;
}
