import type { ProjectContextRecord } from "@t3tools/contracts";
import { FolderIcon } from "lucide-react";

import { useProject } from "~/state/entities";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ProjectContextChip(props: {
  record: Pick<ProjectContextRecord, "environmentId" | "projectId" | "title" | "workspaceRoot">;
  copyMarkdown?: string;
}) {
  const { environmentId, projectId } = props.record;
  const project = useProject({ environmentId, projectId });
  const title = project?.title.trim() || props.record.title;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="project"
            aria-label={`Project, ${title}`}
            data-markdown-copy={props.copyMarkdown}
          >
            <FolderIcon />
            <ContextChipLabel>{title}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">
        {project ? project.workspaceRoot : "Project no longer available"}
      </TooltipPopup>
    </Tooltip>
  );
}
