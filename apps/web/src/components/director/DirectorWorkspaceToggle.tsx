import { useNavigate } from "@tanstack/react-router";
import { LayoutGridIcon } from "lucide-react";

import { ALL_PROJECTS_PATH } from "../sidebar/mainAppLocation";

/** The Director chat header's way to All projects. */
export function DirectorWorkspaceToggle() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      aria-label="전체 프로젝트"
      onClick={() => void navigate({ to: ALL_PROJECTS_PATH })}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground text-xs hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <LayoutGridIcon aria-hidden className="size-3.5" />
      <span className="max-sm:sr-only">전체 프로젝트</span>
    </button>
  );
}
