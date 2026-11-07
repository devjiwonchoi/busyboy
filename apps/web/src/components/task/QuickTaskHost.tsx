import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { resolveShortcutCommand } from "~/keybindings";
import { isEditableFocused } from "~/lib/editableFocus";
import { isPreviewFocused } from "~/lib/previewFocus";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { isModelPickerOpen } from "~/modelPickerVisibility";
import { useProjects, useQuietThreadShell } from "~/state/entities";
import { useEnvironmentIds } from "~/state/environments";
import { useProjectOnlyManagerEntries } from "~/state/director";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { resolveThreadRouteTarget } from "~/threadRoutes";
import { taskRouteParams } from "~/taskRoutes";
import { toastManager } from "../ui/toast";
import { QuickTaskModal, type QuickTaskProject } from "./QuickTaskModal";
import { quickTaskProjectKey } from "./quickTask.logic";
import {
  closeQuickTask,
  openQuickTask,
  rememberQuickTaskProject,
  useQuickTaskStore,
  type QuickTaskProjectRef,
} from "./quickTaskStore";

/**
 * Mounted once for the whole app. Opens the quick "New task" modal on the
 * `task.new` shortcut (Cmd+N by default) or `openQuickTask()`, and preselects
 * the project the user is looking at.
 */
export function QuickTaskHost() {
  const router = useRouter();
  const request = useQuickTaskStore((state) => state.request);
  const lastProject = useQuickTaskStore((state) => state.lastProject);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // The Director routes work itself; tasks are planned in a project.
  const managers = useProjectOnlyManagerEntries(useEnvironmentIds());
  const allProjects = useProjects();

  const params = useParams({ strict: false }) as Record<string, string | undefined>;
  const routeTarget = resolveThreadRouteTarget(params);
  const routeThread = useQuietThreadShell(
    routeTarget?.kind === "server" ? routeTarget.threadRef : null,
  );
  const routeProject: QuickTaskProjectRef | null =
    params.environmentId && params.projectId
      ? {
          environmentId: EnvironmentId.make(params.environmentId),
          projectId: ProjectId.make(params.projectId),
        }
      : routeThread?.projectId
        ? { environmentId: routeThread.environmentId, projectId: routeThread.projectId }
        : null;

  // Only projects with a PM can plan a task.
  const projects: QuickTaskProject[] = managers.map(({ environmentId, summary }) => ({
    environmentId,
    projectId: summary.projectId,
    name:
      allProjects.find(
        (project) => project.environmentId === environmentId && project.id === summary.projectId,
      )?.title ?? summary.projectId,
  }));
  const hasProject = (ref: QuickTaskProjectRef | null) =>
    ref !== null && projects.some((p) => quickTaskProjectKey(p) === quickTaskProjectKey(ref));
  const preferred = [request?.project ?? null, routeProject, lastProject].find(hasProject) ?? null;

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || isCommandPaletteOpen()) return;
    const command = resolveShortcutCommand(event, keybindings, {
      context: {
        terminalFocus: isTerminalFocused(),
        previewFocus: isPreviewFocused(),
        editableFocus: isEditableFocused(event.target),
        modelPickerOpen: isModelPickerOpen(),
      },
    });
    if (command !== "task.new") return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) openQuickTask();
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  return (
    <QuickTaskModal
      open={request !== null}
      projects={projects}
      initialProjectKey={preferred === null ? null : quickTaskProjectKey(preferred)}
      onClose={closeQuickTask}
      onCreated={(detail, project, { keepOpen, startPlanning }) => {
        rememberQuickTaskProject(project);
        if (!keepOpen) closeQuickTask();
        const route = taskRouteParams(project.environmentId, project.projectId, detail.task.id);
        toastManager.add({
          type: "success",
          title: `${detail.key} created`,
          description: `${detail.task.title} · ${startPlanning ? "planning started" : "saved as Todo"} in ${project.name}`,
          actionProps: {
            children: "Open",
            onClick: () => void router.navigate(route),
          },
        });
      }}
    />
  );
}
