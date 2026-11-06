import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { create } from "zustand";

export interface QuickTaskProjectRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

interface QuickTaskStore {
  /** Null while closed. `project` is the project to preselect, if the opener knows one. */
  readonly request: { readonly project: QuickTaskProjectRef | null } | null;
  /** The project the last task went to, preselected when nothing better is known. */
  readonly lastProject: QuickTaskProjectRef | null;
}

export const useQuickTaskStore = create<QuickTaskStore>(() => ({
  request: null,
  lastProject: null,
}));

/** Opens the quick "New task" modal from anywhere: Cmd+N, the sidebar, the phone add button. */
export function openQuickTask(project: QuickTaskProjectRef | null = null): void {
  useQuickTaskStore.setState({ request: { project } });
}

export function closeQuickTask(): void {
  useQuickTaskStore.setState({ request: null });
}

export function rememberQuickTaskProject(project: QuickTaskProjectRef): void {
  useQuickTaskStore.setState({ lastProject: project });
}
