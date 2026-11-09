import { useEnvironmentIds } from "~/state/environments";
import { useProjectManagerEntries } from "~/state/projectTeam";
import { ScrollArea } from "../ui/scroll-area";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { GoalGraph } from "../goalGraph/GoalGraph";

/**
 * Every project at a glance: workspace goals, their progress, and which
 * projects and tasks serve them. What waits on the user lives in the Director
 * chat, not here.
 */
export function DirectorWorkspaceSurface() {
  const entries = useProjectManagerEntries(useEnvironmentIds());
  return (
    <div
      data-testid="director-workspace-surface"
      className="@container flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide" className="gap-4 px-3 py-3 sm:px-6">
            <GoalGraph entries={entries} panel />
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </div>
  );
}
